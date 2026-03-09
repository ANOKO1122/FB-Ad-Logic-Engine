import { DateTime } from 'luxon'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'

const DEFAULT_MAX_MATCHES =
  Number.isFinite(Number(process.env.DYNAMIC_SCOPE_DEFAULT_MAX_MATCHES))
    ? Math.max(1, Math.min(Number(process.env.DYNAMIC_SCOPE_DEFAULT_MAX_MATCHES), 5000))
    : 1000

const INSERT_CHUNK_SIZE =
  Number.isFinite(Number(process.env.DYNAMIC_SCOPE_INSERT_CHUNK))
    ? Math.max(50, Math.min(Number(process.env.DYNAMIC_SCOPE_INSERT_CHUNK), 1000))
    : 300

const TRIGGER_B_DEBOUNCE_MS =
  Number.isFinite(Number(process.env.DYNAMIC_SCOPE_TRIGGER_B_DEBOUNCE_MS))
    ? Math.max(1000, Math.min(Number(process.env.DYNAMIC_SCOPE_TRIGGER_B_DEBOUNCE_MS), 120000))
    : 15000

const triggerBTimers = new Map()

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return value
}

function getRuleTargetAccountIds(rule) {
  const targetByAccountRaw = rule?.targetByAccount ?? rule?.target_by_account
  const targetByAccount = parseJsonSafe(targetByAccountRaw, null)
  if (targetByAccount && typeof targetByAccount === 'object' && !Array.isArray(targetByAccount)) {
    const accounts = Object.keys(targetByAccount).filter((accountId) => {
      const arr = targetByAccount[accountId]
      return Array.isArray(arr) && arr.length > 0
    })
    if (accounts.length > 0) return accounts
  }

  const targetAccountIdsRaw = rule?.targetAccountIds ?? rule?.target_account_ids
  const targetAccountIds = parseJsonSafe(targetAccountIdsRaw, targetAccountIdsRaw)
  if (Array.isArray(targetAccountIds) && targetAccountIds.length > 0) {
    return targetAccountIds.map((id) => String(id || '').trim()).filter(Boolean)
  }

  const accountId = String(rule?.accountId ?? rule?.account_id ?? '').trim()
  return accountId ? [accountId] : []
}

function getScopedTargetIdsForAccount(rule, accountId) {
  const targetByAccountRaw = rule?.targetByAccount ?? rule?.target_by_account
  const targetByAccount = parseJsonSafe(targetByAccountRaw, null)
  if (targetByAccount && typeof targetByAccount === 'object' && !Array.isArray(targetByAccount) && accountId in targetByAccount) {
    const arr = targetByAccount[accountId]
    return Array.isArray(arr) ? arr.map((id) => String(id || '').trim()).filter(Boolean) : []
  }

  const rawTargetIds = rule?.targetIds ?? rule?.target_ids ?? []
  const parsedRaw = parseJsonSafe(rawTargetIds, rawTargetIds)
  const ids = Array.isArray(parsedRaw) ? parsedRaw.map((id) => String(id || '').trim()).filter(Boolean) : []
  const accountScoped = ids.filter((id) => id.startsWith(accountId + ':'))
  if (accountScoped.length > 0) {
    return accountScoped.map((s) => s.slice(s.indexOf(':') + 1)).filter(Boolean)
  }
  return ids
}

