import { DateTime } from 'luxon'
import crypto from 'crypto'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { normalizeAccountId } from '../utils/targetIdUtils.js'
import { insertRuleHistory } from './ruleHistoryService.js'

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

/**
 * M2 typed snapshot: 根据规则 targetLevel 确定快照输出时的 object_type
 * @param {Object} rule
 * @returns {string} 'ad' | 'adset' | 'campaign'
 */
function getRuleOutputObjectType(rule) {
  const level = (rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()
  if (level === 'adset') return 'adset'
  if (level === 'campaign') return 'campaign'
  return 'ad'
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return value
}

/**
 * 归一化复合 ID：保证 accountId 仅一层 act_ 前缀，返回 act_xxx:objId。
 * 约定：执行/预览路径返回或写入的复合 ID 均经此生成，见 docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md
 */
function normalizeCompositeId(accountId, objId) {
  const cleanAccountId = normalizeAccountId(accountId || '')
  return `${cleanAccountId}:${String(objId || '').trim()}`
}

/**
 * 规则在「动态范围刷新」路径上的适用账户全集（去重、归一化后排序）。
 * Applicable accounts for dynamic scope refresh: union of three sources, deduped, normalized.
 *
 * 来源并集：(1) target_by_account 中数组长度 > 0 的 key；(2) target_account_ids；(3) rules.account_id。
 * fetch / refresh / schedule 均依赖此集合；不得在有 target_by_account 时丢弃 target_account_ids。
 */
function getRuleTargetAccountIds(rule) {
  const ids = new Set()

  /** @param {unknown} raw trim 后经 normalizeAccountId 写入集合 */
  const addAccount = (raw) => {
    const n = normalizeAccountId(String(raw ?? '').trim())
    if (n) ids.add(n)
  }

  // (1) 按户配置过非空手动物体列表的账户
  const targetByAccountRaw = rule?.targetByAccount ?? rule?.target_by_account
  const targetByAccount = parseJsonSafe(targetByAccountRaw, null)
  if (targetByAccount && typeof targetByAccount === 'object' && !Array.isArray(targetByAccount)) {
    for (const accountId of Object.keys(targetByAccount)) {
      const arr = targetByAccount[accountId]
      if (Array.isArray(arr) && arr.length > 0) {
        addAccount(accountId)
      }
    }
  }

  // (2) 多账户名单
  const targetAccountIdsRaw = rule?.targetAccountIds ?? rule?.target_account_ids
  const targetAccountIds = parseJsonSafe(targetAccountIdsRaw, targetAccountIdsRaw)
  if (Array.isArray(targetAccountIds)) {
    for (const id of targetAccountIds) {
      addAccount(id)
    }
  }

  // (3) 主归属账户
  addAccount(rule?.accountId ?? rule?.account_id)

  return Array.from(ids).sort((a, b) => a.localeCompare(b))
}

function getScopedTargetIdsForAccount(rule, accountId) {
  const rawTargetIds = rule?.targetIds ?? rule?.target_ids ?? []
  const parsedRaw = parseJsonSafe(rawTargetIds, rawTargetIds)
  const ids = Array.isArray(parsedRaw) ? parsedRaw.map((id) => String(id || '').trim()).filter(Boolean) : []
  const normalizedAccountId = normalizeAccountId(accountId)
  const fromTargetIds = []
  for (const compositeId of ids) {
    const idx = compositeId.indexOf(':')
    if (idx <= 0 || idx === compositeId.length - 1) continue
    const prefix = compositeId.slice(0, idx)
    const objId = compositeId.slice(idx + 1).trim()
    if (normalizeAccountId(prefix) === normalizedAccountId && objId) {
      fromTargetIds.push(objId)
    }
  }
  if (fromTargetIds.length > 0) {
    return [...new Set(fromTargetIds)]
  }
  const targetByAccountRaw = rule?.targetByAccount ?? rule?.target_by_account
  const targetByAccount = parseJsonSafe(targetByAccountRaw, null)
  if (targetByAccount && typeof targetByAccount === 'object' && !Array.isArray(targetByAccount) && accountId in targetByAccount) {
    const arr = targetByAccount[accountId]
    return Array.isArray(arr) ? arr.map((id) => String(id || '').trim()).filter(Boolean) : []
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
      if (op === 'within_hours' || !op) {
        // 现有：最近 N 小时内 → created_time >= now - N hours
        const hours = Number(val)
        if (!Number.isFinite(hours) || hours <= 0) continue
        const threshold = now.minus({ hours }).toUTC().toISO()
        clauses.push('created_time IS NOT NULL AND created_time >= ?')
        params.push(threshold)
      } else if (op === 'older_than_hours') {
        // 新增：XX 小时以前 → created_time <= now - N hours
        const hours = Number(val)
        if (!Number.isFinite(hours) || hours <= 0) continue
        const threshold = now.minus({ hours }).toUTC().toISO()
        clauses.push('created_time IS NOT NULL AND created_time <= ?')
        params.push(threshold)
      } else if (op === 'between_hours') {
        // 新增：X 小时以上（超过 X）、Y 小时以内（未超过 Y）
        // value 为 [fromHours, toHours]，fromHours < toHours
        // 例: [24, 72] → created_time BETWEEN now-72h AND now-24h
        const arr = Array.isArray(val) ? val : []
        const fromHours = Number(arr[0])
        const toHours = Number(arr[1])
        if (!Number.isFinite(fromHours) || !Number.isFinite(toHours) || fromHours <= 0 || toHours <= 0 || fromHours >= toHours) continue
        const lowerBound = now.minus({ hours: toHours }).toUTC().toISO()    // 更早: now - 72h
        const upperBound = now.minus({ hours: fromHours }).toUTC().toISO()  // 更近: now - 24h
        clauses.push('created_time IS NOT NULL AND created_time >= ? AND created_time <= ?')
        params.push(lowerBound, upperBound)
      } else {
        throw new Error('INVALID_FILTER_OPERATOR_CREATED_TIME')
      }
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

async function mapAdIdsToTargetObjectIds(accountId, targetLevel, adIds) {
  const safeLevel = (targetLevel || 'ad').toLowerCase()
  const safeAdIds = [...new Set((adIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (safeLevel === 'ad') return safeAdIds
  if (safeAdIds.length === 0) return []
  const selectColumn = safeLevel === 'adset' ? 'adset_id' : 'campaign_id'
  const placeholders = safeAdIds.map(() => '?').join(',')
  const [rows] = await pool.execute(
    `SELECT DISTINCT ${selectColumn} AS object_id
     FROM structure_ads
     WHERE account_id = ?
       AND ad_id IN (${placeholders})`,
    [accountId, ...safeAdIds]
  )
  return [...new Set((rows || []).map((row) => String(row.object_id || '').trim()).filter(Boolean))]
}

async function calculateMatchedObjectIdsForRule(accountId, rule, nowUtc) {
  const now = nowUtc || DateTime.utc()
  const targetLevel = (rule.targetLevel || rule.target_level || 'ad').toLowerCase()
  const dynamicSet = new Set()
  const manualSet = await expandManualTargetIdsToAdLevel(accountId, rule)
  const excludeSet = await expandExcludeIdsToAdLevel(accountId, rule.excludeIds || rule.exclude_ids)
  /** 有 scope_filters 时仅用 dynamicSet 作为作用范围，不并 manualSet（做法 A：开启动态禁手动目标） */
  let scopeOnlyForUnion = false

  if (rule.useDynamicScope || rule.use_dynamic_scope) {
    const scopeFilters = rule.scopeFilters || rule.scope_filters
    // 1.1 实质性范围条件：无 conditions 或 conditions 为空视为未配置，避免空条件误选全量
    const conditions = Array.isArray(scopeFilters?.conditions) ? scopeFilters.conditions : []
    if (conditions.length === 0) {
      return {
        status: 'ERROR_FILTER_INVALID',
        errorMsg: 'scope_filters.conditions 不能为空',
        finalObjectIds: null,
        dynamicCount: 0,
        manualCount: manualSet.size
      }
    }
    let filter
    try {
      filter = buildStructureFilter(scopeFilters, accountId, now)
    } catch (e) {
      return {
        status: 'ERROR_FILTER_INVALID',
        errorMsg: e.message || 'invalid scopeFilters',
        finalObjectIds: null,
        dynamicCount: 0,
        manualCount: manualSet.size
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
    scopeOnlyForUnion = true
  }

  const union = scopeOnlyForUnion ? new Set(dynamicSet) : new Set([...dynamicSet, ...manualSet])
  const finalAdIds = []
  for (const id of union) {
    if (!excludeSet.has(id)) finalAdIds.push(id)
  }
  const dynamicAdIds = [...dynamicSet].filter((id) => !excludeSet.has(id))
  const manualAdIds = [...manualSet].filter((id) => !excludeSet.has(id))
  const finalObjectIds = await mapAdIdsToTargetObjectIds(accountId, targetLevel, finalAdIds)
  const dynamicObjectIds = await mapAdIdsToTargetObjectIds(accountId, targetLevel, dynamicAdIds)
  const manualObjectIds = await mapAdIdsToTargetObjectIds(accountId, targetLevel, manualAdIds)

  const max = rule.maxDynamicMatches ?? rule.max_dynamic_matches ?? DEFAULT_MAX_MATCHES
  const safeMax = Number.isFinite(Number(max)) ? Math.max(1, Math.min(Number(max), 5000)) : DEFAULT_MAX_MATCHES

  if (finalObjectIds.length > safeMax) {
    return {
      status: 'ERROR_OVERSIZE',
      errorMsg: `matched ${finalObjectIds.length} objects, exceed max_dynamic_matches=${safeMax}`,
      finalObjectIds: null,
      dynamicCount: dynamicSet.size,
      manualCount: manualSet.size
    }
  }

  return {
    status: 'NORMAL',
    errorMsg: null,
    finalObjectIds,
    dynamicCount: dynamicObjectIds.length,
    manualCount: manualObjectIds.length
  }
}

/**
 * 预览动态范围：对给定账户列表 + 监控条件 + 排除名单，按与规则刷新一致逻辑算出全量对象ID，返回 act_xxx:id 数组。
 * 内部仅调用 calculateMatchedObjectIdsForRule，不新增 SQL；与规则执行共用同一时间基准（UTC now）。
 *
 * @param {string[]|string} accountIds - 广告账户 ID 列表（或逗号分隔字符串）
 * @param {object} options
 * @param {object} options.scopeFilters - 与规则表一致：{ level, conditions: [{ field, op/operator, value }] }
 * @param {object} [options.excludeIds] - { ad_ids, adset_ids, campaign_ids } 字符串数组，与 expandExcludeIdsToAdLevel 一致
 * @param {string} [options.targetLevel='ad'] - 'ad' | 'adset' | 'campaign'
 * @param {number} [options.maxDynamicMatches] - 与规则表上限一致，默认使用 DEFAULT_MAX_MATCHES
 * @returns {Promise<{ object_ids: string[], count: number, per_account?: Record<string, { status: string, errorMsg?: string }> }>}
 */
export async function previewDynamicScope(accountIds, options) {
  const ids = Array.isArray(accountIds)
    ? accountIds.map((id) => String(id || '').trim()).filter(Boolean)
    : String(accountIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const accountList = [...new Set(ids)]
  if (accountList.length === 0) {
    return { object_ids: [], count: 0 }
  }

  const rawExclude = options?.excludeIds ?? options?.exclude_ids ?? null
  const excludeIds = !rawExclude || typeof rawExclude !== 'object'
    ? { ad_ids: [], adset_ids: [], campaign_ids: [] }
    : {
        ad_ids: Array.isArray(rawExclude.ad_ids) ? rawExclude.ad_ids.map((id) => String(id)).filter(Boolean) : [],
        adset_ids: Array.isArray(rawExclude.adset_ids) ? rawExclude.adset_ids.map((id) => String(id)).filter(Boolean) : [],
        campaign_ids: Array.isArray(rawExclude.campaign_ids) ? rawExclude.campaign_ids.map((id) => String(id)).filter(Boolean) : []
      }

  const scopeFilters = options?.scopeFilters ?? options?.scope_filters ?? null
  const targetLevel = options?.targetLevel ?? options?.target_level ?? 'ad'
  const maxDynamicMatches = options?.maxDynamicMatches ?? options?.max_dynamic_matches ?? DEFAULT_MAX_MATCHES

  const nowUtc = DateTime.utc()
  const virtualRule = {
    useDynamicScope: true,
    use_dynamic_scope: true,
    scopeFilters,
    scope_filters: scopeFilters,
    excludeIds,
    exclude_ids: excludeIds,
    targetLevel,
    target_level: targetLevel,
    maxDynamicMatches,
    max_dynamic_matches: maxDynamicMatches,
    targetIds: [],
    target_ids: [],
    targetByAccount: {},
    target_by_account: {}
  }
  if (logger.debug) {
    logger.debug('[DynamicScope] preview virtualRule keys: ' + Object.keys(virtualRule).join(','))
  }

  const objectIds = []
  const perAccount = {}

  for (const accountId of accountList) {
    try {
      const result = await calculateMatchedObjectIdsForRule(accountId, virtualRule, nowUtc)
      if (result.status === 'NORMAL' && Array.isArray(result.finalObjectIds) && result.finalObjectIds.length > 0) {
        for (const objectId of result.finalObjectIds) {
          objectIds.push(normalizeCompositeId(accountId, objectId))
        }
      } else if (result.status && result.status !== 'NORMAL') {
        perAccount[accountId] = { status: result.status, errorMsg: result.errorMsg ?? undefined }
      }
    } catch (err) {
      perAccount[accountId] = { status: 'ERROR_REFRESH_FAILED', errorMsg: err.message }
    }
  }

  return {
    object_ids: objectIds,
    count: objectIds.length,
    ...(Object.keys(perAccount).length > 0 ? { per_account: perAccount } : {})
  }
}

/**
 * 按账户刷新多条规则的动态匹配快照（rule_matched_objects + history + rules.dynamic_scope_status）。
 * 事务约定：仅写快照表与状态，不回写 rules.target_ids；commit 成功后才视为刷新成功。
 * 职责解耦：rules 为「合同」，rule_matched_objects 为「工单」，见 docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md
 */
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
      const result = await calculateMatchedObjectIdsForRule(accountId, rule, nowUtc)
      perRule.push({ ruleId: rule.id, ...result })
      if (result.status === 'NORMAL') normalCount++
      if (result.status === 'ERROR_OVERSIZE') oversizeCount++
      if (result.status === 'ERROR_FILTER_INVALID') invalidCount++
    } catch (e) {
      perRule.push({
        ruleId: rule.id,
        status: 'ERROR_REFRESH_FAILED',
        errorMsg: e.message || 'refresh failed',
        finalObjectIds: null
      })
      refreshFailedCount++
    }
  }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // 上一份 ID 集合：在 DELETE 之前读取，用于 rule_matched_objects_history 的 diff（方案 P1）
    const normalRuleIds = perRule.filter((r) => r.status === 'NORMAL').map((r) => r.ruleId)
    const oldIdsByRule = new Map()
    if (normalRuleIds.length > 0) {
      const placeholders = normalRuleIds.map(() => '?').join(',')
      const [oldRows] = await connection.execute(
        `SELECT rule_id, object_id, object_type FROM rule_matched_objects WHERE account_id = ? AND rule_id IN (${placeholders})`,
        [accountId, ...normalRuleIds]
      )
      for (const row of oldRows || []) {
        const rid = row.rule_id
        if (!oldIdsByRule.has(rid)) oldIdsByRule.set(rid, new Set())
        // M2 composite key: objectType:objectId 避免跨层冲突
        oldIdsByRule.get(rid).add(`${String(row.object_type || 'ad')}:${String(row.object_id || '').trim()}`)
      }
    }

    // 策略 B（Fail-Closed）：
    // - 仅 ERROR_FILTER_INVALID 时清空该规则该账户快照（配置无效，旧快照无意义）；
    // - ERROR_OVERSIZE / ERROR_REFRESH_FAILED 保留旧快照；
    // - NORMAL 时原子替换（DELETE 后 INSERT）。
    for (const r of perRule) {
      if (r.status === 'ERROR_FILTER_INVALID') {
        await connection.execute(
          `DELETE FROM rule_matched_objects WHERE account_id = ? AND rule_id = ?`,
          [accountId, r.ruleId]
        )
      }
    }
    // 构建 ruleId -> rule 的快速查找 Map，避免循环内每次 find
    const ruleById = new Map()
    for (const rule of rules) {
      ruleById.set(rule.id, rule)
    }

    let inserted = 0
    for (const r of perRule) {
      if (r.status !== 'NORMAL') continue
      await connection.execute(
        `DELETE FROM rule_matched_objects WHERE account_id = ? AND rule_id = ?`,
        [accountId, r.ruleId]
      )
      if (!Array.isArray(r.finalObjectIds) || r.finalObjectIds.length === 0) continue
      const ruleForItem = ruleById.get(r.ruleId)
      const objectType = ruleForItem ? getRuleOutputObjectType(ruleForItem) : getRuleOutputObjectType(rules[rules.length - 1])
      const batch = r.finalObjectIds
      for (let i = 0; i < batch.length; i += INSERT_CHUNK_SIZE) {
        const chunk = batch.slice(i, i + INSERT_CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '(?,?,?,?,NOW())').join(',')
        const params = []
        for (const objId of chunk) {
          params.push(r.ruleId, accountId, objId, objectType)
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

    // rule_matched_objects_history：仅变动时写入，同一事务内（方案 P1）
    const SNAPSHOT_MAX_FULL = 200
    const SNAPSHOT_MAX_NARROW = 100
    const LARGE_LIST_THRESHOLD = 500
    for (const r of perRule) {
      if (r.status !== 'NORMAL') continue
      const ruleForItem = ruleById.get(r.ruleId)
      const objectType = ruleForItem ? getRuleOutputObjectType(ruleForItem) : getRuleOutputObjectType(rules[rules.length - 1])
      const oldSet = oldIdsByRule.get(r.ruleId) || new Set()
      const newIds = Array.isArray(r.finalObjectIds) ? r.finalObjectIds : []
      // M2: 使用 composite key objectType:objectId 进行比较，避免跨层冲突
      const newSet = new Set(newIds.map((id) => `${objectType}:${String(id).trim()}`).filter(Boolean))
      const added = [...newSet].filter((id) => !oldSet.has(id))
      const removed = [...oldSet].filter((id) => !newSet.has(id))
      const addedCount = added.length
      const removedCount = removed.length
      if (addedCount === 0 && removedCount === 0) continue

      const objectCount = newIds.length
      let objectIdsSnapshot = null
      let objectIdsChecksum = null
      if (objectCount <= LARGE_LIST_THRESHOLD) {
        objectIdsSnapshot = newIds.slice(0, SNAPSHOT_MAX_FULL)
      } else {
        objectIdsSnapshot = newIds.slice(0, SNAPSHOT_MAX_NARROW)
        const sorted = [...newIds].sort()
        objectIdsChecksum = crypto.createHash('md5').update(sorted.join(',')).digest('hex')
      }

      const dynamicCount = r.dynamicCount != null ? r.dynamicCount : null
      const manualCount = r.manualCount != null ? r.manualCount : null
      await connection.execute(
        `INSERT INTO rule_matched_objects_history
         (rule_id, account_id, refreshed_at, trigger_type, object_count, manual_count, dynamic_count, added_count, removed_count, object_ids_snapshot, object_ids_checksum)
         VALUES (?, ?, NOW(6), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.ruleId,
          accountId,
          trigger,
          objectCount,
          manualCount,
          dynamicCount,
          addedCount,
          removedCount,
          objectIdsSnapshot != null ? JSON.stringify(objectIdsSnapshot) : null,
          objectIdsChecksum
        ]
      )
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
      for (const rid of updateIds) {
        try {
          await insertRuleHistory({
            ruleId: rid,
            changeType: 'SYSTEM_REFRESH',
            source: 'dynamic_scope_refresh',
            changedByUserId: null,
            changedByOwnerId: null,
            ruleSnapshot: null,
            snapshotBefore: null,
            connection
          })
        } catch (e) {
          logger.warn('[rule_history] SYSTEM_REFRESH batch insert failed', { ruleId: rid, err: e.message })
        }
      }
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

  // 删除该规则下已不在目标账户列表中的快照行，避免「目标账户缩小」后残留旧数据导致 matched_count 虚高
  if (accountIds.length > 0) {
    const placeholders = accountIds.map(() => '?').join(',')
    await pool.execute(
      `DELETE FROM rule_matched_objects WHERE rule_id = ? AND account_id NOT IN (${placeholders})`,
      [id, ...accountIds]
    )
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
  try {
    await insertRuleHistory({
      ruleId: id,
      changeType: 'SYSTEM_REFRESH',
      source: 'dynamic_scope_refresh',
      changedByUserId: null,
      changedByOwnerId: null,
      ruleSnapshot: null,
      snapshotBefore: null
    })
  } catch (e) {
    logger.warn('[rule_history] SYSTEM_REFRESH single status insert failed', { ruleId: id, err: e.message })
  }

  // 方案约定（动态筛选防误判与审计增强）：不将 rule_matched_objects 结果回写 rules.target_ids / target_by_account。
  // rules 表为「合同」（用户配置），rule_matched_objects 为「工单」（执行快照）；取消回写避免运行时结果覆盖配置。

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
  getRuleOutputObjectType,
  getRuleTargetAccountIds,
  getScopedTargetIdsForAccount,
  expandManualTargetIdsToAdLevel,
  expandExcludeIdsToAdLevel,
  calculateMatchedAdIdsForRule: calculateMatchedObjectIdsForRule,
  calculateMatchedObjectIdsForRule,
  mapAdIdsToTargetObjectIds,
  normalizeCompositeId
}

