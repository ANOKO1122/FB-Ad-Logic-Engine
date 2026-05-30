/**
 * 动作执行服务（M4 阶段核心模块）
 * 
 * 职责：
 * 1. 执行规则触发的动作（暂停广告、调整预算等）
 * 2. 支持 Dry Run 模式（仅记录日志，不执行真实操作）
 * 3. 写入审计日志到 automation_logs 表
 * 
 * 设计原则：
 * - 动作执行与审计日志写入解耦
 * - 所有 Facebook API 调用都有超时保护和错误处理
 * - 审计日志必须记录，即使动作执行失败
 */

import logger from '../utils/logger.js'
import { db } from '../db/drizzle.js'
import { automationLogs } from '../db/schema.js'
import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'
import { isCooldownDue } from './ruleExecutionStateService.js'
import { buildAutomationLogExplanation } from '../utils/automationLogExplanation.js'
import {
  logAuditInsertFailure,
  logAuditInsertSuccess,
  logFbActionFailure,
  logFbActionSuccess
} from '../utils/auditLogTelemetry.js'

// ============================================
// M1 合同层：动作语义解析（执行意图解释器）
// 约定：持久化层继续保存旧枚举 pause_ad/activate_ad；
//       执行前根据 targetLevel 解析出真实目标层级与操作。
// ============================================

/**
 * M1 内部解释层：根据规则 targetLevel 解析状态动作的真实执行意图
 *
 * 合同：
 * - rules.actions[*].type 持久化值不变（pause_ad / activate_ad）
 * - 执行语义由 targetLevel 决定：
 *   - targetLevel=ad       → 作用于 ad（pauseAd / activateAd）
 *   - targetLevel=adset    → 作用于 adset（pauseAdset / activateAdset）
 *   - targetLevel=campaign → 作用于 campaign（pauseCampaign / activateCampaign）
 *
 * @param {Object} rule - 规则对象（含 targetLevel, target_level）
 * @param {Object} action - 动作对象（含 type）
 * @param {Object} matchedObject - 匹配的目标对象（含 ad_id, adset_id, campaign_id, 及各层名称）
 * @returns {{ resolvedStatusTargetLevel: string, resolvedStatusOp: string, resolvedObjectId: string, resolvedObjectName: string | null }}
 */
export function resolveStatusActionIntent(rule, action, matchedObject) {
  const actionType = action?.type || ''
  const targetLevel = (rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()

  // 仅状态动作需要解释；预算动作保持原有 ABO/CBO 路由
  if (!['pause_ad', 'activate_ad'].includes(actionType)) {
    return {
      resolvedStatusTargetLevel: targetLevel,
      resolvedStatusOp: actionType,
      resolvedObjectId: matchedObject?.ad_id || '',
      resolvedObjectName: matchedObject?.ad_name || null
    }
  }

  const op = actionType === 'pause_ad' ? 'pause' : 'activate'

  switch (targetLevel) {
    case 'adset': {
      const adsetId = matchedObject?.adset_id || matchedObject?.ad_set_id || ''
      const adsetName = matchedObject?.adset_name || null
      return {
        resolvedStatusTargetLevel: 'adset',
        resolvedStatusOp: op,
        resolvedObjectId: adsetId,
        resolvedObjectName: adsetName
      }
    }
    case 'campaign': {
      const campaignId = matchedObject?.campaign_id || ''
      const campaignName = matchedObject?.campaign_name || null
      return {
        resolvedStatusTargetLevel: 'campaign',
        resolvedStatusOp: op,
        resolvedObjectId: campaignId,
        resolvedObjectName: campaignName
      }
    }
    case 'ad':
    default: {
      const adId = matchedObject?.ad_id || ''
      const adName = matchedObject?.ad_name || null
      return {
        resolvedStatusTargetLevel: 'ad',
        resolvedStatusOp: op,
        resolvedObjectId: adId,
        resolvedObjectName: adName
      }
    }
  }
}

function getMatchedObjectScopeKey(rule, matchedObject) {
  const level = String(rule?.targetLevel || rule?.target_level || matchedObject?.objectType || 'ad').toLowerCase()
  if (level === 'adset') {
    const adsetId = String(matchedObject?.objectId || matchedObject?.ad_set_id || matchedObject?.adset_id || '').trim()
    return adsetId ? `status_adset:${adsetId}` : null
  }
  if (level === 'campaign') {
    const campaignId = String(matchedObject?.objectId || matchedObject?.campaign_id || '').trim()
    return campaignId ? `status_campaign:${campaignId}` : null
  }
  const adId = String(matchedObject?.objectId || matchedObject?.ad_id || '').trim()
  return adId ? `status_ad:${adId}` : null
}

// Facebook API Token（从环境变量读取）
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN

// M4 预算护栏：最低预算 100 美分 = 1 美元（与 FB 要求一致）
const MIN_BUDGET_CENTS = 100

/** value_unit 合法值：percent=百分比，usd=固定美元 */
const VALID_VALUE_UNITS = ['percent', 'usd']
const PREFLIGHT_STALE_MS = 30 * 60 * 1000

function buildAuditDedupeKey({ runId, ruleId, objectType, objectId, actionType }) {
  return [
    String(runId || ''),
    String(ruleId || ''),
    String(objectType || '').toLowerCase(),
    String(objectId || ''),
    String(actionType || '').toUpperCase()
  ].join(':')
}

function resolveObjectDedupKey(matchedAd, targetLevel) {
  if (!matchedAd || !targetLevel) return ''
  if (targetLevel === 'adset') {
    const adsetId = String(matchedAd.objectId || matchedAd.ad_set_id || matchedAd.adset_id || '').trim()
    return adsetId ? `adset:${adsetId}` : ''
  }
  if (targetLevel === 'campaign') {
    const campaignId = String(matchedAd.objectId || matchedAd.campaign_id || '').trim()
    return campaignId ? `campaign:${campaignId}` : ''
  }
  const adId = String(matchedAd.objectId || matchedAd.ad_id || '').trim()
  return adId ? `ad:${adId}` : ''
}

async function loadPreflightStatusByLevel({ accountId, targetLevel, targetObjectId, fallbackStatus = null }) {
  if (targetLevel === 'ad' && fallbackStatus) {
    return { preflightMode: 'preflight', status: fallbackStatus }
  }
  try {
    const [heartbeatRows] = await pool.execute(
      `SELECT last_heartbeat_data_update_at
       FROM structure_sync_status
       WHERE account_id = ?
       LIMIT 1`,
      [accountId]
    )
    const heartbeatAt = heartbeatRows?.[0]?.last_heartbeat_data_update_at
    if (!heartbeatAt || (Date.now() - new Date(heartbeatAt).getTime()) > PREFLIGHT_STALE_MS) {
      if (targetLevel === 'ad' && fallbackStatus) {
        return { preflightMode: 'preflight', status: fallbackStatus }
      }
      return { preflightMode: 'direct_api_fallback', status: fallbackStatus }
    }

    if (targetLevel === 'adset') {
      const [rows] = await pool.execute(
        `SELECT effective_status AS status
         FROM structure_adsets
         WHERE account_id = ? AND adset_id = ?
         LIMIT 1`,
        [accountId, targetObjectId]
      )
      const status = rows?.[0]?.status || null
      return status ? { preflightMode: 'preflight', status } : { preflightMode: 'direct_api_fallback', status: fallbackStatus }
    }

    if (targetLevel === 'campaign') {
      const [rows] = await pool.execute(
        `SELECT effective_status AS status
         FROM structure_campaigns
         WHERE account_id = ? AND campaign_id = ?
         LIMIT 1`,
        [accountId, targetObjectId]
      )
      const status = rows?.[0]?.status || null
      return status ? { preflightMode: 'preflight', status } : { preflightMode: 'direct_api_fallback', status: fallbackStatus }
    }

    const [rows] = await pool.execute(
      `SELECT status
       FROM ad_snapshots
       WHERE account_id = ? AND ad_id = ?
       ORDER BY synced_at DESC, id DESC
       LIMIT 1`,
      [accountId, targetObjectId]
    )
    const status = rows?.[0]?.status || null
    return status ? { preflightMode: 'preflight', status } : { preflightMode: 'direct_api_fallback', status: fallbackStatus }
  } catch (err) {
    logger.warn(`    ⚠️  Pre-Flight 状态源查询失败，降级直连 API: ${err.message}`)
    return { preflightMode: 'direct_api_fallback', status: fallbackStatus }
  }
}

/**
 * 预算 Pre-Flight 跳过原因细分：
 * - increase 且 current > max: above_max_cap
 * - decrease 且 current <= min: below_min_floor
 * - 其它 current===new: budget_already_at_target
 */
function inferBudgetSkipReason(action, currentCents, newBudgetCents) {
  if (action?.type === 'increase_budget' && action?.max_daily_budget != null) {
    const cap = Math.max(Math.round(Number(action.max_daily_budget)), MIN_BUDGET_CENTS)
    if (currentCents > cap && currentCents === newBudgetCents) {
      return 'above_max_cap'
    }
  }
  if (action?.type === 'decrease_budget' && action?.min_daily_budget != null) {
    const floor = Math.max(Math.round(Number(action.min_daily_budget)), MIN_BUDGET_CENTS)
    if (currentCents <= floor && currentCents === newBudgetCents) {
      return 'below_min_floor'
    }
  }
  return 'budget_already_at_target'
}

/**
 * 【教学】M4 步骤 2：预算幂等——纯函数「只算一次」
 *
 * 支持三种预算动作：
 * - set_budget：直接设置为固定美元值，不依赖当前预算；value_unit 强制 usd
 * - increase_budget / decrease_budget：percent 或 usd 增减
 *
 * @param {number} currentBudgetCents - 当前预算（美分，整数）；set_budget 时忽略
 * @param {Object} action - { type, value?, value_unit?: 'percent'|'usd', max_daily_budget? }
 * @returns {number} 新预算（美分，整数）
 */
export function computeNewBudgetCentsOnce(currentBudgetCents, action) {
  const cents = Math.round(Number(currentBudgetCents) || 0)

  // set_budget：直接设置为固定美元值，无需 GET 当前预算
  if (action?.type === 'set_budget') {
    const v = Number(action?.value)
    if (!Number.isFinite(v) || v <= 0) return MIN_BUDGET_CENTS
    let targetCents = Math.round(v * 100)
    targetCents = Math.max(targetCents, MIN_BUDGET_CENTS)
    if (action?.max_daily_budget != null) {
      const cap = Math.round(Number(action.max_daily_budget))
      const capEffective = Math.max(cap, MIN_BUDGET_CENTS)
      targetCents = Math.min(targetCents, capEffective)
    }
    // set_budget 新语义：仅上调，不下调
    if (cents > 0 && cents >= targetCents) {
      return cents
    }
    return targetCents
  }

  const unit = VALID_VALUE_UNITS.includes(action?.value_unit) ? action.value_unit : 'percent'
  const isIncrease = action?.type === 'increase_budget'
  const isDecrease = action?.type === 'decrease_budget'

  if (isIncrease && action?.max_daily_budget != null) {
    const cap = Math.round(Number(action.max_daily_budget))
    const capEffective = Math.max(cap, MIN_BUDGET_CENTS)
    // increase 新语义：若当前预算已高于上限，保持不动
    if (cents > capEffective) {
      return cents
    }
  }
  if (isDecrease && action?.min_daily_budget != null) {
    const floor = Math.round(Number(action.min_daily_budget))
    const floorEffective = Math.max(floor, MIN_BUDGET_CENTS)
    // decrease 新语义：若当前预算在下限或以下，保持不动
    if (cents <= floorEffective) {
      return cents
    }
  }

  let newCents
  if (unit === 'usd') {
    const v = Number(action?.value)
    if (!Number.isFinite(v) || v <= 0) {
      return Math.max(cents, MIN_BUDGET_CENTS)
    }
    const delta = Math.round(v * 100)
    newCents = isIncrease ? cents + delta : Math.max(cents - delta, MIN_BUDGET_CENTS)
  } else {
    const adjustPercent = Math.max(0, Number(action?.value) || 10)
    newCents = isIncrease
      ? Math.round(cents * (1 + adjustPercent / 100))
      : Math.round(cents * (1 - adjustPercent / 100))
    newCents = Math.max(newCents, MIN_BUDGET_CENTS)
  }

  if (isIncrease && action?.max_daily_budget != null) {
    const cap = Math.round(Number(action.max_daily_budget))
    const capEffective = Math.max(cap, MIN_BUDGET_CENTS)
    newCents = Math.min(newCents, capEffective)
  }
  if (isDecrease && action?.min_daily_budget != null) {
    const floor = Math.round(Number(action.min_daily_budget))
    const floorEffective = Math.max(floor, MIN_BUDGET_CENTS)
    newCents = Math.max(newCents, floorEffective)
  }
  return newCents
}

export function computeDynamicBudgetCents(matchedObject, action) {
  const metric = String(action?.metric || '').trim()
  const metricRawValue = matchedObject?.[metric]
  if (!metric || metricRawValue == null) {
    return { ok: false, reason: 'dynamic_metric_missing', metric, metricValue: null }
  }

  const metricValue = Number(metricRawValue)
  if (!Number.isFinite(metricValue) || metricValue <= 0) {
    return { ok: false, reason: 'dynamic_metric_invalid', metric, metricValue: Number.isFinite(metricValue) ? metricValue : null }
  }

  const multiplier = Number(action?.multiplier)
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return { ok: false, reason: 'dynamic_multiplier_invalid', metric, metricValue, multiplier: null }
  }

  const rawUsd = metricValue * multiplier
  const roundedUsd = Math.round(rawUsd * 100) / 100
  const targetCentsBeforeClamp = Math.round(roundedUsd * 100)
  const minDailyBudget = action?.min_daily_budget != null ? Math.max(Math.round(Number(action.min_daily_budget)), MIN_BUDGET_CENTS) : null
  const maxDailyBudget = action?.max_daily_budget != null ? Math.max(Math.round(Number(action.max_daily_budget)), MIN_BUDGET_CENTS) : null
  let finalBudgetCents = Math.max(targetCentsBeforeClamp, MIN_BUDGET_CENTS)

  if (minDailyBudget != null) finalBudgetCents = Math.max(finalBudgetCents, minDailyBudget)
  if (maxDailyBudget != null) finalBudgetCents = Math.min(finalBudgetCents, maxDailyBudget)

  return {
    ok: true,
    metric,
    metricValue,
    multiplier,
    rawUsd,
    roundedUsd,
    targetCentsBeforeClamp,
    minDailyBudget,
    maxDailyBudget,
    finalBudgetCents
  }
}