export function isDynamicScopeFeatureEnabled() {
  const raw = String(process.env.ENABLE_DYNAMIC_SCOPE ?? 'true').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function buildStructureFilter(scopeFilters, accountId, nowUtc) {
  if (!scopeFilters || typeof scopeFilters !== 'object') {
    throw new Error('INVALID_FILTER_EMPTY')
  }
  const level = scopeFilters.level
  if (!['ad', 'adset', 'campaign'].includes(level)) {
    throw new Error('INVALID_LEVEL')
  }
  const conditions = Array.isArray(scopeFilters.conditions)
    ? scopeFilters.conditions
    : []

  const clauses = ['account_id = ?']
  const params = [accountId]

  const now = nowUtc || DateTime.utc()

  for (const cond of conditions) {
    if (!cond || typeof cond !== 'object') continue
    const field = cond.field
    const op = cond.op || cond.operator
    const val = cond.value

    if (field === 'effective_status') {
      if (!Array.isArray(val) || val.length === 0) continue
      const placeholders = val.map(() => '?').join(',')
      if (op === 'in' || !op) {
        clauses.push(`effective_status IN (${placeholders})`)
      } else if (op === 'not_in') {
        clauses.push(`effective_status NOT IN (${placeholders})`)
      } else {
        throw new Error('INVALID_FILTER_OPERATOR_STATUS')
      }
      params.push(...val)
    } else if (field === 'name') {
      if (typeof val !== 'string' || !val.trim()) continue
      if (op === 'contains' || !op) {
        clauses.push('name LIKE ?')
        params.push(`%${val.trim()}%`)
      } else if (op === 'not_contains') {
        clauses.push('(name NOT LIKE ? OR name IS NULL)')
        params.push(`%${val.trim()}%`)
      } else {
        throw new Error('INVALID_FILTER_OPERATOR_NAME')
      }
    } else if (field === 'created_time') {
      const hours = Number(val)
      if (!Number.isFinite(hours) || hours <= 0) continue
      const threshold = now.minus({ hours }).toUTC().toISO()
      clauses.push('created_time IS NOT NULL AND created_time >= ?')
      params.push(threshold)
    } else {
      throw new Error('INVALID_FILTER_FIELD')
    }
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { level, whereSql, params }
}

async function expandManualTargetIdsToAdLevel(accountId, rule) {
  const result = new Set()
  const level = rule.targetLevel || rule.target_level
  const ids = getScopedTargetIdsForAccount(rule, accountId)
  if (!level || ids.length === 0) return result

  if (level === 'ad') {
    ids.forEach((id) => result.add(id))
    return result
  }

  const filterColumn = level === 'adset' ? 'adset_id' : 'campaign_id'
  const placeholders = ids.map(() => '?').join(',')
  const sql = `
    SELECT DISTINCT ad_id
    FROM structure_ads
    WHERE account_id = ?
      AND ${filterColumn} IN (${placeholders})
  `
  const params = [accountId, ...ids]
  const [rows] = await pool.execute(sql, params)
  for (const row of rows || []) {
    const id = String(row.ad_id || '').trim()
    if (id) result.add(id)
  }
  return result
}

async function expandExcludeIdsToAdLevel(accountId, excludeIds) {
  const result = new Set()
  if (!excludeIds || typeof excludeIds !== 'object') return result

  const campaignIds = Array.isArray(excludeIds.campaign_ids)
    ? excludeIds.campaign_ids.map((id) => String(id)).filter(Boolean)
    : []
  const adsetIds = Array.isArray(excludeIds.adset_ids)
    ? excludeIds.adset_ids.map((id) => String(id)).filter(Boolean)
    : []
  const adIds = Array.isArray(excludeIds.ad_ids)
    ? excludeIds.ad_ids.map((id) => String(id)).filter(Boolean)
    : []

  adIds.forEach((id) => result.add(id))

  if (adsetIds.length > 0) {
    const placeholders = adsetIds.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND adset_id IN (${placeholders})`,
      [accountId, ...adsetIds]
    )
    for (const row of rows || []) {
      const id = String(row.ad_id || '').trim()
      if (id) result.add(id)
    }
  }

  if (campaignIds.length > 0) {
    const placeholders = campaignIds.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND campaign_id IN (${placeholders})`,
      [accountId, ...campaignIds]
    )
    for (const row of rows || []) {
      const id = String(row.ad_id || '').trim()
      if (id) result.add(id)
    }
  }

  return result
}

async function calculateMatchedAdIdsForRule(accountId, rule, nowUtc) {
  const now = nowUtc || DateTime.utc()
  const dynamicSet = new Set()
  const manualSet = await expandManualTargetIdsToAdLevel(accountId, rule)
  const excludeSet = await expandExcludeIdsToAdLevel(accountId, rule.excludeIds || rule.exclude_ids)

  if (rule.useDynamicScope || rule.use_dynamic_scope) {
    const scopeFilters = rule.scopeFilters || rule.scope_filters
    let filter
    try {
      filter = buildStructureFilter(scopeFilters, accountId, now)
    } catch (e) {
      return {
        status: 'ERROR_FILTER_INVALID',
        errorMsg: e.message || 'invalid scopeFilters',
        finalAdIds: null
      }
    }

    const { level, whereSql, params } = filter
    if (level === 'ad') {
      const [rows] = await pool.execute(
        `SELECT DISTINCT ad_id FROM structure_ads ${whereSql}`,
        params
      )
      for (const row of rows || []) {
        const id = String(row.ad_id || '').trim()
        if (id) dynamicSet.add(id)
      }
    } else if (level === 'adset') {
      const [adsetRows] = await pool.execute(
        `SELECT DISTINCT adset_id FROM structure_adsets ${whereSql}`,
        params
      )
      const adsetIds = (adsetRows || [])
        .map((r) => String(r.adset_id || '').trim())
        .filter(Boolean)
      if (adsetIds.length > 0) {
        const placeholders = adsetIds.map(() => '?').join(',')
        const [rows] = await pool.execute(
          `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND adset_id IN (${placeholders})`,
          [accountId, ...adsetIds]
        )
        for (const row of rows || []) {
          const id = String(row.ad_id || '').trim()
          if (id) dynamicSet.add(id)
        }
      }
    } else if (level === 'campaign') {
      const [campRows] = await pool.execute(
        `SELECT DISTINCT campaign_id FROM structure_campaigns ${whereSql}`,
        params
      )
      const campaignIds = (campRows || [])
        .map((r) => String(r.campaign_id || '').trim())
        .filter(Boolean)
      if (campaignIds.length > 0) {
        const placeholders = campaignIds.map(() => '?').join(',')
        const [rows] = await pool.execute(
          `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND campaign_id IN (${placeholders})`,
          [accountId, ...campaignIds]
        )
        for (const row of rows || []) {
          const id = String(row.ad_id || '').trim()
          if (id) dynamicSet.add(id)
        }
      }
    }
  }

  const union = new Set([...dynamicSet, ...manualSet])
  const finalAdIds = []
  for (const id of union) {
    if (!excludeSet.has(id)) finalAdIds.push(id)
  }

  const max = rule.maxDynamicMatches ?? rule.max_dynamic_matches ?? DEFAULT_MAX_MATCHES
  const safeMax = Number.isFinite(Number(max)) ? Math.max(1, Math.min(Number(max), 5000)) : DEFAULT_MAX_MATCHES

  if (finalAdIds.length > safeMax) {
    return {
      status: 'ERROR_OVERSIZE',
      errorMsg: `matched ${finalAdIds.length} ads, exceed max_dynamic_matches=${safeMax}`,
      finalAdIds: null
    }
  }

  return {
    status: 'NORMAL',
    errorMsg: null,
    finalAdIds
  }
}

async function refreshDynamicTargetsForRulesInAccount(accountId, rules, options = {}) {
  const nowUtc = DateTime.utc()
  const start = Date.now()
  const trigger = options.trigger || 'manual'
  const skipRuleStatusUpdate = options.skipRuleStatusUpdate === true
  if (!Array.isArray(rules) || rules.length === 0) {
    logger.info(`[DynamicScope] trigger=${trigger} account=${accountId} 无 use_dynamic_scope=1 的规则，跳过刷新`)
    return { accountId, trigger, rules: 0, processed: 0, normal: 0, updated: 0, oversize: 0, invalid: 0, refreshFailed: 0, durationMs: 0 }
  }

  const perRule = []
  let normalCount = 0
  let oversizeCount = 0
  let invalidCount = 0
  let refreshFailedCount = 0

  for (const rule of rules) {
    try {
      const result = await calculateMatchedAdIdsForRule(accountId, rule, nowUtc)
      perRule.push({ ruleId: rule.id, ...result })
      if (result.status === 'NORMAL') normalCount++
      if (result.status === 'ERROR_OVERSIZE') oversizeCount++
      if (result.status === 'ERROR_FILTER_INVALID') invalidCount++
    } catch (e) {
      perRule.push({
        ruleId: rule.id,
        status: 'ERROR_REFRESH_FAILED',
        errorMsg: e.message || 'refresh failed',
        finalAdIds: null
      })
      refreshFailedCount++
    }
  }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // 策略 B（保留上一版快照）：
    // - 仅对 status=NORMAL 的规则做「按 rule 维度原子替换」；
    // - ERROR_OVERSIZE / ERROR_FILTER_INVALID / ERROR_REFRESH_FAILED 仅更新 rules 状态，不动旧快照。
    let inserted = 0
    for (const r of perRule) {
      if (r.status !== 'NORMAL') continue
      await connection.execute(
        `DELETE FROM rule_matched_objects WHERE account_id = ? AND rule_id = ?`,
        [accountId, r.ruleId]
      )
      if (!Array.isArray(r.finalAdIds) || r.finalAdIds.length === 0) continue
      const batch = r.finalAdIds
      for (let i = 0; i < batch.length; i += INSERT_CHUNK_SIZE) {
        const chunk = batch.slice(i, i + INSERT_CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '(?,?,?,?,NOW())').join(',')
        const params = []
        for (const adId of chunk) {
          params.push(r.ruleId, accountId, adId, 'ad')
        }
        await connection.execute(
          `INSERT INTO rule_matched_objects
             (rule_id, account_id, object_id, object_type, created_at)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)`,
          params
        )
        inserted += chunk.length
      }
    }

    const updateIds = []
    for (const r of perRule) {
      updateIds.push(r.ruleId)
    }
    if (!skipRuleStatusUpdate && updateIds.length > 0) {
      const statusCase = updateIds.map((id, idx) => `WHEN id = ? THEN ?`).join(' ')
      const errorCase = updateIds.map((id, idx) => `WHEN id = ? THEN ?`).join(' ')
      const params = []
      for (let i = 0; i < updateIds.length; i++) {
        const ruleId = updateIds[i]
        const status = perRule[i].status
        params.push(ruleId, status)
      }
      for (let i = 0; i < updateIds.length; i++) {
        const ruleId = updateIds[i]
        const msg = perRule[i].errorMsg || null
        params.push(ruleId, msg)
      }
      const idsParams = updateIds
      await connection.execute(
        `
        UPDATE rules
        SET dynamic_scope_status = CASE ${statusCase} ELSE dynamic_scope_status END,
            dynamic_scope_error_msg = CASE ${errorCase} ELSE dynamic_scope_error_msg END,
            dynamic_scope_updated_at = NOW()
        WHERE id IN (${idsParams.map(() => '?').join(',')})
        `,
        [...params, ...idsParams]
      )
    }

    await connection.commit()
    const durationMs = Date.now() - start
    logger.info(
      `[DynamicScope] trigger=${trigger} account=${accountId} processed=${rules.length} normal=${normalCount} inserted=${inserted} oversize=${oversizeCount} invalid=${invalidCount} refresh_failed=${refreshFailedCount} duration_ms=${durationMs}`
    )
    return {
      accountId,
      trigger,
      rules: rules.length,
      processed: rules.length,
      normal: normalCount,
      updated: inserted,
      oversize: oversizeCount,
      invalid: invalidCount,
      refreshFailed: refreshFailedCount,
      durationMs
    }
  } catch (e) {
    await connection.rollback()
    logger.error(`[DynamicScope] trigger=${trigger} account=${accountId} 刷新失败: ${e.message}`)
    throw e
  } finally {
    connection.release()
  }
}

