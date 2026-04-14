/**
 * 原则 A：enabled=true 前「开闸」校验（与 Cron/单条执行读取字段对齐）
 * 依据：.cursor/plans/模板半成品规则自动铺底_992a9978.plan.md
 */
import pool from '../db/connection.js'
import { normalizeAccountId } from '../utils/targetIdUtils.js'
import {
  validateConditionsStructure,
  validateTimeWindowConsistency,
  normalizeConditionsToV2
} from '../utils/conditionsValidator.js'
import { validateActions } from '../utils/templateValidator.js'
import { isDynamicScopeFeatureEnabled } from './dynamicScopeService.js'

/**
 * 与 cronService.getRuleAccountIds 一致：有可执行账户时才应开闸 / 才应进入 Cron 轮询
 */
export function getRuleExecutionAccountIds(rule) {
  const targetByAccount = rule?.targetByAccount ?? rule?.target_by_account
  if (targetByAccount && typeof targetByAccount === 'object') {
    const keys = Object.keys(targetByAccount).filter(
      (k) => Array.isArray(targetByAccount[k]) && targetByAccount[k].length > 0
    )
    if (keys.length > 0) return keys.map((k) => normalizeAccountId(String(k)))
  }
  const targetAccountIds = rule?.targetAccountIds ?? rule?.target_account_ids
  const arr = Array.isArray(targetAccountIds) ? targetAccountIds : []
  if (arr.length > 0) {
    return [...new Set(arr.map((id) => normalizeAccountId(String(id || '').trim())).filter(Boolean))]
  }
  const primary = rule?.accountId ?? rule?.account_id
  if (primary != null && String(primary).trim() !== '') {
    return [normalizeAccountId(String(primary).trim())]
  }
  return []
}

function isTruthyEnabled(v) {
  return v === true || v === 1
}

/**
 * 将库行与 PUT/PATCH 增量合并为「保存后」快照（仅用于开闸判断）
 */
export function mergeRuleForEnableCheck(existing, updates) {
  const m = { ...existing, ...updates }
  const aid = m.accountId ?? m.account_id
  m.accountId = aid != null && String(aid).trim() !== '' ? String(aid).trim() : null
  return m
}

/**
 * @param {object} merged - mergeRuleForEnableCheck 结果
 * @param {{ isAdmin: boolean, ownerId: number|null }} ctx
 * @returns {Promise<{ ok: true } | { ok: false, error: string, code: string }>}
 */
export async function assertRuleReadyToEnable(merged, ctx) {
  const { isAdmin, ownerId } = ctx
  if (!isTruthyEnabled(merged.enabled)) {
    return { ok: true }
  }

  const conditions = merged.conditions
  const condCheck = validateConditionsStructure(conditions)
  if (!condCheck.valid) {
    return { ok: false, error: condCheck.error, code: 'INVALID_CONDITIONS' }
  }
  const logicOp = merged.logicOperator || 'AND'
  const normalizedForTw = normalizeConditionsToV2(conditions, logicOp)
  const twCheck = validateTimeWindowConsistency(normalizedForTw)
  if (!twCheck.valid) {
    return { ok: false, error: twCheck.error, code: 'INCONSISTENT_TIME_WINDOW' }
  }

  const actions = merged.actions
  if (!Array.isArray(actions)) {
    return { ok: false, error: 'actions 必须是数组', code: 'INVALID_ACTIONS' }
  }
  const actCheck = validateActions(actions)
  if (!actCheck.valid) {
    return { ok: false, error: actCheck.error, code: 'INVALID_ACTIONS' }
  }

  const accountIds = getRuleExecutionAccountIds(merged)
  if (accountIds.length === 0) {
    return {
      ok: false,
      error: '启用规则前须绑定至少一个有效广告账户（主账户或多账户列表）',
      code: 'ENABLE_MISSING_ACCOUNT'
    }
  }

  for (const fbId of accountIds) {
    if (!isAdmin) {
      if (!ownerId) {
        return {
          ok: false,
          error: '当前用户未绑定负责人(owner_id)，无法启用规则',
          code: 'MISSING_OWNER'
        }
      }
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1`,
        [fbId, ownerId]
      )
      if (rows.length === 0) {
        return {
          ok: false,
          error: `无权访问或未激活的广告账户 ${fbId}，无法启用规则`,
          code: 'ACCOUNT_FORBIDDEN'
        }
      }
    } else {
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1`,
        [fbId]
      )
      if (rows.length === 0) {
        return {
          ok: false,
          error: `广告账户 ${fbId} 不存在或未激活，无法启用规则`,
          code: 'ACCOUNT_NOT_FOUND'
        }
      }
    }
  }

  const uds = merged.useDynamicScope === true || merged.useDynamicScope === 1
  if (uds) {
    if (!isDynamicScopeFeatureEnabled()) {
      return {
        ok: false,
        error: '开启动态筛选时系统未开启该能力(ENABLE_DYNAMIC_SCOPE=false)',
        code: 'FEATURE_DISABLED'
      }
    }
    const sf = merged.scopeFilters ?? merged.scope_filters
    if (!sf || typeof sf !== 'object') {
      return {
        ok: false,
        error: '开启动态筛选时须配置有效的 scopeFilters',
        code: 'INVALID_DYNAMIC_SCOPE'
      }
    }
    const level = String(sf.level || merged.targetLevel || 'ad')
      .trim()
      .toLowerCase()
    if (!['ad', 'adset', 'campaign'].includes(level)) {
      return {
        ok: false,
        error: `scopeFilters.level 仅支持 ad/adset/campaign，当前: ${level}`,
        code: 'INVALID_DYNAMIC_SCOPE'
      }
    }
    if (!Array.isArray(sf.conditions)) {
      return {
        ok: false,
        error: 'scopeFilters.conditions 须为数组',
        code: 'INVALID_DYNAMIC_SCOPE'
      }
    }
  }

  return { ok: true }
}