function resolveBudgetCents(detail) {
  const daily = Math.round(Number(detail?.daily_budget || 0))
  const lifetime = Math.round(Number(detail?.lifetime_budget || 0))
  if (daily > 0) return { hasBudget: true, currentCents: daily, isDaily: true }
  if (lifetime > 0) return { hasBudget: true, currentCents: lifetime, isDaily: false }
  return { hasBudget: false, currentCents: 0, isDaily: true }
}

function getUniqueChildAdsetIds(matchedObject) {
  const ids = []
  const add = (value) => {
    const id = String(value || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  add(matchedObject?.ad_set_id || matchedObject?.adset_id)
  const children = Array.isArray(matchedObject?.aggregationTrace?.children)
    ? matchedObject.aggregationTrace.children
    : []
  for (const child of children) {
    add(child?.adsetId || child?.ad_set_id || child?.adset_id)
  }
  return ids
}

export async function resolveBudgetTargetContext(rule, matchedObject, api) {
  const targetLevel = String(rule?.targetLevel || rule?.target_level || matchedObject?.objectType || 'ad').toLowerCase()
  const objectId = String(matchedObject?.objectId || '').trim()

  if (targetLevel === 'campaign') {
    const campaignId = String(objectId || matchedObject?.campaign_id || '').trim()
    if (!campaignId) return { ok: false, reason: 'missing_campaign_id' }
    const campaignDetail = await api.getCampaignBudgetDetail(campaignId)
    const campaignBudget = resolveBudgetCents(campaignDetail)
    if (campaignBudget.hasBudget) {
      return {
        ok: true,
        budgetNodeType: 'campaign',
        budgetNodeId: campaignId,
        label: '广告系列(CBO)',
        isDaily: campaignBudget.isDaily,
        currentCents: campaignBudget.currentCents,
        cooldownKey: `budget_campaign:${campaignId}`
      }
    }
    const childAdsetIds = getUniqueChildAdsetIds(matchedObject)
    if (childAdsetIds.length === 1) {
      const adsetId = childAdsetIds[0]
      const adsetDetail = await api.getAdsetBudgetDetail(adsetId)
      const adsetBudget = resolveBudgetCents(adsetDetail)
      if (adsetBudget.hasBudget) {
        return {
          ok: true,
          budgetNodeType: 'adset',
          budgetNodeId: adsetId,
          label: '广告组(ABO)',
          isDaily: adsetBudget.isDaily,
          currentCents: adsetBudget.currentCents,
          cooldownKey: `budget_adset:${adsetId}`
        }
      }
    }
    if (childAdsetIds.length > 1) {
      return {
        ok: false,
        severity: 'skipped',
        reason: 'campaign_abo_multiple_adsets_requires_adset_level',
        campaignId,
        childAdsetIds,
        cooldownKey: `budget_campaign:${campaignId}`
      }
    }
    return {
      ok: false,
      severity: 'skipped',
      reason: 'campaign_has_no_budget',
      campaignId,
      cooldownKey: `budget_campaign:${campaignId}`
    }
  }

  const adsetId = String(
    targetLevel === 'adset'
      ? (objectId || matchedObject?.ad_set_id || matchedObject?.adset_id || '')
      : (matchedObject?.ad_set_id || matchedObject?.adset_id || '')
  ).trim()
  if (!adsetId) return { ok: false, reason: 'missing_adset_id' }

  const adsetDetail = await api.getAdsetBudgetDetail(adsetId)
  const adsetBudget = resolveBudgetCents(adsetDetail)
  if (adsetBudget.hasBudget) {
    return {
      ok: true,
      budgetNodeType: 'adset',
      budgetNodeId: adsetId,
      label: '广告组',
      isDaily: adsetBudget.isDaily,
      currentCents: adsetBudget.currentCents,
      cooldownKey: `budget_adset:${adsetId}`
    }
  }

  const campaignId = String(matchedObject?.campaign_id || '').trim()
  if (!campaignId) return { ok: false, reason: 'missing_campaign_id' }
  const campaignDetail = await api.getCampaignBudgetDetail(campaignId)
  const campaignBudget = resolveBudgetCents(campaignDetail)
  if (!campaignBudget.hasBudget) {
    return {
      ok: false,
      severity: 'skipped',
      reason: 'budget_node_has_no_budget',
      campaignId,
      adsetId,
      cooldownKey: `budget_campaign:${campaignId}`
    }
  }
  return {
    ok: true,
    budgetNodeType: 'campaign',
    budgetNodeId: campaignId,
    label: '广告系列(CBO)',
    isDaily: campaignBudget.isDaily,
    currentCents: campaignBudget.currentCents,
    cooldownKey: `budget_campaign:${campaignId}`
  }
}

/**
 * M4 3.2 预算幂等：由调用方「只 GET 一次 + 算一次」，得到 newBudgetCents 后传 action 副本 _resolvedBudgetCents，重试时不再 GET。
 * set_budget 不依赖当前预算，直接计算返回，无需 GET。
 * @param {Object} api - FacebookMarketingAPI 实例（需有 getAdsetBudget）
 * @param {string} adsetId - 广告组 ID
 * @param {Object} action - { type, value?, value_unit?, max_daily_budget? }
 * @returns {Promise<number>} 新预算（分）
 */
export async function resolveNewBudgetCentsForAction(api, adsetId, action) {
  if (!api || !adsetId) return 0
  if (action?.type === 'set_budget') {
    return computeNewBudgetCentsOnce(0, action)
  }
  const current = await api.getAdsetBudget(adsetId)
  return computeNewBudgetCentsOnce(current, action)
}

/**
 * 优化一 Phase3：预算 PendingAction 去重合并（按 scope+nodeId 维度聚合，同一节点单轮只保留最后一条）
 * - 目前为纯函数，不改执行路径；后续由调度层按账户调用并写 budget_merge 日志。
 *
 * @param {Array} pendingActions - executeActionsForAd 收集的 pendingActions（可能包含 status 和 budget）
 * @returns {{ merged: Array, budgetMergeLogs: Array }}
 */
export function mergeBudgetPendingActions(pendingActions) {
  if (!Array.isArray(pendingActions) || pendingActions.length === 0) {
    return { merged: [], budgetMergeLogs: [] }
  }

  const merged = []
  const budgetByKey = new Map()
  const budgetOrder = []

  // 1. 先保留所有 status 类 PendingAction，预算类进入 Map 聚合
  for (const pa of pendingActions) {
    if (!pa || !pa.kind) continue
    if (pa.kind === 'budget') {
      const scope = pa.scope || 'adset'
      const nodeId = String(pa.nodeId || '')
      const accountId = String(pa.accountId || '')
      if (!nodeId || !accountId) continue
      const key = `${accountId}:${scope}:${nodeId}`
      budgetByKey.set(key, pa)
      if (!budgetOrder.includes(key)) {
        budgetOrder.push(key)
      }
    } else {
      merged.push(pa)
    }
  }

  // 2. 生成预算合并日志（同 key 多条时记录 kept/overwritten）
  const budgetMergeLogs = []
  const seenKeys = new Map()
  for (const pa of pendingActions) {
    if (!pa || pa.kind !== 'budget') continue
    const scope = pa.scope || 'adset'
    const nodeId = String(pa.nodeId || '')
    const accountId = String(pa.accountId || '')
    if (!nodeId || !accountId) continue
    const key = `${accountId}:${scope}:${nodeId}`
    const kept = budgetByKey.get(key)
    if (!kept) continue
    let acc = seenKeys.get(key)
    if (!acc) {
      acc = { keptRuleId: kept.sourceRuleId ?? null, overwrittenRuleIds: [] }
      seenKeys.set(key, acc)
    }
    if (pa !== kept && pa.sourceRuleId != null) {
      acc.overwrittenRuleIds.push(pa.sourceRuleId)
    }
  }

  for (const [key, info] of seenKeys.entries()) {
    if (info.overwrittenRuleIds.length === 0) continue
    const [accountId, scope, nodeId] = key.split(':')
    budgetMergeLogs.push({
      accountId,
      scope,
      nodeId,
      keptRuleId: info.keptRuleId,
      overwrittenRuleIds: info.overwrittenRuleIds
    })
  }

  // 3. 将聚合后的预算 PendingAction 追加到合并结果中，保持按首次出现顺序输出
  for (const key of budgetOrder) {
    const pa = budgetByKey.get(key)
    if (pa) merged.push(pa)
  }

  return { merged, budgetMergeLogs }
}

/**
 * 执行单个广告的动作并记录审计日志（M4：支持 runId、actionsOverride，审计日志写入 run_id）
 *
 * 【教学：actionsOverride 的作用】
 * - 仲裁后每个 ad 只执行「一个赢家动作」，不能再把整条 rule.actions 都执行。
 * - 调用方传入 actionsOverride = [winnerAction] 时，只执行这一条，保证「同一 run 同一 ad 一条记录」。
 *
 * @param {Object} params 执行参数
 * @param {Object} params.rule - 规则对象（包含 id, ruleName, actions, isSimulation 等）
 * @param {Object} params.matchedAd - 匹配的广告数据（必须含 ad_id, ad_set_id, status 等；来自仲裁输出的同一份）
 * @param {string} params.accountId - 广告账户ID
 * @param {number} params.ownerId - 负责人ID
 * @param {string} [params.runId] - M4 运行批次，写入 automation_logs.run_id
 * @param {Array} [params.actionsOverride] - 若传则只执行该数组（仲裁后单动作）；不传则用 rule.actions
 * @returns {Promise<Array>} 执行结果数组
 */
export async function executeActionsForAd({ rule, matchedAd, accountId, ownerId, runId = null, actionsOverride = null, auditDedupeSet = null }) {
  const results = []
  const pendingActions = []

  // M4：仲裁后只执行一条动作时用 actionsOverride，否则用规则配置的 actions
  const actions = Array.isArray(actionsOverride) && actionsOverride.length > 0
    ? actionsOverride
    : (Array.isArray(rule.actions) ? rule.actions : [])
  if (actions.length === 0) {
    logger.info(`  ⚠️  规则 "${rule.ruleName}" 没有配置动作，跳过`)
    return results
  }

  // Smart Mute 已移除：不再根据 mute_until 跳过执行；mute_until/mute_reason 仍由数据层写入，仅保留用于历史排查与脚本（如 clear-ad-mute.js）

  // 判断是否为 Dry Run 模式
  const isSimulation = rule.isSimulation || rule.is_simulation || false
  
  // 创建 Facebook API 客户端（仅在非 Dry Run 模式下需要）
  let api = null
  if (!isSimulation && FACEBOOK_ACCESS_TOKEN) {
    api = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
  }

  // 构建指标快照（用于审计日志，含 link_clicks 便于解释规则命中）
  const metricsSnapshot = {
    spend: matchedAd.spend || 0,
    cpc: matchedAd.cpc ?? null,
    ucpc: matchedAd.ucpc ?? null,
    roas: matchedAd.roas ?? null,
    cpa: matchedAd.cpa ?? null,
    purchases: matchedAd.purchases || 0,
    purchases_avg_after_create: matchedAd.purchases_avg_after_create ?? null,
    purchases_avg_after_create_days: matchedAd.purchases_avg_after_create_days ?? null,
    purchases_avg_after_create_range: matchedAd.purchases_avg_after_create_range ?? null,
    link_clicks: matchedAd.link_clicks ?? 0,
    unique_link_clicks: matchedAd.unique_link_clicks ?? 0,
    add_to_cart_count: matchedAd.add_to_cart_count ?? 0,
    initiate_checkout_count: matchedAd.initiate_checkout_count ?? 0,
    add_payment_info_count: matchedAd.add_payment_info_count ?? 0,
    ad_id: matchedAd.ad_id,
    ad_name: matchedAd.ad_name,
    status: matchedAd.status ?? null
  }
  const explanationPayload = buildAutomationLogExplanation({
    rule,
    matchedObject: matchedAd,
    accountId
  })

  // 遍历所有动作，逐个执行
  for (const action of actions) {
    const startTime = Date.now()
    let status = 'success'
    let errorMessage = null
    let apiRequest = null
    let apiResponse = null
    let cooldownKey = null  // 冷却键：供 cron 写 rule_ad_execution_state(scope_key)
    let logPreflightMode = null
    let resolvedBudgetLogObject = null

    try {
      if (isSimulation) {
        // ===== Dry Run 模式：Pre-Flight 仍生效，目标已达成则 skipped =====
        const adStatus = (matchedAd.status || '').toUpperCase()
        if (action.type === 'set_dynamic_budget') {
          const dynamicBudget = computeDynamicBudgetCents(matchedAd, action)
          apiRequest = JSON.stringify({ dryRun: true, action, dynamicBudget })
          if (!dynamicBudget.ok) {
            status = 'skipped'
            errorMessage = `动态预算跳过：${dynamicBudget.reason}`
            apiResponse = JSON.stringify({ dryRun: true, skipped: true, reason: dynamicBudget.reason })
          } else {
            logger.info(`    [Dry Run] 动态预算: ${dynamicBudget.metric}=${dynamicBudget.metricValue} × ${dynamicBudget.multiplier} → ${dynamicBudget.finalBudgetCents} 分`)
            apiResponse = JSON.stringify({ dryRun: true, finalBudgetCents: dynamicBudget.finalBudgetCents })
            status = 'success'
          }
        } else if (action.type === 'pause_ad' && ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(adStatus)) {
          logger.info(`    [Dry Run] Pre-Flight: 广告 ${matchedAd.ad_id} 已 ${adStatus}，无需 pause，跳过`)
          status = 'skipped'
          errorMessage = `目标已达成（status=${adStatus}）`
          apiRequest = JSON.stringify({ dryRun: true, preFlight: true, action })
          apiResponse = JSON.stringify({ dryRun: true, skipped: true, reason: 'already_paused' })
        } else if (action.type === 'activate_ad' && (adStatus === 'ACTIVE' || ['ARCHIVED', 'DELETED'].includes(adStatus))) {
          logger.info(`    [Dry Run] Pre-Flight: 广告 ${matchedAd.ad_id} 已 ${adStatus}，无需 activate，跳过`)
          status = 'skipped'
          errorMessage = adStatus === 'ACTIVE' ? '目标已达成' : `不可激活（status=${adStatus}）`
          apiRequest = JSON.stringify({ dryRun: true, preFlight: true, action })
          apiResponse = JSON.stringify({ dryRun: true, skipped: true, reason: adStatus === 'ACTIVE' ? 'already_active' : 'cannot_activate' })
        } else {
          logger.info(`    [Dry Run] 广告 ${matchedAd.ad_id} (${matchedAd.ad_name || '未知'}) 将执行: ${action.type}`)
          if (action.value !== undefined && ['increase_budget', 'decrease_budget', 'set_budget'].includes(action.type)) {
            const isSet = action.type === 'set_budget'
            const unit = isSet ? 'usd' : (action.value_unit === 'usd' ? 'usd' : 'percent')
            logger.info(`      参数: ${unit === 'usd' ? `$${action.value}` : `${action.value}%`}`)
          }
          apiRequest = JSON.stringify({ dryRun: true, action })
          apiResponse = JSON.stringify({ dryRun: true, message: '模拟执行成功' })
          status = 'success'
        }
      } else if (!api) {
        // ===== 没有 API 客户端（Token 未配置）=====
        logger.warn(`    ⚠️  无法执行动作 ${action.type}：Facebook Token 未配置`)
        status = 'skipped'
        errorMessage = 'Facebook Token 未配置'
      } else {
        // ===== 真实执行动作（M4 同层执行：按 targetLevel 分发 + Pre-Flight 信任门禁 + FB already 容错）=====
        switch (action.type) {
          case 'pause_ad':
          case 'activate_ad': {
            // M4 同层分发：根据规则 targetLevel 解释动作目标
            const intent = resolveStatusActionIntent(rule, action, matchedAd)
            const targetLevel = intent.resolvedStatusTargetLevel
            const op = intent.resolvedStatusOp // 'pause' | 'activate'
            const targetObjectId = intent.resolvedObjectId
            const targetObjectName = intent.resolvedObjectName

            if (!targetObjectId) {
              logger.warn(`    ⚠️  无法确定${targetLevel}级目标ID，跳过${action.type}`)
              status = 'fail'
              errorMessage = `${targetLevel}_id 不存在`
              break
            }

            const preflightInfo = await loadPreflightStatusByLevel({
              accountId,
              targetLevel,
              targetObjectId,
              fallbackStatus: matchedAd.status || null
            })
            logPreflightMode = preflightInfo.preflightMode
            const targetStatus = String(preflightInfo.status || '').toUpperCase()
            const isPause = op === 'pause'
            const alreadyPaused = ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(targetStatus)
            const alreadyActive = targetStatus === 'ACTIVE'
            const cannotActivate = ['ARCHIVED', 'DELETED'].includes(targetStatus)

            if (preflightInfo.preflightMode === 'preflight' && isPause && alreadyPaused) {
              logger.info(`    ⏭️  Pre-Flight: ${targetLevel} ${targetObjectId} 已处于 ${targetStatus}，无需 pause，跳过`)
              status = 'skipped'
              errorMessage = `目标已达成（status=${targetStatus}）`
              apiRequest = JSON.stringify({ preFlight: true, preflightMode: preflightInfo.preflightMode, targetLevel, targetObjectId, status: targetStatus })
              apiResponse = JSON.stringify({ skipped: true, reason: 'already_paused' })
              break
            }
            if (preflightInfo.preflightMode === 'preflight' && !isPause && alreadyActive) {
              logger.info(`    ⏭️  Pre-Flight: ${targetLevel} ${targetObjectId} 已 ACTIVE，无需 activate，跳过`)
              status = 'skipped'
              errorMessage = '目标已达成（status=ACTIVE）'
              apiRequest = JSON.stringify({ preFlight: true, preflightMode: preflightInfo.preflightMode, targetLevel, targetObjectId, status: 'ACTIVE' })
              apiResponse = JSON.stringify({ skipped: true, reason: 'already_active' })
              break
            }
            if (preflightInfo.preflightMode === 'preflight' && !isPause && cannotActivate) {
              logger.info(`    ⏭️  Pre-Flight: ${targetLevel} ${targetObjectId} 处于 ${targetStatus}，不可激活，跳过`)
              status = 'skipped'
              errorMessage = `不可激活（status=${targetStatus}）`
              apiRequest = JSON.stringify({ preFlight: true, preflightMode: preflightInfo.preflightMode, targetLevel, targetObjectId, status: targetStatus })
              apiResponse = JSON.stringify({ skipped: true, reason: 'cannot_activate' })
              break
            }

            // 冷却键按层级区分
            cooldownKey = `status_${targetLevel}:${targetObjectId}`

            // 收集状态类 PendingAction
            if (!isSimulation) {
              pendingActions.push({
                kind: 'status',
                op,
                targetLevel,
                accountId,
                targetObjectId,
                targetObjectName,
                ruleId: rule.id,
                runId
              })
            }

            // 按层级分发 API 调用
            logger.info(`    🔧 执行: ${isPause ? '暂停' : '激活'} ${targetLevel} ${targetObjectId}${targetObjectName ? ` (${targetObjectName})` : ''}`)
            apiRequest = JSON.stringify({ method: 'POST', endpoint: `/${targetObjectId}`, preflightMode: preflightInfo.preflightMode, targetLevel, body: { status: isPause ? 'PAUSED' : 'ACTIVE' } })

            try {
              if (targetLevel === 'ad') {
                isPause ? await api.pauseAd(targetObjectId) : await api.activateAd(targetObjectId)
              } else if (targetLevel === 'adset') {
                isPause ? await api.pauseAdset(targetObjectId) : await api.activateAdset(targetObjectId)
              } else {
                isPause ? await api.pauseCampaign(targetObjectId) : await api.activateCampaign(targetObjectId)
              }
              apiResponse = JSON.stringify({ success: true, targetLevel, targetObjectId })
              logger.info(`    ✅ 成功${isPause ? '暂停' : '激活'} ${targetLevel} ${targetObjectId}`)
              logFbActionSuccess({
                runId: runId || null,
                ruleId: rule.id || null,
                accountId: String(accountId),
                objectType: targetLevel,
                objectId: String(targetObjectId),
                adId: String(matchedAd?.ad_id || ''),
                actionType: action.type,
                httpStatus: 200
              })
            } catch (err) {
              const msg = (err.message || '').toLowerCase()
              if (msg.includes('already') || msg.includes('duplicate')) {
                status = 'skipped'
                errorMessage = `FB 返回已达成: ${err.message}`
                apiResponse = JSON.stringify({ skipped: true, reason: 'already_in_state', targetLevel, targetObjectId, apiError: err.message })
                logger.info(`    ⏭️  FB 容错: ${targetLevel} ${targetObjectId} 已在目标状态，记 skipped`)
              } else throw err
            }
            break
          }
          
          case 'set_dynamic_budget': {
            const dynamicBudget = computeDynamicBudgetCents(matchedAd, action)
            if (!dynamicBudget.ok) {
              status = 'skipped'
              errorMessage = `动态预算跳过：${dynamicBudget.reason}`
              cooldownKey = null
              apiRequest = JSON.stringify({ preFlight: true, action, dynamicBudget })
              apiResponse = JSON.stringify({ skipped: true, reason: dynamicBudget.reason })
              break
            }

            const cachedTargetContext = matchedAd?._resolvedDynamicBudgetTargetContext
            const targetContext = cachedTargetContext?.ruleId === rule?.id
              ? cachedTargetContext
              : await resolveBudgetTargetContext(rule, matchedAd, api)
            if (!targetContext.ok) {
              status = targetContext.severity === 'skipped' ? 'skipped' : 'fail'
              errorMessage = status === 'skipped'
                ? `动态预算跳过：${targetContext.reason}`
                : `动态预算目标解析失败：${targetContext.reason}`
              cooldownKey = targetContext.cooldownKey || getMatchedObjectScopeKey(rule, matchedAd)
              apiRequest = JSON.stringify({ action, dynamicBudget, targetContext })
              apiResponse = JSON.stringify(status === 'skipped'
                ? { skipped: true, reason: targetContext.reason, targetContext }
                : { error: targetContext.reason, targetContext })
              break
            }

            cooldownKey = targetContext.cooldownKey
            resolvedBudgetLogObject = {
              objectType: targetContext.budgetNodeType,
              objectId: targetContext.budgetNodeId,
              objectName: null
            }

            const intervalMin = rule.executionIntervalMinutes ?? rule.execution_interval_minutes ?? 15
            if (intervalMin > 0) {
              const due = await isCooldownDue(rule.id, cooldownKey, intervalMin)
              if (!due) {
                status = 'skipped'
                errorMessage = '预算冷却未到期'
                apiRequest = JSON.stringify({ preFlight: true, cooldownKey, reason: 'cooldown_not_reached', dynamicBudget })
                apiResponse = JSON.stringify({ skipped: true, reason: 'cooldown_not_reached' })
                break
              }
            }

            if (targetContext.currentCents === dynamicBudget.finalBudgetCents) {
              status = 'skipped'
              errorMessage = '目标已达成（budget_already_at_target）'
              apiRequest = JSON.stringify({
                preFlight: true,
                cooldownKey,
                currentCents: targetContext.currentCents,
                newBudgetCents: dynamicBudget.finalBudgetCents,
                reason: 'budget_already_at_target',
                dynamicBudget
              })
              apiResponse = JSON.stringify({ skipped: true, reason: 'budget_already_at_target' })
              break
            }

            // 可选项：当前预算高于公式结果时，不做下调
            if (action.skip_when_current_higher && targetContext.currentCents > dynamicBudget.finalBudgetCents) {
              status = 'skipped'
              errorMessage = '跳过下调：当前预算高于公式结果'
              apiRequest = JSON.stringify({
                preFlight: true,
                cooldownKey,
                currentCents: targetContext.currentCents,
                newBudgetCents: dynamicBudget.finalBudgetCents,
                reason: 'current_budget_higher',
                dynamicBudget
              })
              apiResponse = JSON.stringify({ skipped: true, reason: 'current_budget_higher' })
              break
            }

            logger.info(`    🔧 执行: 设置${targetContext.label}动态预算 ${targetContext.budgetNodeId} → ${dynamicBudget.finalBudgetCents} 分`)
            if (targetContext.budgetNodeType === 'adset') {
              await api.updateAdsetBudget(targetContext.budgetNodeId, dynamicBudget.finalBudgetCents, targetContext.isDaily)
            } else {
              await api.updateCampaignBudget(targetContext.budgetNodeId, dynamicBudget.finalBudgetCents, targetContext.isDaily)
            }

            pendingActions.push({
              kind: 'budget',
              scope: targetContext.budgetNodeType,
              accountId,
              nodeId: targetContext.budgetNodeId,
              isDaily: targetContext.isDaily,
              newBudgetCents: dynamicBudget.finalBudgetCents,
              sourceRuleId: rule.id,
              runId,
              rawAction: action
            })

            apiRequest = JSON.stringify({
              method: 'POST',
              endpoint: `/${targetContext.budgetNodeId}`,
              budgetTarget: targetContext.label,
              adjustType: action.type,
              dynamicBudget,
              currentCents: targetContext.currentCents,
              newBudgetCents: dynamicBudget.finalBudgetCents
            })
            apiResponse = JSON.stringify({
              success: true,
              budgetTarget: targetContext.label,
              budgetNodeType: targetContext.budgetNodeType,
              budgetNodeId: targetContext.budgetNodeId,
              newBudgetCents: dynamicBudget.finalBudgetCents
            })
            logFbActionSuccess({
              runId: runId || null,
              ruleId: rule.id || null,
              accountId: String(accountId),
              objectType: targetContext.budgetNodeType,
              objectId: String(targetContext.budgetNodeId || ''),
              adId: String(matchedAd?.ad_id || ''),
              actionType: action.type,
              httpStatus: 200
            })
            break
          }

          case 'increase_budget':
          case 'decrease_budget':
          case 'set_budget': {
            const budgetTargetLevel = String(rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()
            if (budgetTargetLevel !== 'ad') {
              status = 'fail'
              errorMessage = `预算动作仅支持 targetLevel=ad，当前为 ${budgetTargetLevel}`
              cooldownKey = getMatchedObjectScopeKey(rule, matchedAd)
              break
            }
            const adsetId = matchedAd.ad_set_id || matchedAd.adset_id
            if (!adsetId) {
              logger.warn(`    ⚠️  无法调整预算：广告 ${matchedAd.ad_id} 没有 adset_id`)
              status = 'fail'
              errorMessage = 'adset_id 不存在，无法调整预算'
              cooldownKey = getMatchedObjectScopeKey(rule, matchedAd)
              break
            }

            const isSetBudget = action.type === 'set_budget'
            const unit = isSetBudget ? 'usd' : (action.value_unit === 'usd' ? 'usd' : 'percent')
            const adjustVal = unit === 'usd' ? (action.value ?? 0) : (action.value ?? 10)
            const paramLabel = isSetBudget ? `$${adjustVal}` : (unit === 'usd' ? `$${adjustVal}` : `${adjustVal}%`)
            const isIncrease = action.type === 'increase_budget'
            const adjustDirection = isSetBudget ? '设置' : (isIncrease ? '增加' : '减少')

            // AdsPolar 智能路由：先查 AdSet 是否有预算，有则调 AdSet(ABO)，无则向上调 Campaign(CBO)
            // 提前设置 apiRequest 以便在 getAdsetBudgetDetail 阶段异常时也能追溯
            apiRequest = JSON.stringify({
              method: 'GET',
              endpoint: `/${adsetId}`,
              purpose: 'getAdsetBudgetDetail',
              actionType: action.type,
              actionValue: adjustVal,
              actionUnit: unit
            })
            let adsetDetail = null
            if (api) {
              adsetDetail = await api.getAdsetBudgetDetail(adsetId)
            }
            const isABO = adsetDetail && ((adsetDetail.daily_budget || 0) > 0 || (adsetDetail.lifetime_budget || 0) > 0)

            // 规则级执行间隔（分钟），与 cronService 中保持一致
            const intervalMin = rule.executionIntervalMinutes ?? rule.execution_interval_minutes ?? 15

            let newBudgetCents
            let targetNodeId
            let targetLabel
            let isDaily = true

            if (isABO) {
              targetNodeId = adsetId
              targetLabel = '广告组'
              const currentCents = (adsetDetail.daily_budget || 0) > 0 ? adsetDetail.daily_budget : adsetDetail.lifetime_budget
              isDaily = (adsetDetail.daily_budget || 0) > 0
              // 方案 A：set_budget 始终按实时 current 预算重算，避免使用基于 current=0 预计算的 _resolvedBudgetCents
              if (isSetBudget) {
                newBudgetCents = computeNewBudgetCentsOnce(currentCents, action)
              } else {
                newBudgetCents = (action._resolvedBudgetCents != null && Number.isInteger(action._resolvedBudgetCents))
                  ? action._resolvedBudgetCents
                  : computeNewBudgetCentsOnce(currentCents, action)
              }
              cooldownKey = `budget_adset:${adsetId}`
              // 精细冷却：按预算目标节点（广告组）检查是否到期，未到期则直接跳过本轮预算动作
              if (!isSimulation && intervalMin > 0) {
                const due = await isCooldownDue(rule.id, cooldownKey, intervalMin)
                if (!due) {
                  logger.info(`    🕒 预算冷却未到期，跳过${targetLabel} ${targetNodeId} (${cooldownKey})`)
                  status = 'skipped'
                  errorMessage = '预算冷却未到期'
                  apiRequest = JSON.stringify({ preFlight: true, cooldownKey, reason: 'cooldown_not_reached' })
                  apiResponse = JSON.stringify({ skipped: true, reason: 'cooldown_not_reached' })
                  break
                }
              }
              // Pre-Flight：当前预算已等于目标预算则跳过，不调 FB API
              if (!isSimulation && currentCents === newBudgetCents) {
                const skipReason = inferBudgetSkipReason(action, currentCents, newBudgetCents)
                logger.info(`    ⏭️  Pre-Flight: 广告组 ${adsetId} 当前预算=${currentCents} 分=目标，跳过`)
                status = 'skipped'
                errorMessage = `目标已达成（${skipReason}）`
                apiRequest = JSON.stringify({ preFlight: true, currentCents, newBudgetCents, reason: skipReason })
                apiResponse = JSON.stringify({ skipped: true, reason: skipReason })
                break
              }
              if (isSimulation) {
                logger.info(`    🔧 [Dry Run] ${adjustDirection}${targetLabel} ${adsetId} 预算 ${paramLabel} → ${newBudgetCents} 分`)
              } else {
                logger.info(`    🔧 执行: ${adjustDirection}${targetLabel} ${adsetId} 预算 ${paramLabel}`)
                logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
                await api.updateAdsetBudget(adsetId, newBudgetCents, isDaily)
              }
              if (!isSimulation) {
                pendingActions.push({
                  kind: 'budget',
                  scope: 'adset',
                  accountId,
                  nodeId: adsetId,
                  isDaily,
                  newBudgetCents,
                  sourceRuleId: rule.id,
                  runId,
                  rawAction: action
                })
              }
            } else {
              // CBO：预算在 Campaign
              const campaignId = matchedAd.campaign_id || null
              if (!campaignId) {
                logger.warn(`    ⚠️  CBO 广告系列但无 campaign_id，无法调整预算`)
                status = 'fail'
                errorMessage = 'CBO 广告系列缺少 campaign_id，无法调整系列预算'
                cooldownKey = getMatchedObjectScopeKey(rule, matchedAd)
                break
              }
              targetNodeId = campaignId
              targetLabel = '广告系列(CBO)'
              cooldownKey = `budget_campaign:${campaignId}`
              let currentCents = 0
              // 精细冷却：按预算目标节点（广告系列）检查是否到期，未到期则直接跳过本轮预算动作
              if (!isSimulation && intervalMin > 0) {
                const due = await isCooldownDue(rule.id, cooldownKey, intervalMin)
                if (!due) {
                  logger.info(`    🕒 预算冷却未到期，跳过${targetLabel} ${targetNodeId} (${cooldownKey})`)
                  status = 'skipped'
                  errorMessage = '预算冷却未到期'
                  apiRequest = JSON.stringify({ preFlight: true, cooldownKey, reason: 'cooldown_not_reached' })
                  apiResponse = JSON.stringify({ skipped: true, reason: 'cooldown_not_reached' })
                  break
                }
              }
              if (isSimulation) {
                if (action.type === 'set_budget') {
                  newBudgetCents = computeNewBudgetCentsOnce(0, action)
                  logger.info(`    🔧 [Dry Run] ${adjustDirection}${targetLabel} ${campaignId} 预算 ${paramLabel} → ${newBudgetCents} 分`)
                } else {
                  newBudgetCents = 0
                  logger.info(`    🔧 [Dry Run] ${adjustDirection}${targetLabel} ${campaignId} 预算 ${paramLabel}（不拉取、不下发）`)
                }
              } else {
                const campaignDetail = await api.getCampaignBudgetDetail(campaignId)
                currentCents = (campaignDetail.daily_budget || 0) > 0 ? campaignDetail.daily_budget : campaignDetail.lifetime_budget
                isDaily = (campaignDetail.daily_budget || 0) > 0
                newBudgetCents = computeNewBudgetCentsOnce(currentCents, action)
                cooldownKey = `budget_campaign:${campaignId}`
                // Pre-Flight：当前预算已等于目标预算则跳过
                if (currentCents === newBudgetCents) {
                  const skipReason = inferBudgetSkipReason(action, currentCents, newBudgetCents)
                  logger.info(`    ⏭️  Pre-Flight: 广告系列 ${campaignId} 当前预算=${currentCents} 分=目标，跳过`)
                  status = 'skipped'
                  errorMessage = `目标已达成（${skipReason}）`
                  apiRequest = JSON.stringify({ preFlight: true, currentCents, newBudgetCents, reason: skipReason })
                  apiResponse = JSON.stringify({ skipped: true, reason: skipReason })
                  break
                }
                logger.info(`    🔧 执行: ${adjustDirection}${targetLabel} ${campaignId} 预算 ${paramLabel}`)
                logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
                await api.updateCampaignBudget(campaignId, newBudgetCents, isDaily)
              }
              if (!isSimulation) {
                pendingActions.push({
                  kind: 'budget',
                  scope: 'campaign',
                  accountId,
                  nodeId: campaignId,
                  isDaily,
                  newBudgetCents,
                  sourceRuleId: rule.id,
                  runId,
                  rawAction: action
                })
              }
            }

            const changeLabel = isSetBudget ? `=$${adjustVal}` : (unit === 'usd' ? (isIncrease ? `+$${adjustVal}` : `-$${adjustVal}`) : (isIncrease ? `+${adjustVal}%` : `-${adjustVal}%`))
            apiRequest = JSON.stringify({
              method: 'POST',
              endpoint: `/${targetNodeId}`,
              budgetTarget: targetLabel,
              adjustType: action.type,
              value_unit: unit,
              adjustValue: adjustVal,
              newBudgetCents
            })
            apiResponse = JSON.stringify({
              success: true,
              newBudgetCents,
              change: changeLabel,
              budgetTarget: targetLabel
            })
            logger.info(`    ✅ 成功${adjustDirection}预算: ${newBudgetCents} 分 (${targetLabel})`)
            logFbActionSuccess({
              runId: runId || null,
              ruleId: rule.id || null,
              accountId: String(accountId),
              objectType: isABO ? 'adset' : 'campaign',
              objectId: String(targetNodeId || ''),
              adId: String(matchedAd?.ad_id || ''),
              actionType: action.type,
              httpStatus: 200
            })
            break
          }
          
          default: {
            logger.warn(`    ⚠️  不支持的动作类型: ${action.type}`)
            status = 'skipped'
            errorMessage = `不支持的动作类型: ${action.type}`
          }
        }
      }
    } catch (error) {
      logger.error(`    ❌ 执行动作失败: ${action.type}`, error.message)
      status = 'fail'
      errorMessage = error.message
      // 保留完整错误信息：优先 Facebook API 原始错误，其次 axios response data，最后 message
      const fbErrorDetail = error?.facebookError?.error || error?.response?.data?.error || null
      apiResponse = JSON.stringify({
        error: error.message,
        ...(fbErrorDetail ? { fb_error: fbErrorDetail } : {})
      })
      const fallbackObjectType = String(rule?.targetLevel || rule?.target_level || matchedAd?.objectType || 'ad').toLowerCase()
      const fallbackObjectId = String(
        fallbackObjectType === 'campaign'
          ? (matchedAd?.campaign_id || matchedAd?.ad_id || '')
          : fallbackObjectType === 'adset'
            ? (matchedAd?.ad_set_id || matchedAd?.adset_id || matchedAd?.ad_id || '')
            : (matchedAd?.ad_id || '')
      )
      logFbActionFailure({
        context: {
          runId: runId || null,
          ruleId: rule.id || null,
          accountId: String(accountId),
          objectType: fallbackObjectType,
          objectId: fallbackObjectId,
          adId: String(matchedAd?.ad_id || ''),
          actionType: action.type,
          requestPreview: apiRequest
        },
        error
      })
    }

    // ===== 写入审计日志（M5：通用对象字段双写 + 旧字段兼容）=====
    const now = new Date()
    // M5 通用对象字段：从 intent 或 matchedAd 推断
    const statusActionTypes = ['pause_ad', 'activate_ad']
    const logObjectType = resolvedBudgetLogObject?.objectType
      || (statusActionTypes.includes(action.type)
        ? (matchedAd?.objectType || rule?.targetLevel || rule?.target_level || 'ad')
        : (matchedAd?.objectType || 'ad'))
    const logObjectId = String(
      resolvedBudgetLogObject?.objectId
      || matchedAd?.objectId
      || (statusActionTypes.includes(action.type)
        ? (logObjectType === 'adset' ? (matchedAd.ad_set_id || matchedAd.adset_id || matchedAd.ad_id)
          : logObjectType === 'campaign' ? (matchedAd.campaign_id || matchedAd.ad_id)
          : matchedAd.ad_id)
        : matchedAd.ad_id)
      || ''
    )
    const logObjectName = resolvedBudgetLogObject?.objectName
      || matchedAd?.objectName
      || (statusActionTypes.includes(action.type)
        ? (logObjectType === 'adset' ? (matchedAd.adset_name || null)
          : logObjectType === 'campaign' ? (matchedAd.campaign_name || null)
          : matchedAd.ad_name || null)
        : (matchedAd.ad_name || null))
    // preflight_mode：skipped 且 reason 含 already 视为 preflight 命中，否则 direct_api_fallback
    const resolvedPreflightMode = statusActionTypes.includes(action.type)
      ? (logPreflightMode || (status === 'skipped' ? 'preflight' : 'direct_api_fallback'))
      : null

    const auditLogContext = {
      runId: runId || null,
      ruleId: rule.id || null,
      accountId: String(accountId),
      ownerId: ownerId ?? null,
      objectType: logObjectType,
      objectId: String(logObjectId || ''),
      adId: String(matchedAd?.ad_id || ''),
      actionType: action.type,
      auditStatus: status
    }

    try {
      const dedupeKey = buildAuditDedupeKey({
        runId: runId || null,
        ruleId: rule.id || null,
        objectType: logObjectType,
        objectId: String(logObjectId || ''),
        actionType: action.type
      })
      if (auditDedupeSet && dedupeKey && auditDedupeSet.has(dedupeKey)) {
        logger.info(`    ⏭️  审计去重：跳过重复日志 ${dedupeKey}`)
      } else {
        const insertResult = await db.insert(automationLogs).values({
        runId: runId || null,
        accountId: String(accountId),
        adId: String(matchedAd?.ad_id || ''),        // 旧字段保留兼容：campaign/adset 目标避免写入字符串 'null'
        adName: matchedAd.ad_name || null,             // 旧字段保留兼容
        // M5 通用对象字段（双写）
        objectType: logObjectType,
        objectId: String(logObjectId || ''),
        objectName: logObjectName,
        preflightMode: resolvedPreflightMode,
        ruleId: rule.id || null,
        ruleName: rule.ruleName || rule.rule_name || null,
        ownerId: ownerId,
        metricsSnapshot: metricsSnapshot,
        explanation: explanationPayload,
        actionType: action.type.toUpperCase(),
        actionPayload: action,
        isSimulation: isSimulation,
        apiRequest: apiRequest,
        apiResponse: apiResponse,
        status: status,
        errorMessage: errorMessage,
        triggeredAt: now
        })
        if (auditDedupeSet && dedupeKey) auditDedupeSet.add(dedupeKey)
        const auditLogId = Array.isArray(insertResult)
          ? insertResult?.[0]?.insertId ?? null
          : insertResult?.insertId ?? null
        logAuditInsertSuccess({
          ...auditLogContext,
          auditLogId
        })
      }
    } catch (logError) {
      // 审计日志写入失败不应该中断主流程
      logAuditInsertFailure({
        context: auditLogContext,
        payload: {
          actionPayload: action,
          metricsSnapshot,
          explanation: explanationPayload
        },
        error: logError
      })
    }

    // 记录结果
    results.push({
      actionType: action.type,
      status,
      errorMessage,
      durationMs: Date.now() - startTime,
      ...(cooldownKey != null && { cooldownKey })
    })
  }

  // 为后续 Batch 执行预留 PendingAction 规划结果（不改变现有调用方行为）
  // 调用方当前仍按原约定把 results 当数组使用；如需 Batch，可按需读取 results.pendingActions
  results.pendingActions = pendingActions
  return results
}

export async function executeActionsForObject({ rule, matchedObject, accountId, ownerId, runId = null, actionsOverride = null }) {
  return executeActionsForAd({
    rule,
    matchedAd: matchedObject,
    accountId,
    ownerId,
    runId,
    actionsOverride
  })
}

/**
 * 批量执行规则匹配的所有广告的动作（单规则路径：如手动执行单条规则）
 * M4：支持传入 runId，写入 automation_logs.run_id
 *
 * @param {Object} params 执行参数
 * @param {Object} params.rule - 规则对象
 * @param {Array} params.matchedAds - 匹配的广告列表
 * @param {string} params.accountId - 广告账户ID
 * @param {number} params.ownerId - 负责人ID
 * @param {string} [params.runId] - M4 运行批次
 * @returns {Promise<Object>} 批量执行统计结果
 */
export async function executeActionsForRule({ rule, matchedAds, accountId, ownerId, runId = null }) {
  const targetLevel = String(rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()
  const dedupeInputByObject = targetLevel === 'ad'
    ? matchedAds
    : (() => {
        const seen = new Set()
        const deduped = []
        for (const matchedAd of matchedAds || []) {
          const objectKey = resolveObjectDedupKey(matchedAd, targetLevel)
          if (!objectKey || seen.has(objectKey)) continue
          seen.add(objectKey)
          deduped.push(matchedAd)
        }
        return deduped
      })()

  const stats = {
    totalAds: dedupeInputByObject.length,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    results: []
  }
  const auditDedupeSet = new Set()

  const isSimulation = rule.isSimulation || rule.is_simulation || false
  const modeLabel = isSimulation ? '[Dry Run]' : '[执行]'
  const enableActionBatch = process.env.ENABLE_ACTION_BATCH === '1' || process.env.ENABLE_ACTION_BATCH === 'true'
  
  logger.info(`  ${modeLabel} 规则 "${rule.ruleName}" 将处理 ${dedupeInputByObject.length} 个对象`)

  const ruleActions = Array.isArray(rule.actions) ? rule.actions : []
  const singleAction = ruleActions.length === 1 ? ruleActions[0] : null
  const isSingleStatusAction = singleAction && ['pause_ad', 'activate_ad'].includes(singleAction.type)
  const canBatchSingleRuleStatus = enableActionBatch && !isSimulation && !!FACEBOOK_ACCESS_TOKEN && isSingleStatusAction && targetLevel === 'ad'
  if (!canBatchSingleRuleStatus && !isSimulation) {
    const maybeStatusAction = singleAction && ['pause_ad', 'activate_ad'].includes(singleAction?.type)
    if (maybeStatusAction || ruleActions.some(a => ['pause_ad', 'activate_ad'].includes(a?.type))) {
      logger.info(
        `  [执行] 单规则未走 Batch，回退逐条执行：enableActionBatch=${enableActionBatch}, isSimulation=${isSimulation}, hasToken=${!!FACEBOOK_ACCESS_TOKEN}, actionsCount=${ruleActions.length}, singleStatusAction=${!!isSingleStatusAction}`
      )
    }
  }

  // 单条规则手动执行也支持状态动作 Batch，便于与调度路径保持一致
  if (canBatchSingleRuleStatus) {
    const actionType = singleAction.type
    const actionUpper = String(actionType || '').toUpperCase()
    const batchPlans = []

    const insertBatchAuditLog = async ({ matchedAd, status, errorMessage = null, apiRequest = null, apiResponse = null }) => {
      const metricsSnapshot = {
        spend: matchedAd?.spend || 0,
        cpc: matchedAd?.cpc ?? null,
        ucpc: matchedAd?.ucpc ?? null,
        roas: matchedAd?.roas ?? null,
        cpa: matchedAd?.cpa ?? null,
        purchases: matchedAd?.purchases || 0,
        purchases_avg_after_create: matchedAd?.purchases_avg_after_create ?? null,
        purchases_avg_after_create_days: matchedAd?.purchases_avg_after_create_days ?? null,
        purchases_avg_after_create_range: matchedAd?.purchases_avg_after_create_range ?? null,
        link_clicks: matchedAd?.link_clicks ?? 0,
        unique_link_clicks: matchedAd?.unique_link_clicks ?? 0,
        add_to_cart_count: matchedAd?.add_to_cart_count ?? 0,
        initiate_checkout_count: matchedAd?.initiate_checkout_count ?? 0,
        add_payment_info_count: matchedAd?.add_payment_info_count ?? 0,
        ad_id: matchedAd?.ad_id,
        ad_name: matchedAd?.ad_name,
        status: matchedAd?.status ?? null
      }
      // M5 通用对象字段
      const logObjectType = matchedAd?.objectType || rule?.targetLevel || rule?.target_level || 'ad'
      const logObjectId = matchedAd?.objectId || matchedAd?.ad_id || ''
      const logObjectName = matchedAd?.objectName || matchedAd?.ad_name || null
      const explanationPayload = buildAutomationLogExplanation({
        rule,
        matchedObject: matchedAd,
        accountId
      })

      try {
        const auditLogContext = {
          runId: runId || null,
          ruleId: rule?.id || null,
          accountId: String(accountId),
          ownerId: ownerId ?? null,
          objectType: logObjectType,
          objectId: String(logObjectId || ''),
          adId: String(matchedAd?.ad_id || ''),
          actionType: actionType,
          auditStatus: status
        }
        const dedupeKey = buildAuditDedupeKey({
          runId: runId || null,
          ruleId: rule?.id || null,
          objectType: logObjectType,
          objectId: String(logObjectId || ''),
          actionType
        })
        if (dedupeKey && auditDedupeSet.has(dedupeKey)) {
          logger.info(`    ⏭️  审计去重：跳过重复日志 ${dedupeKey}`)
          return
        }
        const insertResult = await db.insert(automationLogs).values({
          runId: runId || null,
          accountId: String(accountId),
          adId: String(matchedAd?.ad_id || ''),           // 旧字段兼容
          adName: matchedAd?.ad_name || null,              // 旧字段兼容
          // M5 通用对象字段（双写）
          objectType: logObjectType,
          objectId: String(logObjectId),
          objectName: logObjectName,
          preflightMode: status === 'skipped' ? 'preflight' : 'direct_api_fallback',
          ruleId: rule?.id || null,
          ruleName: rule?.ruleName || rule?.rule_name || null,
          ownerId: ownerId ?? 0,
          metricsSnapshot,
          explanation: explanationPayload,
          actionType: actionUpper,
          actionPayload: { type: actionType },
          isSimulation,
          apiRequest,
          apiResponse,
          status,
          errorMessage,
          triggeredAt: new Date()
        })
        if (dedupeKey) auditDedupeSet.add(dedupeKey)
        const auditLogId = Array.isArray(insertResult)
          ? insertResult?.[0]?.insertId ?? null
          : insertResult?.insertId ?? null
        logAuditInsertSuccess({
          ...auditLogContext,
          auditLogId
        })
      } catch (logErr) {
        logAuditInsertFailure({
          context: {
            runId: runId || null,
            ruleId: rule?.id || null,
            accountId: String(accountId),
            ownerId: ownerId ?? null,
            objectType: logObjectType,
            objectId: String(logObjectId || ''),
            adId: String(matchedAd?.ad_id || ''),
            actionType: actionType,
            auditStatus: status
          },
          payload: {
            actionPayload: { type: actionType },
            metricsSnapshot,
            explanation: explanationPayload
          },
          error: logErr
        })
      }
    }

    for (const matchedAd of dedupeInputByObject) {
      const adId = String(matchedAd?.ad_id || '').trim()
      if (!adId) continue
      const adStatus = String(matchedAd?.status || '').toUpperCase()
      const skipPause = actionType === 'pause_ad' && ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(adStatus)
      const skipActivateDone = actionType === 'activate_ad' && adStatus === 'ACTIVE'
      const skipActivateForbidden = actionType === 'activate_ad' && ['ARCHIVED', 'DELETED'].includes(adStatus)
      const preflightSkipped = skipPause || skipActivateDone || skipActivateForbidden

      if (preflightSkipped) {
        const reason = skipPause
          ? 'already_paused'
          : (skipActivateDone ? 'already_active' : 'cannot_activate')
        stats.skippedCount++
        stats.results.push({
          adId,
          results: [{ actionType, status: 'skipped', errorMessage: `目标已达成（status=${adStatus}）`, durationMs: 0 }]
        })
        await insertBatchAuditLog({
          matchedAd,
          status: 'skipped',
          errorMessage: `目标已达成（status=${adStatus}）`,
          apiRequest: JSON.stringify({ preFlight: true, status: adStatus }),
          apiResponse: JSON.stringify({ skipped: true, reason })
        })
        continue
      }

      batchPlans.push({
        adId,
        matchedAd,
        request: {
          method: 'POST',
          relative_url: adId,
          body: actionType === 'pause_ad' ? 'status=PAUSED' : 'status=ACTIVE'
        }
      })
    }

    if (batchPlans.length > 0) {
      try {
        const api = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
        const requests = batchPlans.map(plan => plan.request)
        const batchResults = await api.batchRequests(requests, { priority: 'action', label: 'actions_batch' })
        for (let i = 0; i < batchPlans.length; i++) {
          const plan = batchPlans[i]
          const res = batchResults[i]
          const ok = Number(res?.code || 0) >= 200 && Number(res?.code || 0) < 300 && !res?.body?.error
          const status = ok ? 'success' : 'fail'
          const errorMessage = ok ? null : (res?.body?.error?.message || `Batch code=${res?.code || 0}`)
          if (ok) {
            logger.info(`    ✅ Batch 成功${actionType === 'pause_ad' ? '暂停' : '激活'}广告 ${plan.adId}`)
            logFbActionSuccess({
              runId: runId || null,
              ruleId: rule?.id || null,
              accountId: String(accountId),
              objectType: 'ad',
              objectId: String(plan.adId),
              adId: String(plan.adId),
              actionType,
              httpStatus: Number(res?.code || 0) || 200
            })
          } else {
            logger.warn(`    ❌ Batch 失败 ad=${plan.adId}: ${errorMessage}`)
            logFbActionFailure({
              context: {
                runId: runId || null,
                ruleId: rule?.id || null,
                accountId: String(accountId),
                objectType: 'ad',
                objectId: String(plan.adId),
                adId: String(plan.adId),
                actionType,
                requestPreview: JSON.stringify(requests[i]),
                responsePreview: JSON.stringify(res?.body || null)
              },
              error: {
                message: errorMessage,
                response: {
                  status: Number(res?.code || 0) || null,
                  data: res?.body || null
                }
              }
            })
          }
          if (ok) stats.successCount++
          else stats.failCount++
          stats.results.push({
            adId: plan.adId,
            results: [{ actionType, status, errorMessage, durationMs: 0, cooldownKey: `status_ad:${plan.adId}` }]
          })
          await insertBatchAuditLog({
            matchedAd: plan.matchedAd,
            status,
            errorMessage,
            apiRequest: JSON.stringify(requests[i]),
            apiResponse: JSON.stringify(res?.body || res?.raw || null)
          })
        }
        logger.info(`  [执行] Batch 状态动作完成: success=${stats.successCount}, fail=${stats.failCount}, skipped=${stats.skippedCount}`)
      } catch (err) {
        logger.error(`    ❌ 单规则 Batch 状态动作执行失败:`, err.message)
        logFbActionFailure({
          context: {
            runId: runId || null,
            ruleId: rule?.id || null,
            accountId: String(accountId),
            objectType: 'ad',
            objectId: null,
            adId: null,
            actionType,
            requestPreview: 'batchRequests'
          },
          error: err
        })
        for (const plan of batchPlans) {
          stats.failCount++
          stats.results.push({
            adId: plan.adId,
            results: [{ actionType, status: 'fail', errorMessage: err.message, durationMs: 0, cooldownKey: `status_ad:${plan.adId}` }]
          })
          await insertBatchAuditLog({
            matchedAd: plan.matchedAd,
            status: 'fail',
            errorMessage: err.message,
            apiRequest: JSON.stringify(plan.request),
            apiResponse: JSON.stringify({ error: err.message })
          })
        }
      }
    }

    return stats
  }

  for (const matchedAd of dedupeInputByObject) {
    try {
      const results = await executeActionsForAd({
        rule,
        matchedAd,
        accountId,
        ownerId,
        runId,
        auditDedupeSet
      })

      // 统计结果
      for (const result of results) {
        if (result.status === 'success') {
          stats.successCount++
        } else if (result.status === 'fail') {
          stats.failCount++
        } else {
          stats.skippedCount++
        }
      }
      stats.results.push({ adId: matchedAd.ad_id, results })
    } catch (error) {
      logger.error(`    ❌ 处理广告 ${matchedAd.ad_id} 失败:`, error.message)
      stats.failCount++
      stats.results.push({ adId: matchedAd.ad_id, error: error.message })
    }
  }

  // Smart Mute 已移除：不再因 mute 跳过，故不再设置 skipReason='muted'

  return stats
}

/**
 * 获取最近的审计日志（用于前端展示）
 * 
 * @param {Object} params 查询参数
 * @param {string} [params.accountId] - 可选：按账户筛选
 * @param {string} [params.ruleId] - 可选：按规则筛选
 * @param {number} [params.limit=50] - 返回数量限制
 * @returns {Promise<Array>} 审计日志列表
 */
export async function getRecentLogs({ accountId, ruleId, limit = 50 } = {}) {
  try {
    let query = `
      SELECT * FROM automation_logs 
      WHERE 1=1
    `
    const params = []

    if (accountId) {
      query += ` AND account_id = ?`
      params.push(accountId)
    }

    if (ruleId) {
      query += ` AND rule_id = ?`
      params.push(ruleId)
    }

    query += ` ORDER BY triggered_at DESC LIMIT ?`
    params.push(limit)

    const [rows] = await pool.execute(query, params)
    return rows
  } catch (error) {
    logger.error('获取审计日志失败:', error.message)
    return []
  }
}