async function fetchDynamicScopeRulesForAccount(accountId) {
  const [ruleRows] = await pool.execute(
    `SELECT *
     FROM rules
     WHERE use_dynamic_scope = 1
       AND enabled = 1
       AND (
         account_id = ?
         OR JSON_SEARCH(target_account_ids, 'one', ?) IS NOT NULL
       )`,
    [accountId, accountId]
  )
  return (ruleRows || []).filter((rule) => getRuleTargetAccountIds(rule).includes(accountId))
}

export async function refreshDynamicTargetsForAccount(accountId, options = {}) {
  const trigger = options.trigger || 'manual'
  const rules = await fetchDynamicScopeRulesForAccount(accountId)
  return refreshDynamicTargetsForRulesInAccount(accountId, rules, { trigger })
}

export async function refreshDynamicTargetsForRule(ruleId, options = {}) {
  const trigger = options.trigger || 'manual'
  const id = Number(ruleId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('INVALID_RULE_ID')
  }
  const [rows] = await pool.execute(
    `SELECT * FROM rules WHERE id = ? LIMIT 1`,
    [id]
  )
  const rule = rows?.[0]
  if (!rule) throw new Error('RULE_NOT_FOUND')
  if (!Number(rule.use_dynamic_scope)) {
    return { ruleId: id, trigger, processedAccounts: 0, accountResults: [], message: 'RULE_DYNAMIC_SCOPE_DISABLED' }
  }
  if (!Number(rule.enabled)) {
    return { ruleId: id, trigger, processedAccounts: 0, accountResults: [], message: 'RULE_DISABLED' }
  }

  const accountIds = [...new Set(getRuleTargetAccountIds(rule))]
  const accountResults = []
  for (const accountId of accountIds) {
    const result = await refreshDynamicTargetsForRulesInAccount(accountId, [rule], { trigger, skipRuleStatusUpdate: true })
    accountResults.push(result)
  }

  // 规则级状态为多账户聚合结果（每账户仍按快照独立写入）
  const hasRefreshFailed = accountResults.some((r) => Number(r.refreshFailed || 0) > 0)
  const hasInvalid = accountResults.some((r) => Number(r.invalid || 0) > 0)
  const hasOversize = accountResults.some((r) => Number(r.oversize || 0) > 0)
  let finalStatus = 'NORMAL'
  let finalErrorMsg = null
  if (hasRefreshFailed) {
    finalStatus = 'ERROR_REFRESH_FAILED'
    finalErrorMsg = 'one or more accounts refresh failed'
  } else if (hasInvalid) {
    finalStatus = 'ERROR_FILTER_INVALID'
    finalErrorMsg = 'one or more accounts filter invalid'
  } else if (hasOversize) {
    finalStatus = 'ERROR_OVERSIZE'
    finalErrorMsg = 'one or more accounts exceed max_dynamic_matches'
  }
  await pool.execute(
    `UPDATE rules
     SET dynamic_scope_status = ?,
         dynamic_scope_error_msg = ?,
         dynamic_scope_updated_at = NOW()
     WHERE id = ?`,
    [finalStatus, finalErrorMsg, id]
  )

  return {
    ruleId: id,
    trigger,
    processedAccounts: accountResults.length,
    accountResults,
    status: finalStatus,
    errorMsg: finalErrorMsg
  }
}

