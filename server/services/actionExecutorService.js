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

// Facebook API Token（从环境变量读取）
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN

// M4 预算护栏：最低预算 100 美分 = 1 美元（与 FB 要求一致）
const MIN_BUDGET_CENTS = 100

/** value_unit 合法值：percent=百分比，usd=固定美元 */
const VALID_VALUE_UNITS = ['percent', 'usd']

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
    return targetCents
  }

  const cents = Math.round(Number(currentBudgetCents) || 0)
  const unit = VALID_VALUE_UNITS.includes(action?.value_unit) ? action.value_unit : 'percent'
  const isIncrease = action?.type === 'increase_budget'

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
  return newCents
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
export async function executeActionsForAd({ rule, matchedAd, accountId, ownerId, runId = null, actionsOverride = null }) {
  const results = []

  // M4：仲裁后只执行一条动作时用 actionsOverride，否则用规则配置的 actions
  const actions = Array.isArray(actionsOverride) && actionsOverride.length > 0
    ? actionsOverride
    : (Array.isArray(rule.actions) ? rule.actions : [])
  if (actions.length === 0) {
    logger.info(`  ⚠️  规则 "${rule.ruleName}" 没有配置动作，跳过`)
    return results
  }

  // M4 3.4 Smart Mute：统一在执行层入口检查，单条规则执行与 cron 仲裁路径均生效
  const mu = matchedAd.mute_until
  if (mu != null && new Date() < new Date(mu)) {
    logger.info(`   🔇 广告 ${matchedAd.ad_id} 处于 mute 期 (until ${mu})，跳过执行`)
    results.push({
      actionType: 'muted',
      status: 'skipped',
      errorMessage: `mute_until: ${mu}, mute_reason: ${matchedAd.mute_reason || ''}`,
      durationMs: 0
    })
    return results
  }

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
    link_clicks: matchedAd.link_clicks ?? 0,
    unique_link_clicks: matchedAd.unique_link_clicks ?? 0,
    ad_id: matchedAd.ad_id,
    ad_name: matchedAd.ad_name,
    status: matchedAd.status ?? null
  }

  // 遍历所有动作，逐个执行
  for (const action of actions) {
    const startTime = Date.now()
    let status = 'success'
    let errorMessage = null
    let apiRequest = null
    let apiResponse = null

    try {
      if (isSimulation) {
        // ===== Dry Run 模式：Pre-Flight 仍生效，目标已达成则 skipped =====
        const adStatus = (matchedAd.status || '').toUpperCase()
        if (action.type === 'pause_ad' && ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(adStatus)) {
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
        // ===== 真实执行动作（M4 Pre-Flight：本地 status 判断 + FB already 容错）=====
        switch (action.type) {
          case 'pause_ad': {
            const adStatus = (matchedAd.status || '').toUpperCase()
            const alreadyPaused = ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(adStatus)
            if (alreadyPaused) {
              logger.info(`    ⏭️  Pre-Flight: 广告 ${matchedAd.ad_id} 已处于 ${adStatus}，无需再 pause，跳过`)
              status = 'skipped'
              errorMessage = `目标已达成（status=${adStatus}）`
              apiRequest = JSON.stringify({ preFlight: true, status: adStatus })
              apiResponse = JSON.stringify({ skipped: true, reason: 'already_paused' })
              break
            }
            logger.info(`    🔧 执行: 暂停广告 ${matchedAd.ad_id}`)
            apiRequest = JSON.stringify({ method: 'POST', endpoint: `/${matchedAd.ad_id}`, body: { status: 'PAUSED' } })
            try {
              await api.pauseAd(matchedAd.ad_id)
              apiResponse = JSON.stringify({ success: true })
              logger.info(`    ✅ 成功暂停广告 ${matchedAd.ad_id}`)
            } catch (err) {
              const msg = (err.message || '').toLowerCase()
              if (msg.includes('already') || msg.includes('duplicate')) {
                status = 'skipped'
                errorMessage = `FB 返回已达成: ${err.message}`
                apiResponse = JSON.stringify({ skipped: true, reason: 'already_in_state', apiError: err.message })
                logger.info(`    ⏭️  FB 容错: 广告 ${matchedAd.ad_id} 已暂停，记 skipped`)
              } else throw err
            }
            break
          }
          
          case 'activate_ad': {
            const adStatus = (matchedAd.status || '').toUpperCase()
            const alreadyActive = adStatus === 'ACTIVE'
            const cannotActivate = ['ARCHIVED', 'DELETED'].includes(adStatus)
            if (alreadyActive) {
              logger.info(`    ⏭️  Pre-Flight: 广告 ${matchedAd.ad_id} 已 ACTIVE，无需再 activate，跳过`)
              status = 'skipped'
              errorMessage = `目标已达成（status=ACTIVE）`
              apiRequest = JSON.stringify({ preFlight: true, status: 'ACTIVE' })
              apiResponse = JSON.stringify({ skipped: true, reason: 'already_active' })
              break
            }
            if (cannotActivate) {
              logger.info(`    ⏭️  Pre-Flight: 广告 ${matchedAd.ad_id} 处于 ${adStatus}，不可激活，跳过`)
              status = 'skipped'
              errorMessage = `不可激活（status=${adStatus}）`
              apiRequest = JSON.stringify({ preFlight: true, status: adStatus })
              apiResponse = JSON.stringify({ skipped: true, reason: 'cannot_activate' })
              break
            }
            logger.info(`    🔧 执行: 激活广告 ${matchedAd.ad_id}`)
            apiRequest = JSON.stringify({ method: 'POST', endpoint: `/${matchedAd.ad_id}`, body: { status: 'ACTIVE' } })
            try {
              await api.activateAd(matchedAd.ad_id)
              apiResponse = JSON.stringify({ success: true })
              logger.info(`    ✅ 成功激活广告 ${matchedAd.ad_id}`)
            } catch (err) {
              const msg = (err.message || '').toLowerCase()
              if (msg.includes('already') || msg.includes('duplicate')) {
                status = 'skipped'
                errorMessage = `FB 返回已达成: ${err.message}`
                apiResponse = JSON.stringify({ skipped: true, reason: 'already_in_state', apiError: err.message })
                logger.info(`    ⏭️  FB 容错: 广告 ${matchedAd.ad_id} 已激活或不可变更，记 skipped`)
              } else throw err
            }
            break
          }
          
          case 'increase_budget':
          case 'decrease_budget':
          case 'set_budget': {
            const adsetId = matchedAd.ad_set_id || matchedAd.adset_id
            if (!adsetId) {
              logger.warn(`    ⚠️  无法调整预算：广告 ${matchedAd.ad_id} 没有 adset_id`)
              status = 'fail'
              errorMessage = 'adset_id 不存在，无法调整预算'
              break
            }

            const isSetBudget = action.type === 'set_budget'
            const unit = isSetBudget ? 'usd' : (action.value_unit === 'usd' ? 'usd' : 'percent')
            const adjustVal = unit === 'usd' ? (action.value ?? 0) : (action.value ?? 10)
            const paramLabel = isSetBudget ? `$${adjustVal}` : (unit === 'usd' ? `$${adjustVal}` : `${adjustVal}%`)
            const isIncrease = action.type === 'increase_budget'
            const adjustDirection = isSetBudget ? '设置' : (isIncrease ? '增加' : '减少')

            // AdsPolar 智能路由：先查 AdSet 是否有预算，有则调 AdSet(ABO)，无则向上调 Campaign(CBO)
            let adsetDetail = null
            if (api) {
              adsetDetail = await api.getAdsetBudgetDetail(adsetId)
            }
            const isABO = adsetDetail && ((adsetDetail.daily_budget || 0) > 0 || (adsetDetail.lifetime_budget || 0) > 0)

            let newBudgetCents
            let targetNodeId
            let targetLabel
            let isDaily = true

            if (isABO) {
              targetNodeId = adsetId
              targetLabel = '广告组'
              const currentCents = (adsetDetail.daily_budget || 0) > 0 ? adsetDetail.daily_budget : adsetDetail.lifetime_budget
              isDaily = (adsetDetail.daily_budget || 0) > 0
              newBudgetCents = (action._resolvedBudgetCents != null && Number.isInteger(action._resolvedBudgetCents))
                ? action._resolvedBudgetCents
                : computeNewBudgetCentsOnce(currentCents, action)
              if (isSimulation) {
                logger.info(`    🔧 [Dry Run] ${adjustDirection}${targetLabel} ${adsetId} 预算 ${paramLabel} → ${newBudgetCents} 分`)
              } else {
                logger.info(`    🔧 执行: ${adjustDirection}${targetLabel} ${adsetId} 预算 ${paramLabel}`)
                logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
                await api.updateAdsetBudget(adsetId, newBudgetCents, isDaily)
              }
            } else {
              // CBO：预算在 Campaign
              const campaignId = matchedAd.campaign_id || null
              if (!campaignId) {
                logger.warn(`    ⚠️  CBO 广告系列但无 campaign_id，无法调整预算`)
                status = 'fail'
                errorMessage = 'CBO 广告系列缺少 campaign_id，无法调整系列预算'
                break
              }
              targetNodeId = campaignId
              targetLabel = '广告系列(CBO)'
              let currentCents = 0
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
                logger.info(`    🔧 执行: ${adjustDirection}${targetLabel} ${campaignId} 预算 ${paramLabel}`)
                logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
                await api.updateCampaignBudget(campaignId, newBudgetCents, isDaily)
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
      apiResponse = JSON.stringify({ error: error.message })
    }

    // ===== 写入审计日志（M4：写入 run_id，triggered_at 为 Date，DB session 已 UTC）=====
    const now = new Date()
    try {
      await db.insert(automationLogs).values({
        runId: runId || null,
        accountId: String(accountId),
        adId: String(matchedAd.ad_id),
        adName: matchedAd.ad_name || null,
        ruleId: rule.id || null,
        ruleName: rule.ruleName || rule.rule_name || null,
        ownerId: ownerId,
        metricsSnapshot: metricsSnapshot,
        actionType: action.type.toUpperCase(),
        actionPayload: action,
        isSimulation: isSimulation,
        apiRequest: apiRequest,
        apiResponse: apiResponse,
        status: status,
        errorMessage: errorMessage,
        triggeredAt: now
      })
    } catch (logError) {
      // 审计日志写入失败不应该中断主流程
      logger.error(`    ⚠️  写入审计日志失败:`, logError.message)
    }

    // 记录结果
    results.push({
      actionType: action.type,
      status,
      errorMessage,
      durationMs: Date.now() - startTime
    })
  }

  return results
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
  const stats = {
    totalAds: matchedAds.length,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    results: []
  }

  const isSimulation = rule.isSimulation || rule.is_simulation || false
  const modeLabel = isSimulation ? '[Dry Run]' : '[执行]'
  
  logger.info(`  ${modeLabel} 规则 "${rule.ruleName}" 将处理 ${matchedAds.length} 个广告`)

  for (const matchedAd of matchedAds) {
    try {
      const results = await executeActionsForAd({
        rule,
        matchedAd,
        accountId,
        ownerId,
        runId
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

  // M4 3.4：单条规则路径若全部因 mute 跳过，带上 skipReason/skipDetails 供上层写摘要
  if (
    matchedAds.length > 0 &&
    stats.successCount === 0 &&
    stats.failCount === 0 &&
    stats.skippedCount === matchedAds.length &&
    stats.results.every(r => r.results?.[0]?.actionType === 'muted')
  ) {
    const first = matchedAds[0]
    stats.skipReason = 'muted'
    stats.skipDetails = {
      ad_ids: matchedAds.map(m => m.ad_id),
      mute_until: first?.mute_until ?? null,
      mute_reason: first?.mute_reason ?? null
    }
  }

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