export function scheduleDynamicScopeRefresh(accountId, options = {}) {
  if (!accountId) return
  if (!isDynamicScopeFeatureEnabled()) return
  const trigger = options.trigger || 'rule_saved'
  const key = String(accountId)
  const old = triggerBTimers.get(key)
  if (old) clearTimeout(old)

  const timer = setTimeout(async () => {
    triggerBTimers.delete(key)
    try {
      logger.info(`[DynamicScope] trigger=${trigger} account=${key} 防抖到期，开始异步刷新`)
      await refreshDynamicTargetsForAccount(key, { trigger })
    } catch (e) {
      logger.warn(`[DynamicScope] trigger=${trigger} account=${key} 异步刷新失败: ${e.message}`)
    }
  }, TRIGGER_B_DEBOUNCE_MS)

  triggerBTimers.set(key, timer)
}

export async function scheduleDynamicScopeRefreshForRule(ruleId, options = {}) {
  if (!isDynamicScopeFeatureEnabled()) return
  const id = Number(ruleId)
  if (!Number.isFinite(id) || id <= 0) return
  const [rows] = await pool.execute(
    `SELECT * FROM rules WHERE id = ? LIMIT 1`,
    [id]
  )
  const rule = rows?.[0]
  if (!rule || !Number(rule.use_dynamic_scope)) return
  const accountIds = getRuleTargetAccountIds(rule)
  for (const accountId of accountIds) {
    scheduleDynamicScopeRefresh(accountId, options)
  }
}

export const _internals = {
  buildStructureFilter,
  getRuleTargetAccountIds,
  getScopedTargetIdsForAccount,
  expandManualTargetIdsToAdLevel,
  expandExcludeIdsToAdLevel,
  calculateMatchedAdIdsForRule
}

