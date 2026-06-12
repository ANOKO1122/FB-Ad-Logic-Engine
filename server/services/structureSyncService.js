/**
 * 结构同步服务（顺序2 阶段 2.4）
 * 从 FB 拉取指定账户的 ads 结构并写入 structure_ads 表，供选择器读库使用。
 * 约束：账户级锁 + 冷却期 2 分钟。
 * 历史数据与审计 P2：structure_ads 的 name/effective_status 变更写入 structure_ads_history（Change-Only、异步队列、背压、优雅停机）
 */
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { getCircuitBreakerStatus, getLastUsageRate } from './rateLimitService.js'
import pLimit from 'p-limit'

const COOLDOWN_MS = 120_000  // 2 分钟
const LOCK_PREFIX = 'sync:structure:'
// 每页之间间隔，减轻 FB 限流（手动同步是重型路径，宁愿慢一点也不要 burst 撞限流）
const PAGE_DELAY_MS = 1200
const ADS_FIELDS = 'id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time'
const CAMPAIGNS_FIELDS = 'id,name,effective_status,status,updated_time,created_time'
const ADSETS_FIELDS = 'id,name,effective_status,status,campaign_id,updated_time,created_time'

/** structure_ads_history 异步队列硬上限（方案 P2 背压） */
const STRUCTURE_ADS_HISTORY_QUEUE_MAX = Number(process.env.STRUCTURE_ADS_HISTORY_QUEUE_MAX) || 5000
/** 内存队列（仅 name/effective_status 变更时 push） */
const structureAdsHistoryQueue = []
/** 定时 flush 间隔（ms） */
const HISTORY_FLUSH_INTERVAL_MS = 5000
let historyFlushTimer = null

/**
 * 加载某账户当前 structure_ads 的 ad_id -> { name, effective_status } 用于变更检测（禁止在循环内 SELECT）
 * @param {Object|null} connectionOrPool - 事务内传 connection，否则传 null 用 pool
 * @param {string} accountId
 * @returns {Promise<Map<string,{ name: string|null, effective_status: string|null }>>}
 */
async function loadStructureAdsMapForAccount(connectionOrPool, accountId) {
  const conn = connectionOrPool || pool
  const [rows] = await conn.execute(
    'SELECT ad_id, name, effective_status FROM structure_ads WHERE account_id = ?',
    [accountId]
  )
  const map = new Map()
  for (const r of rows || []) {
    const id = String(r.ad_id ?? '')
    if (!id) continue
    map.set(id, { name: r.name ?? null, effective_status: r.effective_status ?? null })
  }
  return map
}

/**
 * 将一条 structure_ads 变更推入 history 队列；队列满则丢弃并打 Warn（方案 P2 背压）
 * @param {{ account_id: string, ad_id: string, name: string|null, effective_status: string|null, source?: string }}
 */
function pushStructureAdsHistory(record) {
  if (structureAdsHistoryQueue.length >= STRUCTURE_ADS_HISTORY_QUEUE_MAX) {
    logger.warn('[structure_ads_history] queue full, dropping audit record', { account_id: record.account_id, ad_id: record.ad_id })
    return
  }
  structureAdsHistoryQueue.push(record)
  startHistoryFlushTimer()
}

/**
 * 将队列中的记录批量写入 structure_ads_history，然后清空队列（方案 P2 优雅停机）
 * @param {number} [timeoutMs] - 可选超时，超时则放弃剩余并打 Warn
 * @returns {Promise<{ flushed: number }>}
 */
export async function flushHistoryQueue(timeoutMs = 0) {
  if (structureAdsHistoryQueue.length === 0) {
    return { flushed: 0 }
  }
  const toFlush = structureAdsHistoryQueue.splice(0, structureAdsHistoryQueue.length)
  const run = async () => {
    const BATCH = 200
    let total = 0
    for (let i = 0; i < toFlush.length; i += BATCH) {
      const chunk = toFlush.slice(i, i + BATCH)
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')
      const values = []
      for (const r of chunk) {
        values.push(r.account_id, r.ad_id, r.name ?? null, r.effective_status ?? null, r.source ?? null)
      }
      await pool.execute(
        `INSERT INTO structure_ads_history (account_id, ad_id, name, effective_status, source) VALUES ${placeholders}`,
        values
      )
      total += chunk.length
    }
    return total
  }
  try {
    if (timeoutMs > 0) {
      const result = await Promise.race([
        run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('flush timeout')), timeoutMs))
      ])
      return { flushed: result }
    }
    const flushed = await run()
    return { flushed }
  } catch (e) {
    if (e.message === 'flush timeout') {
      logger.warn('[structure_ads_history] flush timeout, dropping remaining', { remaining: toFlush.length })
      return { flushed: 0 }
    }
    logger.warn('[structure_ads_history] flush failed', { err: e.message })
    return { flushed: 0 }
  }
}

function startHistoryFlushTimer() {
  if (historyFlushTimer) return
  historyFlushTimer = setInterval(() => {
    if (structureAdsHistoryQueue.length === 0) return
    flushHistoryQueue().catch((e) => logger.warn('[structure_ads_history] interval flush failed', { err: e.message }))
  }, HISTORY_FLUSH_INTERVAL_MS)
}

/** AdsPolar 标准：拉取除 DELETED/ARCHIVED 外的所有状态，避免漏掉「准备中」等中间态（官方 Ad effective_status 无 PENDING_PROCESS，准备中多为 IN_PROCESS/PREAPPROVED 等） */
const EFFECTIVE_STATUS_FILTER = [
  'ACTIVE',
  'PAUSED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'IN_PROCESS',
  'WITH_ISSUES',
  'PREAPPROVED',
  'PENDING_BILLING_INFO',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED'
]

/**
 * 选择器查库（顺序2 阶段 2.2）：从 structure_ads 分页查询，0 FB 调用。
 * 过滤口径（与 TASKS.md「选择器本地展示过滤」一致）：
 * - q 为空：只返回 ACTIVE；include_paused=1 时再加 PAUSED
 * - q 非空：放宽到 EFFECTIVE_STATUS_FILTER 多类状态，仍排除 DELETED/ARCHIVED
 * - scope_status 优先：active_only|paused_only|active_and_paused 时覆盖上述状态
 * - 当 scope_status 有值时忽略 include_paused；当 scope_status 为空时按 include_paused + q 决定 statusList
 * - name_exclude：名称不包含（NOT LIKE）
 * 分页：基于 structure_ads.id 的稳定游标，返回 paging.after。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours, scope_created_before_hours, scope_created_between_from_hours, scope_created_between_to_hours }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureAdsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const scopeStatus = String(opts.scope_status || '').trim().toLowerCase()
  const nameExclude = opts.name_exclude != null ? String(opts.name_exclude).trim() : ''
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  // scope_created_within_hours：只查近 N 小时内创建的对象；阈值在 Node 中算成 ISO 字符串，避免 MySQL 对 VARCHAR(ISO8601) 解析差异
  const rawHours = opts.scope_created_within_hours != null ? parseInt(opts.scope_created_within_hours, 10) : NaN
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : null
  const createdSinceThreshold = hours != null ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null

  // 新增：创建超过 N 小时 → created_time <= now - N hours
  const rawBeforeHours = opts.scope_created_before_hours != null ? parseInt(opts.scope_created_before_hours, 10) : NaN
  const beforeHours = Number.isFinite(rawBeforeHours) && rawBeforeHours > 0 ? rawBeforeHours : null
  const createdBeforeThreshold = beforeHours != null ? new Date(Date.now() - beforeHours * 3600 * 1000).toISOString() : null

  // 新增：介于 X~Y 小时之间（超过 X、未超过 Y）
  // fromHours < toHours；例 from=24, to=72 → created_time BETWEEN now-72h AND now-24h
  const rawBetweenFrom = opts.scope_created_between_from_hours != null ? parseInt(opts.scope_created_between_from_hours, 10) : NaN
  const rawBetweenTo = opts.scope_created_between_to_hours != null ? parseInt(opts.scope_created_between_to_hours, 10) : NaN
  const betweenFromHours = Number.isFinite(rawBetweenFrom) && rawBetweenFrom > 0 ? rawBetweenFrom : null
  const betweenToHours = Number.isFinite(rawBetweenTo) && rawBetweenTo > 0 ? rawBetweenTo : null
  const betweenValid = betweenFromHours != null && betweenToHours != null && betweenFromHours < betweenToHours
  const betweenLowerBound = betweenValid ? new Date(Date.now() - betweenToHours * 3600 * 1000).toISOString() : null    // 更早: now - Y
  const betweenUpperBound = betweenValid ? new Date(Date.now() - betweenFromHours * 3600 * 1000).toISOString() : null  // 更近: now - X

  let statusList
  if (scopeStatus === 'active_only') statusList = ['ACTIVE']
  else if (scopeStatus === 'paused_only') statusList = ['PAUSED']
  else if (scopeStatus === 'active_and_paused') statusList = ['ACTIVE', 'PAUSED']
  else statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

  // scope_status_exclude：排除指定状态（逗号分隔，如 'PAUSED' 或 'ACTIVE,PAUSED'）
  const excludeRaw = opts.scope_status_exclude != null ? String(opts.scope_status_exclude).trim() : ''
  if (excludeRaw) {
    const excludeSet = new Set(excludeRaw.split(',').map(s => s.trim()).filter(Boolean))
    statusList = statusList.filter(s => !excludeSet.has(s))
  }
  if (statusList.length === 0) {
    return { items: [], paging: { after: null, next: null } }
  }

  // 顺序：先 account_id + effective_status（走索引），再 name LIKE/NOT LIKE（大表较贵），便于大表性能。
  const params = [accountId]
  let sql = `
    SELECT id, account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time
    FROM structure_ads
    WHERE account_id = ?
      AND effective_status IN (${statusList.map(() => '?').join(',')})
  `
  params.push(...statusList)
  if (q) {
    sql += ` AND name LIKE ?`
    params.push(`%${q}%`)
  }
  if (nameExclude) {
    sql += ` AND (name NOT LIKE ? OR name IS NULL)`
    params.push(`%${nameExclude}%`)
  }
  if (createdSinceThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ?`
    params.push(createdSinceThreshold)
  }
  if (createdBeforeThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time <= ?`
    params.push(createdBeforeThreshold)
  }
  if (betweenValid) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ? AND created_time <= ?`
    params.push(betweenLowerBound, betweenUpperBound)
  }
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  const orderBy =
    statusList.length === 2 && statusList.includes('ACTIVE') && statusList.includes('PAUSED')
      ? ` ORDER BY (effective_status = 'ACTIVE') DESC, id ASC`
      : ` ORDER BY id ASC`
  const limitRows = Math.min(501, limit + 1)
  sql += orderBy + ` LIMIT ${limitRows}`

  const [rows] = await pool.execute(sql, params)
  const hasNext = rows.length > limit
  const list = hasNext ? rows.slice(0, limit) : rows
  const nextAfter = hasNext && list.length > 0 ? String(list[list.length - 1].id) : null

  const items = list.map((row) => ({
    id: row.ad_id,
    name: row.name || '',
    effective_status: row.effective_status || null,
    status: row.status || null,
    configured_status: row.configured_status || null,
    adset_id: row.adset_id || null,
    campaign_id: row.campaign_id || null
  }))

  return {
    items,
    paging: { after: nextAfter, next: null }
  }
}

/**
 * 选择器查库：从 structure_campaigns 分页查询，0 FB 调用。
 * 过滤口径与 listStructureAdsFromDb 一致；支持 scope_status、name_exclude。
 * 当 scope_status 有值时忽略 include_paused；当 scope_status 为空时按 include_paused + q 决定 statusList。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours, scope_created_before_hours, scope_created_between_from_hours, scope_created_between_to_hours }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureCampaignsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const scopeStatus = String(opts.scope_status || '').trim().toLowerCase()
  const nameExclude = opts.name_exclude != null ? String(opts.name_exclude).trim() : ''
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  const rawHours = opts.scope_created_within_hours != null ? parseInt(opts.scope_created_within_hours, 10) : NaN
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : null
  const createdSinceThreshold = hours != null ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null

  // 新增：创建超过 N 小时 → created_time <= now - N hours
  const rawBeforeHours = opts.scope_created_before_hours != null ? parseInt(opts.scope_created_before_hours, 10) : NaN
  const beforeHours = Number.isFinite(rawBeforeHours) && rawBeforeHours > 0 ? rawBeforeHours : null
  const createdBeforeThreshold = beforeHours != null ? new Date(Date.now() - beforeHours * 3600 * 1000).toISOString() : null

  // 新增：介于 X~Y 小时之间（超过 X、未超过 Y）
  const rawBetweenFrom = opts.scope_created_between_from_hours != null ? parseInt(opts.scope_created_between_from_hours, 10) : NaN
  const rawBetweenTo = opts.scope_created_between_to_hours != null ? parseInt(opts.scope_created_between_to_hours, 10) : NaN
  const betweenFromHours = Number.isFinite(rawBetweenFrom) && rawBetweenFrom > 0 ? rawBetweenFrom : null
  const betweenToHours = Number.isFinite(rawBetweenTo) && rawBetweenTo > 0 ? rawBetweenTo : null
  const betweenValid = betweenFromHours != null && betweenToHours != null && betweenFromHours < betweenToHours
  const betweenLowerBound = betweenValid ? new Date(Date.now() - betweenToHours * 3600 * 1000).toISOString() : null
  const betweenUpperBound = betweenValid ? new Date(Date.now() - betweenFromHours * 3600 * 1000).toISOString() : null

  let statusList
  if (scopeStatus === 'active_only') statusList = ['ACTIVE']
  else if (scopeStatus === 'paused_only') statusList = ['PAUSED']
  else if (scopeStatus === 'active_and_paused') statusList = ['ACTIVE', 'PAUSED']
  else statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

  const excludeRaw = opts.scope_status_exclude != null ? String(opts.scope_status_exclude).trim() : ''
  if (excludeRaw) {
    const excludeSet = new Set(excludeRaw.split(',').map(s => s.trim()).filter(Boolean))
    statusList = statusList.filter(s => !excludeSet.has(s))
  }
  if (statusList.length === 0) {
    return { items: [], paging: { after: null, next: null } }
  }

  // 顺序：先 account_id + effective_status（走索引），再 name LIKE/NOT LIKE（大表较贵），便于大表性能。
  const params = [accountId]
  let sql = `
    SELECT id, account_id, campaign_id, name, effective_status, status, updated_time
    FROM structure_campaigns
    WHERE account_id = ?
      AND effective_status IN (${statusList.map(() => '?').join(',')})
  `
  params.push(...statusList)
  if (q) {
    sql += ` AND name LIKE ?`
    params.push(`%${q}%`)
  }
  if (nameExclude) {
    sql += ` AND (name NOT LIKE ? OR name IS NULL)`
    params.push(`%${nameExclude}%`)
  }
  if (createdSinceThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ?`
    params.push(createdSinceThreshold)
  }
  if (createdBeforeThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time <= ?`
    params.push(createdBeforeThreshold)
  }
  if (betweenValid) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ? AND created_time <= ?`
    params.push(betweenLowerBound, betweenUpperBound)
  }
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  const orderBy =
    statusList.length === 2 && statusList.includes('ACTIVE') && statusList.includes('PAUSED')
      ? ` ORDER BY (effective_status = 'ACTIVE') DESC, id ASC`
      : ` ORDER BY id ASC`
  const limitRows = Math.min(501, limit + 1)
  sql += orderBy + ` LIMIT ${limitRows}`

  const [rows] = await pool.execute(sql, params)
  const hasNext = rows.length > limit
  const list = hasNext ? rows.slice(0, limit) : rows
  const nextAfter = hasNext && list.length > 0 ? String(list[list.length - 1].id) : null

  const items = list.map((row) => ({
    id: row.campaign_id,
    name: row.name || '',
    effective_status: row.effective_status || null,
    status: row.status || null
  }))

  return {
    items,
    paging: { after: nextAfter, next: null }
  }
}

/**
 * 选择器查库：从 structure_adsets 分页查询，0 FB 调用。
 * 过滤口径与 listStructureAdsFromDb 一致；支持 scope_status、name_exclude。
 * 当 scope_status 有值时忽略 include_paused；当 scope_status 为空时按 include_paused + q 决定 statusList。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours, scope_created_before_hours, scope_created_between_from_hours, scope_created_between_to_hours }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureAdsetsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const scopeStatus = String(opts.scope_status || '').trim().toLowerCase()
  const nameExclude = opts.name_exclude != null ? String(opts.name_exclude).trim() : ''
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  const rawHours = opts.scope_created_within_hours != null ? parseInt(opts.scope_created_within_hours, 10) : NaN
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : null
  const createdSinceThreshold = hours != null ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null

  // 新增：创建超过 N 小时 → created_time <= now - N hours
  const rawBeforeHours = opts.scope_created_before_hours != null ? parseInt(opts.scope_created_before_hours, 10) : NaN
  const beforeHours = Number.isFinite(rawBeforeHours) && rawBeforeHours > 0 ? rawBeforeHours : null
  const createdBeforeThreshold = beforeHours != null ? new Date(Date.now() - beforeHours * 3600 * 1000).toISOString() : null

  // 新增：介于 X~Y 小时之间（超过 X、未超过 Y）
  const rawBetweenFrom = opts.scope_created_between_from_hours != null ? parseInt(opts.scope_created_between_from_hours, 10) : NaN
  const rawBetweenTo = opts.scope_created_between_to_hours != null ? parseInt(opts.scope_created_between_to_hours, 10) : NaN
  const betweenFromHours = Number.isFinite(rawBetweenFrom) && rawBetweenFrom > 0 ? rawBetweenFrom : null
  const betweenToHours = Number.isFinite(rawBetweenTo) && rawBetweenTo > 0 ? rawBetweenTo : null
  const betweenValid = betweenFromHours != null && betweenToHours != null && betweenFromHours < betweenToHours
  const betweenLowerBound = betweenValid ? new Date(Date.now() - betweenToHours * 3600 * 1000).toISOString() : null
  const betweenUpperBound = betweenValid ? new Date(Date.now() - betweenFromHours * 3600 * 1000).toISOString() : null

  let statusList
  if (scopeStatus === 'active_only') statusList = ['ACTIVE']
  else if (scopeStatus === 'paused_only') statusList = ['PAUSED']
  else if (scopeStatus === 'active_and_paused') statusList = ['ACTIVE', 'PAUSED']
  else statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

  const excludeRaw = opts.scope_status_exclude != null ? String(opts.scope_status_exclude).trim() : ''
  if (excludeRaw) {
    const excludeSet = new Set(excludeRaw.split(',').map(s => s.trim()).filter(Boolean))
    statusList = statusList.filter(s => !excludeSet.has(s))
  }
  if (statusList.length === 0) {
    return { items: [], paging: { after: null, next: null } }
  }

  // 顺序：先 account_id + effective_status（走索引），再 name LIKE/NOT LIKE（大表较贵），便于大表性能。
  const params = [accountId]
  let sql = `
    SELECT id, account_id, adset_id, campaign_id, name, effective_status, status, updated_time
    FROM structure_adsets
    WHERE account_id = ?
      AND effective_status IN (${statusList.map(() => '?').join(',')})
  `
  params.push(...statusList)
  if (q) {
    sql += ` AND name LIKE ?`
    params.push(`%${q}%`)
  }
  if (nameExclude) {
    sql += ` AND (name NOT LIKE ? OR name IS NULL)`
    params.push(`%${nameExclude}%`)
  }
  if (createdSinceThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ?`
    params.push(createdSinceThreshold)
  }
  if (createdBeforeThreshold) {
    sql += ` AND created_time IS NOT NULL AND created_time <= ?`
    params.push(createdBeforeThreshold)
  }
  if (betweenValid) {
    sql += ` AND created_time IS NOT NULL AND created_time >= ? AND created_time <= ?`
    params.push(betweenLowerBound, betweenUpperBound)
  }
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  const orderBy =
    statusList.length === 2 && statusList.includes('ACTIVE') && statusList.includes('PAUSED')
      ? ` ORDER BY (effective_status = 'ACTIVE') DESC, id ASC`
      : ` ORDER BY id ASC`
  const limitRows = Math.min(501, limit + 1)
  sql += orderBy + ` LIMIT ${limitRows}`

  const [rows] = await pool.execute(sql, params)
  const hasNext = rows.length > limit
  const list = hasNext ? rows.slice(0, limit) : rows
  const nextAfter = hasNext && list.length > 0 ? String(list[list.length - 1].id) : null

  const items = list.map((row) => ({
    id: row.adset_id,
    name: row.name || '',
    effective_status: row.effective_status || null,
    status: row.status || null,
    campaign_id: row.campaign_id || null
  }))

  return {
    items,
    paging: { after: nextAfter, next: null }
  }
}

/**
 * 统一结构列表入口（方案 B：服务层聚合，不建 view）
 * type 只允许 campaign | adset | ad，分发到已有 list 方法，返回统一字段结构。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { type, q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours, scope_created_before_hours, scope_created_between_from_hours, scope_created_between_to_hours }
 * @returns {Promise<{ items: Array<{ id, type, name, campaign_id, adset_id, effective_status, account_id }>, paging }>}
 */
export async function listStructureObjectsFromDb(accountId, opts = {}) {
  const type = String(opts.type || '').toLowerCase()
  const allowed = ['campaign', 'adset', 'ad']
  if (!allowed.includes(type)) {
    throw new Error(`type 只允许 campaign | adset | ad，当前: ${opts.type}`)
  }
  const listOpts = {
    q: opts.q,
    limit: opts.limit,
    after: opts.after,
    include_paused: opts.include_paused,
    scope_status: opts.scope_status,
    scope_status_exclude: opts.scope_status_exclude,
    name_exclude: opts.name_exclude,
    scope_created_within_hours: opts.scope_created_within_hours,
    scope_created_before_hours: opts.scope_created_before_hours,
    scope_created_between_from_hours: opts.scope_created_between_from_hours,
    scope_created_between_to_hours: opts.scope_created_between_to_hours
  }
  let result
  if (type === 'campaign') {
    result = await listStructureCampaignsFromDb(accountId, listOpts)
  } else if (type === 'adset') {
    result = await listStructureAdsetsFromDb(accountId, listOpts)
  } else {
    result = await listStructureAdsFromDb(accountId, listOpts)
  }
  const sourceTable = type === 'campaign' ? 'structure_campaigns' : type === 'adset' ? 'structure_adsets' : 'structure_ads'
  const items = result.items.map((row) => {
    const base = { id: row.id, type, name: row.name || '', effective_status: row.effective_status ?? null, account_id: accountId }
    if (type === 'campaign') {
      return { ...base, campaign_id: row.id, adset_id: null }
    }
    if (type === 'adset') {
      return { ...base, campaign_id: row.campaign_id ?? null, adset_id: row.id }
    }
    return { ...base, campaign_id: row.campaign_id ?? null, adset_id: row.adset_id ?? null }
  })
  return { items, paging: result.paging, _source: sourceTable }
}

/**
 * 按 ids 从 structure_campaigns / structure_adsets / structure_ads 解析（resolve 回显查库）
 * 支持 campaign / adset / ad 三类，不穿透 FB。
 * 返回 { id, name, type?, effective_status?, missing }，前端不改也能用（type 可选）。
 *
 * @param {string[]} ids - 对象 ID 列表（可为 campaign_id / adset_id / ad_id 混合）
 * @returns {Promise<Array<{ id: string, name?: string, type?: string, effective_status?: string, missing?: boolean }>>}
 */
export async function resolveStructureByIds(ids) {
  const idList = [...new Set((ids || []).map(String).filter(Boolean))]
  if (idList.length === 0) return []

  const placeholders = idList.map(() => '?').join(',')
  const resultMap = new Map() // id -> { name, type, effective_status, ... }

  // 1. 查 structure_campaigns
  const [campRows] = await pool.execute(
    `SELECT campaign_id AS id, name, effective_status, status FROM structure_campaigns WHERE campaign_id IN (${placeholders})`,
    idList
  )
  for (const r of campRows) {
    const id = String(r.id || '')
    if (id && !resultMap.has(id)) {
      resultMap.set(id, {
        name: r.name || '',
        type: 'campaign',
        effective_status: r.effective_status || null,
        status: r.status || null
      })
    }
  }

  // 2. 查 structure_adsets（仅未命中的）
  const remainingAdset = idList.filter(id => !resultMap.has(id))
  if (remainingAdset.length > 0) {
    const ph2 = remainingAdset.map(() => '?').join(',')
    const [adsetRows] = await pool.execute(
      `SELECT adset_id AS id, name, effective_status, status, campaign_id FROM structure_adsets WHERE adset_id IN (${ph2})`,
      remainingAdset
    )
    for (const r of adsetRows) {
      const id = String(r.id || '')
      if (id && !resultMap.has(id)) {
        resultMap.set(id, {
          name: r.name || '',
          type: 'adset',
          effective_status: r.effective_status || null,
          status: r.status || null,
          campaign_id: r.campaign_id || null
        })
      }
    }
  }

  // 3. 查 structure_ads + ad_snapshots 兜底（仅未命中的）
  const remainingAd = idList.filter(id => !resultMap.has(id))
  if (remainingAd.length > 0) {
    const adResults = await resolveStructureAdsByIds(remainingAd)
    for (const it of adResults) {
      const id = String(it.id || '')
      if (id) {
        resultMap.set(id, {
          name: it.name || '',
          type: 'ad',
          effective_status: it.effective_status || null,
          status: it.status || null,
          configured_status: it.configured_status || null,
          adset_id: it.adset_id || null,
          campaign_id: it.campaign_id || null,
          missing: it.missing
        })
      }
    }
  }

  return idList.map(id => {
    const row = resultMap.get(id)
    if (row) {
      if (row.missing) {
        return { id, missing: true }
      }
      const base = { id, name: row.name || '', type: row.type }
      if (row.effective_status != null) base.effective_status = row.effective_status
      if (row.status != null) base.status = row.status
      if (row.configured_status != null) base.configured_status = row.configured_status
      if (row.campaign_id != null) base.campaign_id = row.campaign_id
      if (row.adset_id != null) base.adset_id = row.adset_id
      return base
    }
    return { id, missing: true }
  })
}

/**
 * 按 ad_ids 从 structure_ads 解析（顺序2 resolve 回显查库，内部/ads 专用）
 * DB 有的返回 { id, name, effective_status, ... }；DB 没有的返回 { id, missing: true }
 * 不穿透 FB。
 *
 * @param {string[]} adIds - 广告 ID 列表
 * @returns {Promise<Array<{ id: string, name?: string, effective_status?: string, missing?: boolean }>>}
 */
export async function resolveStructureAdsByIds(adIds) {
  const ids = [...new Set((adIds || []).map(String).filter(Boolean))]
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const [rows] = await pool.execute(
    `SELECT ad_id, name, effective_status, status, configured_status
     FROM structure_ads
     WHERE ad_id IN (${placeholders})`,
    ids
  )
  const found = new Map(rows.map(r => [String(r.ad_id), r]))
  const missingIds = ids.filter(id => !found.has(id))

  // 回显兜底：structure_ads 未命中时，用 ad_snapshots 最新快照取 ad_name，避免误标「未同步」
  if (missingIds.length > 0) {
    const ph2 = missingIds.map(() => '?').join(',')
    const [snapRows] = await pool.execute(
      `SELECT s.ad_id, s.ad_name
       FROM ad_snapshots s
       INNER JOIN (
         SELECT ad_id, MAX(synced_at) AS max_synced
         FROM ad_snapshots
         WHERE ad_id IN (${ph2})
         GROUP BY ad_id
       ) t ON s.ad_id = t.ad_id AND s.synced_at = t.max_synced
       WHERE s.ad_id IN (${ph2})`,
      [...missingIds, ...missingIds]
    )
    for (const r of snapRows) {
      const id = String(r.ad_id)
      if (!found.has(id)) {
        found.set(id, { name: r.ad_name || id, _fromSnapshot: true })
      }
    }
  }

  return ids.map(id => {
    const row = found.get(id)
    if (row) {
      if (row._fromSnapshot) {
        return { id, name: row.name || '', missing: false }
      }
      return {
        id,
        name: row.name || '',
        effective_status: row.effective_status || null,
        status: row.status || null,
        configured_status: row.configured_status || null
      }
    }
    return { id, missing: true }
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 将 FB 返回的 updated_time 标准化为 UTC Z 字符串（便于入库与比较） */
function normalizeUpdatedTimeToUtcZ(val) {
  if (val == null || val === '') return null
  try {
    const d = new Date(val)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  } catch {
    return null
  }
}

/** 从 ISO8601/日期字符串得到 Unix 秒（对内游标） */
function updatedTimeToUnixSec(val) {
  if (val == null || val === '') return null
  try {
    const d = new Date(val)
    return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null
  } catch {
    return null
  }
}

/** 单条写入 structure_ads（供 Piggyback / 伪增量复用） */
const UPSERT_STRUCTURE_SQL = `
  INSERT INTO structure_ads
    (account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time, created_time, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE
    adset_id = VALUES(adset_id),
    campaign_id = VALUES(campaign_id),
    name = VALUES(name),
    effective_status = VALUES(effective_status),
    status = VALUES(status),
    configured_status = VALUES(configured_status),
    updated_time = VALUES(updated_time),
    created_time = VALUES(created_time),
    last_synced_at = NOW()
`

/**
 * Piggyback：用本轮 Today 已拿到的 structurePayload 补齐 structure_ads（缺失/空名/缺状态才写）
 * 同轮 resolve 已由 Today 执行一次，此处只写库，仅对「缺口」且本轮未拿到信息的 id 才补查一次。
 * Best-effort，失败不影响主链路。
 */
export async function piggybackStructureFromToday(accountId, activeAdIds, structurePayload, facebookApi) {
  if (!activeAdIds || activeAdIds.length === 0) return { filled: 0, gapFetched: 0 }
  try {
    const [rows] = await pool.query(
      `SELECT ad_id, name, effective_status FROM structure_ads WHERE account_id = ? AND ad_id IN (?)`,
      [accountId, activeAdIds]
    )
    const existing = new Map(rows.map(r => [String(r.ad_id), { name: r.name, effective_status: r.effective_status }]))
    const needUpdate = activeAdIds.filter(id => {
      const ex = existing.get(String(id))
      return !ex || !(ex.name != null && ex.name !== '') || !ex.effective_status
    })
    if (needUpdate.length === 0) return { filled: 0, gapFetched: 0 }

    let filledFromPayload = 0
    const gapIds = []
    for (const adId of needUpdate) {
      const payload = structurePayload[String(adId)]
      if (payload) {
        const name = payload.name ?? null
        const eff = payload.effective_status ?? null
        const old = existing.get(String(adId))
        if (name !== old?.name || eff !== old?.effective_status) {
          pushStructureAdsHistory({ account_id: accountId, ad_id: String(adId), name, effective_status: eff, source: 'piggyback' })
        }
        const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(payload.updated_time)
        const createdTimeNorm = normalizeUpdatedTimeToUtcZ(payload.created_time)
        await pool.execute(UPSERT_STRUCTURE_SQL, [
          accountId, adId,
          payload.adset_id ?? null, payload.campaign_id ?? null, name,
          eff, payload.status ?? null, payload.configured_status ?? null,
          updatedTimeNorm ?? null,
          createdTimeNorm ?? payload.created_time ?? null
        ])
        filledFromPayload++
      } else {
        gapIds.push(adId)
      }
    }
    let gapFetched = 0
    if (gapIds.length > 0 && facebookApi) {
      const resolved = await facebookApi.resolveObjectsByIds(gapIds, { fields: ADS_FIELDS })
      for (const ad of resolved) {
        const id = String(ad.id || '')
        const name = ad.name ?? null
        const eff = ad.effective_status ?? null
        const old = existing.get(id)
        if (name !== old?.name || eff !== old?.effective_status) {
          pushStructureAdsHistory({ account_id: accountId, ad_id: id, name, effective_status: eff, source: 'piggyback' })
        }
        const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(ad.updated_time)
        const createdTimeNorm = normalizeUpdatedTimeToUtcZ(ad.created_time)
        await pool.execute(UPSERT_STRUCTURE_SQL, [
          accountId, id,
          ad.adset_id ?? null, ad.campaign_id ?? null, name,
          eff, ad.status ?? null, ad.configured_status ?? null,
          updatedTimeNorm ?? null,
          createdTimeNorm ?? ad.created_time ?? null
        ])
        gapFetched++
      }
    }
    if (filledFromPayload > 0 || gapFetched > 0) {
      logger.info(`[Piggyback] account=${accountId} 补齐 structure_ads: 复用=${filledFromPayload}, 缺口补查=${gapFetched}`)
    }
    return { filled: filledFromPayload, gapFetched }
  } catch (err) {
    logger.warn(`[Piggyback] account=${accountId} 失败（不影响主链路）:`, err.message)
    return { filled: 0, gapFetched: 0 }
  }
}

/** recentActiveIds 取数口径：24h 窗口内、且至少 1h 未同步（降频），上限 200；排序最旧优先（旋转） */
const RECENT_ACTIVE_HOURS = 24
const PSEUDO_INCREMENT_MIN_INTERVAL_HOURS = 1
const MAX_DIFF_IDS = 200

/**
 * 伪增量：仅对 diffIds = recentActiveIds - activeAdIds 做 resolveObjectsByIds 并 upsert
 * activeAdIds 由 Piggyback 承担；diffIds 为空则不调 FB。
 * 时间窗口：NULL 放行（自愈历史/异常）；非 NULL 要求 24h 内。降频：NULL 放行；非 NULL 要求至少 1h 未同步。最旧优先旋转。
 */
export async function runPseudoIncrementForAccount(accountId, activeAdIds, facebookApi) {
  const activeSet = new Set((activeAdIds || []).map(String))
  try {
    const [rows] = await pool.query(
      `SELECT ad_id FROM structure_ads
       WHERE account_id = ? AND effective_status = 'ACTIVE'
         AND (last_synced_at IS NULL OR last_synced_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RECENT_ACTIVE_HOURS} HOUR))
         AND (last_synced_at IS NULL OR last_synced_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${PSEUDO_INCREMENT_MIN_INTERVAL_HOURS} HOUR))
       ORDER BY last_synced_at ASC
       LIMIT ${MAX_DIFF_IDS}`,
      [accountId]
    )
    const recentActiveIds = rows.map(r => String(r.ad_id || ''))
    const diffIds = recentActiveIds.filter(id => !activeSet.has(id))
    const diffHead5 = diffIds.slice(0, 5)

    if (diffIds.length === 0) {
      logger.info(`[伪增量] account=${accountId} recentActiveIds=${recentActiveIds.length} diffIds=0 touched=0 diffHead5=[]`)
      return { touched: 0 }
    }

    const oldMap = await loadStructureAdsMapForAccount(null, accountId)
    const resolved = await facebookApi.resolveObjectsByIds(diffIds, { fields: ADS_FIELDS })
    let touched = 0
    for (const ad of resolved) {
      const id = String(ad.id || '')
      const name = ad.name ?? null
      const eff = ad.effective_status ?? null
      const old = oldMap.get(id)
      if (name !== old?.name || eff !== old?.effective_status) {
        pushStructureAdsHistory({ account_id: accountId, ad_id: id, name, effective_status: eff, source: 'pseudo_increment' })
      }
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(ad.updated_time)
      const createdTimeNorm = normalizeUpdatedTimeToUtcZ(ad.created_time)
      await pool.execute(UPSERT_STRUCTURE_SQL, [
        accountId, id,
        ad.adset_id ?? null, ad.campaign_id ?? null, name,
        eff, ad.status ?? null, ad.configured_status ?? null,
        updatedTimeNorm ?? null,
        createdTimeNorm ?? ad.created_time ?? null
      ])
      touched++
    }
    logger.info(`[伪增量] account=${accountId} recentActiveIds=${recentActiveIds.length} diffIds=${diffIds.length} touched=${touched} diffHead5=${JSON.stringify(diffHead5)}`)
    return { touched }
  } catch (err) {
    logger.warn(`[伪增量] account=${accountId} 失败:`, err.message)
    return { touched: 0 }
  }
}

/**
 * 执行 structure_ads 批量 upsert 和 structure_sync_status 更新（共享逻辑）
 * @param {Object} lockConnection
 * @param {string} accountId
 * @param {Array} allItems
 * @param {number|null} cursorTs - 当前游标
 * @param {boolean} isFullRun
 * @param {number|null} [filterSinceSec] - 本次使用的过滤起点 Unix 秒（近 3 天窗口），写入 last_filter_since_sec 便于可观测
 */
async function doStructureAdsUpsertAndStatus(lockConnection, accountId, allItems, cursorTs, isFullRun, filterSinceSec = null) {
  const UPSERT_BATCH_SIZE = 50
  // P2：全账户内存预加载，禁止在循环内 SELECT
  const oldMap = await loadStructureAdsMapForAccount(lockConnection, accountId)

  const upsertBase = `
    INSERT INTO structure_ads
      (account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time, created_time, last_synced_at)
    VALUES
  `
  const upsertUpdate = `
    ON DUPLICATE KEY UPDATE
      adset_id = VALUES(adset_id),
      campaign_id = VALUES(campaign_id),
      name = VALUES(name),
      effective_status = VALUES(effective_status),
      status = VALUES(status),
      configured_status = VALUES(configured_status),
      updated_time = VALUES(updated_time),
      created_time = VALUES(created_time),
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const adId = String(item.id ?? '')
      const name = item.name ?? null
      const eff = item.effective_status ?? null
      const old = oldMap.get(adId)
      if (name !== old?.name || eff !== old?.effective_status) {
        pushStructureAdsHistory({ account_id: accountId, ad_id: adId, name, effective_status: eff, source: 'structure_sync' })
      }
      oldMap.set(adId, { name, effective_status: eff })

      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      const createdTimeNorm = normalizeUpdatedTimeToUtcZ(item.created_time)
      values.push(
        accountId,
        item.id,
        item.adset_id ?? null,
        item.campaign_id ?? null,
        name,
        eff,
        item.status ?? null,
        item.configured_status ?? null,
        updatedTimeNorm ?? item.updated_time ?? null,
        createdTimeNorm ?? item.created_time ?? null
      )
    }
    await lockConnection.execute(upsertBase + placeholders + upsertUpdate, values)
  }
  let newCursorTs = cursorTs
  if (allItems.length > 0) {
    let maxUtcZ = null
    for (const item of allItems) {
      const z = normalizeUpdatedTimeToUtcZ(item.updated_time)
      if (z && (!maxUtcZ || z > maxUtcZ)) maxUtcZ = z
    }
    const ts = maxUtcZ ? updatedTimeToUnixSec(maxUtcZ) : null
    if (ts != null && (cursorTs == null || ts > cursorTs)) newCursorTs = ts
  }
  const cursorChanged = allItems.length > 0 && newCursorTs != null && newCursorTs !== cursorTs
  let fullCount = null
  if (isFullRun) {
    const [cntRows] = await lockConnection.query(
      `SELECT COUNT(*) AS n FROM structure_ads WHERE account_id = ?`,
      [accountId]
    )
    fullCount = Number(cntRows[0]?.n ?? 0)
  }
  const fullSuccessAt = isFullRun ? new Date() : null
  const upsertStatusSql = `
    INSERT INTO structure_sync_status
      (account_id, last_success_at, last_error, updated_at, last_sync_updated_ts, last_full_count, has_full_synced, last_full_success_at, last_filter_since_sec)
    VALUES
      (?, NOW(), NULL, NOW(), ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      last_success_at = NOW(),
      last_error = NULL,
      updated_at = NOW(),
      last_sync_updated_ts = IF(? = 1, ?, last_sync_updated_ts),
      last_full_count = COALESCE(?, last_full_count),
      has_full_synced = CASE WHEN ? = 1 THEN 1 ELSE has_full_synced END,
      last_full_success_at = COALESCE(?, last_full_success_at),
      last_filter_since_sec = COALESCE(?, last_filter_since_sec)
  `
  await lockConnection.execute(upsertStatusSql, [
    accountId,
    newCursorTs,
    fullCount,
    isFullRun ? 1 : 0,
    fullSuccessAt,
    filterSinceSec,
    cursorChanged ? 1 : 0,
    newCursorTs,
    fullCount,
    isFullRun ? 1 : 0,
    fullSuccessAt,
    filterSinceSec
  ])
}

/**
 * 执行 structure_campaigns 批量 upsert（仅 upsert，不更新 structure_sync_status）
 * @param {Object} lockConnection
 * @param {string} accountId
 * @param {Array} allItems - 来自 FB campaigns edge，每项含 id, name, effective_status, status, updated_time
 */
async function doStructureCampaignsUpsert(lockConnection, accountId, allItems) {
  const UPSERT_BATCH_SIZE = 50
  const upsertBase = `
    INSERT INTO structure_campaigns
      (account_id, campaign_id, name, effective_status, status, updated_time, created_time, last_synced_at)
    VALUES
  `
  const upsertUpdate = `
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      effective_status = VALUES(effective_status),
      status = VALUES(status),
      updated_time = VALUES(updated_time),
      created_time = VALUES(created_time),
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      const createdTimeNorm = normalizeUpdatedTimeToUtcZ(item.created_time)
      values.push(
        accountId,
        item.id,
        item.name ?? null,
        item.effective_status ?? null,
        item.status ?? null,
        updatedTimeNorm ?? null,
        createdTimeNorm ?? item.created_time ?? null
      )
    }
    await lockConnection.execute(upsertBase + placeholders + upsertUpdate, values)
  }
}

/**
 * 执行 structure_adsets 批量 upsert（仅 upsert，不更新 structure_sync_status）
 * @param {Object} lockConnection
 * @param {string} accountId
 * @param {Array} allItems - 来自 FB adsets edge，每项含 id, name, effective_status, status, campaign_id, updated_time
 */
async function doStructureAdsetsUpsert(lockConnection, accountId, allItems) {
  const UPSERT_BATCH_SIZE = 50
  const upsertBase = `
    INSERT INTO structure_adsets
      (account_id, adset_id, campaign_id, name, effective_status, status, updated_time, created_time, last_synced_at)
    VALUES
  `
  const upsertUpdate = `
    ON DUPLICATE KEY UPDATE
      campaign_id = VALUES(campaign_id),
      name = VALUES(name),
      effective_status = VALUES(effective_status),
      status = VALUES(status),
      updated_time = VALUES(updated_time),
      created_time = VALUES(created_time),
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      const createdTimeNorm = normalizeUpdatedTimeToUtcZ(item.created_time)
      values.push(
        accountId,
        item.id,
        item.campaign_id ?? null,
        item.name ?? null,
        item.effective_status ?? null,
        item.status ?? null,
        updatedTimeNorm ?? null,
        createdTimeNorm ?? item.created_time ?? null
      )
    }
    await lockConnection.execute(upsertBase + placeholders + upsertUpdate, values)
  }
}

/**
 * 仅同步指定账户的广告组（adsets）到 structure_adsets，全量分页拉取，不拉 campaigns/ads。
 * 用于补数：某账户 structure_adsets 为空时单独补齐广告组数据。
 * @param {string} accountId - 广告账户 ID（如 act_xxx）
 * @param {Object} facebookApi - 已构造的 FacebookMarketingAPI 实例
 * @param {{ skipLock?: boolean }} [opts] - skipLock=true 时不占账户锁（脚本专用）
 * @returns {Promise<{ ok: boolean, synced_count?: number, reason?: string }>}
 */
export async function syncAccountStructureAdsetsOnly(accountId, facebookApi, opts = {}) {
  const skipLock = opts.skipLock === true
  let conn = null
  const lockName = LOCK_PREFIX + accountId
  try {
    conn = await pool.getConnection()
    if (!skipLock) {
      const [lockRows] = await conn.query(`SELECT GET_LOCK(?, 0) AS acquired`, [lockName])
      if (lockRows[0]?.acquired !== 1) {
        conn.release()
        return { ok: false, reason: 'lock_busy' }
      }
    }
    const allAdsets = []
    let after = null
    do {
      const page = await facebookApi.getStructurePage(accountId, 'adsets', {
        fields: ADSETS_FIELDS,
        limit: 100,
        after,
        filtering: null
      })
      if (page?.items?.length) allAdsets.push(...page.items)
      after = page?.paging?.after ?? null
      if (after) await sleep(PAGE_DELAY_MS)
    } while (after)
    await doStructureAdsetsUpsert(conn, accountId, allAdsets)
    if (!skipLock) await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName])
    conn.release()
    conn = null
    logger.info(`[adsets-only] account=${accountId} 同步 adsets 完成 count=${allAdsets.length}`)
    return { ok: true, synced_count: allAdsets.length }
  } catch (err) {
    if (conn) {
      try {
        if (!skipLock) await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      } catch (_) {}
      conn.release()
      conn = null
    }
    throw err
  }
}

/**
 * 强制同步该账户的广告结构到 structure_ads（顺序2 2.4：近 3 天路径）
 * 策略：campaigns/adsets/ads 均只拉 updated_time >= since（since = 当前时间减 3 天），filtering value 优先 Unix 秒；分页拉完再 upsert；ads 的 isFullRun 传 false。
 * @param {string} accountId - 广告账户 ID（如 act_xxx）
 * @param {Object} facebookApi - 已构造的 FacebookMarketingAPI 实例，需有 getStructurePage(accountId, edge, opts)
 * @param {Object} [opts] - 可选，保留供调用方传参
 * @returns {Promise<{ ok: boolean, reason?: string, synced_count?: number, duration_ms?: number, retry_after_sec?: number }>}
 */
export async function syncAccountStructureAds(accountId, facebookApi, opts = {}) {
  const startTime = Date.now()
  let lockConnection = null
  const lockName = LOCK_PREFIX + accountId

  try {
    lockConnection = await pool.getConnection()

    const [lockRows] = await lockConnection.query(`SELECT GET_LOCK(?, 0) AS acquired`, [lockName])
    const lockAcquired = lockRows[0]?.acquired === 1
    if (!lockAcquired) {
      if (lockConnection) {
        lockConnection.release()
        lockConnection = null
      }
      return { ok: false, reason: 'lock_busy' }
    }

    // 冷却期：按「上一次结构同步（近 3 天）成功时间」structure_sync_status.last_success_at，避免被 Piggyback/伪增量误触发
    const [cooldownRows] = await lockConnection.query(
      `SELECT UNIX_TIMESTAMP(last_success_at) AS last_ts FROM structure_sync_status WHERE account_id = ?`,
      [accountId]
    )
    const lastTsSec = cooldownRows[0]?.last_ts
    const lastSyncedTs = lastTsSec != null && Number.isFinite(Number(lastTsSec)) ? Number(lastTsSec) * 1000 : null
    const elapsed = lastSyncedTs != null ? Date.now() - lastSyncedTs : null
    logger.info(`[2.4] 冷却检查 account=${accountId} last_success_at_ts=${lastSyncedTs} elapsed_ms=${elapsed} cooldown_ms=${COOLDOWN_MS}`)
    if (lastSyncedTs != null && elapsed != null && elapsed < COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000)
      await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      lockConnection.release()
      lockConnection = null
      logger.info(`⏸️ [2.4] 冷却期内 account=${accountId} elapsed_ms=${elapsed} retry_after_sec=${retryAfterSec}`)
      return { ok: false, reason: 'cooldown', retry_after_sec: retryAfterSec }
    }

    // ✅ 预检：若最近一次已知的 API 使用率很高，提前拒绝「结构同步（近 3 天）」请求
    // 目的：避免在配额紧张时继续触发 FB 的 user request limit（更差体验：前端 90s 超时）
    const usageRate = getLastUsageRate()
    if (usageRate != null && Number.isFinite(Number(usageRate)) && Number(usageRate) >= 85) {
      const r = Number(usageRate)
      // 保守退避：使用率越高，建议等待越久（秒）
      const retryAfterSec = r >= 95 ? 3600 : (r >= 90 ? 600 : 120)
      await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      lockConnection.release()
      lockConnection = null
      logger.warn(`[2.4] usage 高，跳过结构同步（近3天） account=${accountId} usageRate=${r} retry_after_sec=${retryAfterSec}`)
      return { ok: false, reason: 'quota_high', retry_after_sec: retryAfterSec }
    }

    // 读取 structure_sync_status（用于 doStructureAdsUpsertAndStatus 的 last_sync_updated_ts）
    const [statusRows] = await lockConnection.query(
      `SELECT last_sync_updated_ts FROM structure_sync_status WHERE account_id = ?`,
      [accountId]
    )
    const status = statusRows[0] || null
    const cursorTs = status?.last_sync_updated_ts != null ? Number(status.last_sync_updated_ts) : null

    // 近 3 天：since 用 Unix 秒；filtering value 优先 Unix 时间戳（秒），若某 edge 报错则自动回退为 ISO8601
    const sinceSec = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000)
    let sinceValue = String(sinceSec)

    /** 拉取单 edge 全部分页（filtering: updated_time >= sinceValue），用于 Unix/ISO 回退 */
    async function fetchAllPagesForEdge(edge, fields) {
      const items = []
      let after = null
      do {
        const page = await facebookApi.getStructurePage(accountId, edge, {
          fields,
          limit: 100,
          after,
          filtering: [{ field: 'updated_time', operator: 'GREATER_THAN', value: sinceValue }]
        })
        if (page?.items?.length) items.push(...page.items)
        after = page?.paging?.after ?? null
        if (after) await sleep(PAGE_DELAY_MS)
      } while (after)
      return items
    }

    /** 先试当前 sinceValue（优先 Unix 秒），失败则切为 ISO8601 再拉一次 */
    async function fetchEdgeWithFallback(edge, fields, edgeLabel) {
      try {
        return await fetchAllPagesForEdge(edge, fields)
      } catch (err) {
        logger.warn(`[2.4] ${edgeLabel} 使用 Unix 秒报错，回退 ISO8601 account=${accountId} error=${err.message}`)
        sinceValue = new Date(sinceSec * 1000).toISOString()
        return await fetchAllPagesForEdge(edge, fields)
      }
    }

    // 1. campaigns：只拉 updated_time >= since（近 3 天），分页拉完再 upsert
    const allCampaigns = await fetchEdgeWithFallback('campaigns', CAMPAIGNS_FIELDS, 'campaigns')
    await doStructureCampaignsUpsert(lockConnection, accountId, allCampaigns)
    logger.info(`[2.4] campaigns 同步 account=${accountId} count=${allCampaigns.length}`)

    // 2. adsets：只拉 updated_time >= since（近 3 天），分页拉完再 upsert
    const allAdsets = await fetchEdgeWithFallback('adsets', ADSETS_FIELDS, 'adsets')
    await doStructureAdsetsUpsert(lockConnection, accountId, allAdsets)
    logger.info(`[2.4] adsets 同步 account=${accountId} count=${allAdsets.length}`)

    // 3. ads：只拉 updated_time >= since（近 3 天），分页拉完再 upsert；isFullRun 传 false；写入 last_filter_since_sec
    const allItems = await fetchEdgeWithFallback('ads', ADS_FIELDS, 'ads')
    await doStructureAdsUpsertAndStatus(lockConnection, accountId, allItems, cursorTs, false, sinceSec)

    await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
    lockConnection.release()
    lockConnection = null

    const durationMs = Date.now() - startTime
    logger.info(`✅ [2.4] 结构同步完成 account=${accountId} 近3天 campaigns=${allCampaigns.length} adsets=${allAdsets.length} ads=${allItems.length} duration_ms=${durationMs}`)
    return { ok: true, synced_count: allItems.length, synced_campaigns: allCampaigns.length, synced_adsets: allAdsets.length, duration_ms: durationMs }
  } catch (err) {
    if (lockConnection) {
      try {
        await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      } catch (e) {
        logger.warn('释放结构同步锁失败:', e.message)
      }
      lockConnection.release()
      lockConnection = null
    }
    throw err
  }
}

/**
 * Fast Sync（MVP）：单账户一次 unified batch 拉 campaigns/adsets/ads 三层并写库
 * - 不挂 Cron，仅供脚本/手动入口调用
 * - 软分页补页：首批后仅对「有 after」的 edge 继续拉，直到 after 为空或命中页为空
 * - 复用现有三层 upsert + structure_sync_status 更新逻辑
 *
 * @param {string} accountId - 广告账户 ID（如 act_xxx）
 * @param {Object} facebookApi - FacebookMarketingAPI 实例，需实现 unifiedStructureBatch()
 * @param {{ sinceSec?: number, limit?: number, maxSoftPagesPerEdge?: number, markDirtyOnChange?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   synced_campaigns?: number,
 *   synced_adsets?: number,
 *   synced_ads?: number,
 *   edges?: { campaigns: { after: string|null }, adsets: { after: string|null }, ads: { after: string|null } },
 *   duration_ms?: number
 * }>}
 */
export async function fastSyncStructureForAccount(accountId, facebookApi, opts = {}) {
  const startTime = Date.now()
  let lockConnection = null
  const lockName = LOCK_PREFIX + accountId
  const rawMaxSoftPages = Number(opts?.maxSoftPagesPerEdge ?? 20)
  const MAX_SOFT_PAGES_PER_EDGE = Number.isFinite(rawMaxSoftPages)
    ? Math.max(1, Math.min(Math.floor(rawMaxSoftPages), 100))
    : 20

  try {
    const sinceSecRaw = Number(opts?.sinceSec)
    const sinceSec = Number.isFinite(sinceSecRaw)
      ? Math.floor(sinceSecRaw)
      : Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000)
    const limitRaw = Number(opts?.limit ?? 500)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 500
    const markDirtyOnChange = opts?.markDirtyOnChange !== false

    lockConnection = await pool.getConnection()
    const [lockRows] = await lockConnection.query(`SELECT GET_LOCK(?, 0) AS acquired`, [lockName])
    if (lockRows[0]?.acquired !== 1) {
      lockConnection.release()
      lockConnection = null
      return { ok: false, reason: 'lock_busy' }
    }

    const [statusRows] = await lockConnection.query(
      `SELECT last_sync_updated_ts FROM structure_sync_status WHERE account_id = ?`,
      [accountId]
    )
    const cursorTs = statusRows[0]?.last_sync_updated_ts != null
      ? Number(statusRows[0].last_sync_updated_ts)
      : null

    const batchResult = await facebookApi.unifiedStructureBatch(accountId, { sinceSec, limit })
    const campaigns = Array.isArray(batchResult?.campaigns?.items) ? [...batchResult.campaigns.items] : []
    const adsets = Array.isArray(batchResult?.adsets?.items) ? [...batchResult.adsets.items] : []
    const ads = Array.isArray(batchResult?.ads?.items) ? [...batchResult.ads.items] : []
    const criticalEdgeErrors = ['adsets', 'ads']
      .filter(edge => !!batchResult?.[edge]?.error)
      .map(edge => ({ edge, error: batchResult?.[edge]?.error }))
    if (criticalEdgeErrors.length > 0) {
      await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      lockConnection.release()
      lockConnection = null
      logger.warn(`[FastSync-MVP] account=${accountId} 关键edge失败，跳过写库 errors=${JSON.stringify(criticalEdgeErrors)}`)
      return { ok: false, reason: 'edge_failed', edge_errors: criticalEdgeErrors }
    }

    const edgeState = {
      campaigns: { after: batchResult?.campaigns?.after || null, pages: 0 },
      adsets: { after: batchResult?.adsets?.after || null, pages: 0 },
      ads: { after: batchResult?.ads?.after || null, pages: 0 }
    }
    const filtering = [{ field: 'updated_time', operator: 'GREATER_THAN', value: String(sinceSec) }]

    async function softFetchMore(edge, fields, bucket) {
      let after = edgeState[edge].after
      while (after && edgeState[edge].pages < MAX_SOFT_PAGES_PER_EDGE) {
        const page = await facebookApi.getStructurePage(accountId, edge, {
          fields,
          limit,
          after,
          filtering
        })
        edgeState[edge].pages += 1
        const items = Array.isArray(page?.items) ? page.items : []
        if (items.length > 0) bucket.push(...items)

        const nextAfter = page?.paging?.after ?? null
        edgeState[edge].after = nextAfter
        after = nextAfter

        if (items.length === 0 && !nextAfter) break
        if (after) await sleep(PAGE_DELAY_MS)
      }
      if (after && edgeState[edge].pages >= MAX_SOFT_PAGES_PER_EDGE) {
        logger.warn(
          `[FastSync-MVP] account=${accountId} edge=${edge} 软分页达到上限 ${MAX_SOFT_PAGES_PER_EDGE} 页，提前停止；last_after=${after}`
        )
      }
    }

    if (edgeState.campaigns.after) await softFetchMore('campaigns', CAMPAIGNS_FIELDS, campaigns)
    if (edgeState.adsets.after) await softFetchMore('adsets', ADSETS_FIELDS, adsets)
    if (edgeState.ads.after) await softFetchMore('ads', ADS_FIELDS, ads)

    await doStructureCampaignsUpsert(lockConnection, accountId, campaigns)
    await doStructureAdsetsUpsert(lockConnection, accountId, adsets)
    await doStructureAdsUpsertAndStatus(lockConnection, accountId, ads, cursorTs, false, sinceSec)
    const hasChanges = campaigns.length > 0 || adsets.length > 0 || ads.length > 0
    await lockConnection.execute(
      `INSERT INTO structure_sync_status
        (account_id, last_fast_sync_ts, last_fast_filter_since_sec, last_error, updated_at)
       VALUES
        (?, NOW(), ?, NULL, NOW())
       ON DUPLICATE KEY UPDATE
        last_fast_sync_ts = NOW(),
        last_fast_filter_since_sec = VALUES(last_fast_filter_since_sec),
        last_error = NULL,
        updated_at = NOW()`,
      [accountId, sinceSec]
    )
    if (markDirtyOnChange && hasChanges) {
      await lockConnection.execute(
        `UPDATE structure_sync_status
         SET fast_dirty = 1,
             fast_dirty_marked_at = NOW(),
             updated_at = NOW()
         WHERE account_id = ?`,
        [accountId]
      )
    }

    await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
    lockConnection.release()
    lockConnection = null

    const durationMs = Date.now() - startTime
    logger.info(
      `[FastSync-MVP] account=${accountId} sinceSec=${sinceSec} limit=${limit} ` +
      `campaigns=${campaigns.length} adsets=${adsets.length} ads=${ads.length} ` +
      `softPages(c/a/ad)=${edgeState.campaigns.pages}/${edgeState.adsets.pages}/${edgeState.ads.pages} duration_ms=${durationMs}`
    )

    return {
      ok: true,
      synced_campaigns: campaigns.length,
      synced_adsets: adsets.length,
      synced_ads: ads.length,
      dirty_marked: !!(markDirtyOnChange && hasChanges),
      edges: {
        campaigns: { after: edgeState.campaigns.after, pages: edgeState.campaigns.pages },
        adsets: { after: edgeState.adsets.after, pages: edgeState.adsets.pages },
        ads: { after: edgeState.ads.after, pages: edgeState.ads.pages }
      },
      duration_ms: durationMs
    }
  } catch (err) {
    if (lockConnection) {
      try {
        await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      } catch (_) {}
      lockConnection.release()
      lockConnection = null
    }
    throw err
  }
}

/**
 * 仅拉取 Track2 Fast Sync 数据（不写库），用于“全账户合并后批量 Upsert”。
 * - 账户级锁保护：防止与手动刷新/其他结构同步并发冲突
 */
export async function collectFastSyncDataForAccount(accountId, facebookApi, opts = {}) {
  let lockConnection = null
  const lockName = LOCK_PREFIX + accountId
  const rawMaxSoftPages = Number(opts?.maxSoftPagesPerEdge ?? 20)
  const maxSoftPages = Number.isFinite(rawMaxSoftPages)
    ? Math.max(1, Math.min(Math.floor(rawMaxSoftPages), 100))
    : 20
  const sinceSecRaw = Number(opts?.sinceSec)
  const sinceSec = Number.isFinite(sinceSecRaw)
    ? Math.floor(sinceSecRaw)
    : Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000)
  const limitRaw = Number(opts?.limit ?? 500)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 500

  try {
    lockConnection = await pool.getConnection()
    const [lockRows] = await lockConnection.query(`SELECT GET_LOCK(?, 0) AS acquired`, [lockName])
    if (lockRows[0]?.acquired !== 1) {
      lockConnection.release()
      lockConnection = null
      return { ok: false, reason: 'lock_busy', accountId }
    }

    const batchResult = await facebookApi.unifiedStructureBatch(accountId, { sinceSec, limit })
    const campaigns = Array.isArray(batchResult?.campaigns?.items) ? [...batchResult.campaigns.items] : []
    const adsets = Array.isArray(batchResult?.adsets?.items) ? [...batchResult.adsets.items] : []
    const ads = Array.isArray(batchResult?.ads?.items) ? [...batchResult.ads.items] : []
    const criticalEdgeErrors = ['adsets', 'ads']
      .filter(edge => !!batchResult?.[edge]?.error)
      .map(edge => ({ edge, error: batchResult?.[edge]?.error }))
    if (criticalEdgeErrors.length > 0) {
      await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      lockConnection.release()
      lockConnection = null
      logger.warn(`[FastSync-Collect] account=${accountId} 关键edge失败，返回失败 errors=${JSON.stringify(criticalEdgeErrors)}`)
      return { ok: false, reason: 'edge_failed', accountId, edge_errors: criticalEdgeErrors }
    }

    const edgeState = {
      campaigns: { after: batchResult?.campaigns?.after || null, pages: 0 },
      adsets: { after: batchResult?.adsets?.after || null, pages: 0 },
      ads: { after: batchResult?.ads?.after || null, pages: 0 }
    }
    const filtering = [{ field: 'updated_time', operator: 'GREATER_THAN', value: String(sinceSec) }]

    async function softFetchMore(edge, fields, bucket) {
      let after = edgeState[edge].after
      while (after && edgeState[edge].pages < maxSoftPages) {
        const page = await facebookApi.getStructurePage(accountId, edge, {
          fields,
          limit,
          after,
          filtering
        })
        edgeState[edge].pages += 1
        const items = Array.isArray(page?.items) ? page.items : []
        if (items.length > 0) bucket.push(...items)
        const nextAfter = page?.paging?.after ?? null
        edgeState[edge].after = nextAfter
        after = nextAfter
        if (items.length === 0 && !nextAfter) break
        if (after) await sleep(PAGE_DELAY_MS)
      }
      if (after && edgeState[edge].pages >= maxSoftPages) {
        logger.warn(`[FastSync-Collect] account=${accountId} edge=${edge} 软分页达到上限 ${maxSoftPages} 页，提前停止；last_after=${after}`)
      }
    }

    if (edgeState.campaigns.after) await softFetchMore('campaigns', CAMPAIGNS_FIELDS, campaigns)
    if (edgeState.adsets.after) await softFetchMore('adsets', ADSETS_FIELDS, adsets)
    if (edgeState.ads.after) await softFetchMore('ads', ADS_FIELDS, ads)

    await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
    lockConnection.release()
    lockConnection = null

    return {
      ok: true,
      accountId,
      sinceSec,
      campaigns,
      adsets,
      ads,
      edges: edgeState
    }
  } catch (err) {
    if (lockConnection) {
      try { await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName]) } catch (_) {}
      lockConnection.release()
      lockConnection = null
    }
    throw err
  }
}

function pickNewerByUpdatedTime(existing, incoming) {
  if (!existing) return incoming
  const e = normalizeUpdatedTimeToUtcZ(existing.updated_time) || ''
  const n = normalizeUpdatedTimeToUtcZ(incoming.updated_time) || ''
  return n >= e ? incoming : existing
}

/**
 * Track2 全账户合并 + 去重 + 分块批量 Upsert
 * @param {Array<{ ok: boolean, accountId: string, sinceSec: number, campaigns: Array, adsets: Array, ads: Array }>} payloads
 * @param {{ markDirtyOnChange?: boolean, chunkSize?: number }} opts
 */
export async function applyMergedFastSyncPayload(payloads, opts = {}) {
  const list = (Array.isArray(payloads) ? payloads : []).filter(p => p && p.ok && p.accountId)
  if (list.length === 0) {
    return { ok: true, accounts: 0, campaigns: 0, adsets: 0, ads: 0, dirtyMarked: 0 }
  }

  const markDirtyOnChange = opts?.markDirtyOnChange !== false
  const chunkSizeRaw = Number(opts?.chunkSize ?? 300)
  const chunkSize = Number.isFinite(chunkSizeRaw) ? Math.max(50, Math.min(Math.floor(chunkSizeRaw), 500)) : 300

  const campaignMap = new Map()
  const adsetMap = new Map()
  const adMap = new Map()
  const perAccountMeta = new Map() // accountId -> { sinceSec, hasChanges, maxUpdatedTs }

  for (const p of list) {
    const accountId = String(p.accountId)
    if (!perAccountMeta.has(accountId)) {
      perAccountMeta.set(accountId, { sinceSec: p.sinceSec, hasChanges: false, maxUpdatedTs: null })
    } else if (Number.isFinite(Number(p.sinceSec))) {
      perAccountMeta.get(accountId).sinceSec = Number(p.sinceSec)
    }

    const campaigns = Array.isArray(p.campaigns) ? p.campaigns : []
    const adsets = Array.isArray(p.adsets) ? p.adsets : []
    const ads = Array.isArray(p.ads) ? p.ads : []
    if (campaigns.length > 0 || adsets.length > 0 || ads.length > 0) perAccountMeta.get(accountId).hasChanges = true

    for (const item of campaigns) {
      const id = String(item?.id || '')
      if (!id) continue
      const key = `${accountId}:${id}`
      campaignMap.set(key, pickNewerByUpdatedTime(campaignMap.get(key), { ...item, account_id: accountId }))
    }
    for (const item of adsets) {
      const id = String(item?.id || '')
      if (!id) continue
      const key = `${accountId}:${id}`
      adsetMap.set(key, pickNewerByUpdatedTime(adsetMap.get(key), { ...item, account_id: accountId }))
    }
    for (const item of ads) {
      const id = String(item?.id || '')
      if (!id) continue
      const key = `${accountId}:${id}`
      adMap.set(key, pickNewerByUpdatedTime(adMap.get(key), { ...item, account_id: accountId }))
      const ts = updatedTimeToUnixSec(item.updated_time)
      if (ts != null) {
        const old = perAccountMeta.get(accountId).maxUpdatedTs
        perAccountMeta.get(accountId).maxUpdatedTs = old == null ? ts : Math.max(old, ts)
      }
    }
  }

  const campaignRows = [...campaignMap.values()]
  const adsetRows = [...adsetMap.values()]
  const adRows = [...adMap.values()]

  async function upsertCampaigns(rows) {
    if (rows.length === 0) return
    const base = `
      INSERT INTO structure_campaigns
        (account_id, campaign_id, name, effective_status, status, updated_time, created_time, last_synced_at)
      VALUES
    `
    const update = `
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        effective_status = VALUES(effective_status),
        status = VALUES(status),
        updated_time = VALUES(updated_time),
        created_time = VALUES(created_time),
        last_synced_at = NOW()
    `
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize)
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
      const values = []
      for (const r of chunk) {
        values.push(
          r.account_id,
          r.id,
          r.name ?? null,
          r.effective_status ?? null,
          r.status ?? null,
          normalizeUpdatedTimeToUtcZ(r.updated_time) ?? null,
          normalizeUpdatedTimeToUtcZ(r.created_time) ?? r.created_time ?? null
        )
      }
      await pool.execute(base + placeholders + update, values)
    }
  }

  async function upsertAdsets(rows) {
    if (rows.length === 0) return
    const base = `
      INSERT INTO structure_adsets
        (account_id, adset_id, campaign_id, name, effective_status, status, updated_time, created_time, last_synced_at)
      VALUES
    `
    const update = `
      ON DUPLICATE KEY UPDATE
        campaign_id = VALUES(campaign_id),
        name = VALUES(name),
        effective_status = VALUES(effective_status),
        status = VALUES(status),
        updated_time = VALUES(updated_time),
        created_time = VALUES(created_time),
        last_synced_at = NOW()
    `
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize)
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
      const values = []
      for (const r of chunk) {
        values.push(
          r.account_id,
          r.id,
          r.campaign_id ?? null,
          r.name ?? null,
          r.effective_status ?? null,
          r.status ?? null,
          normalizeUpdatedTimeToUtcZ(r.updated_time) ?? null,
          normalizeUpdatedTimeToUtcZ(r.created_time) ?? r.created_time ?? null
        )
      }
      await pool.execute(base + placeholders + update, values)
    }
  }

  async function upsertAds(rows) {
    if (rows.length === 0) return
    const accountIds = [...new Set(rows.map((r) => r.account_id))]
    const accountMaps = new Map()
    for (const aid of accountIds) {
      accountMaps.set(aid, await loadStructureAdsMapForAccount(null, aid))
    }
    const base = `
      INSERT INTO structure_ads
        (account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time, created_time, last_synced_at)
      VALUES
    `
    const update = `
      ON DUPLICATE KEY UPDATE
        adset_id = VALUES(adset_id),
        campaign_id = VALUES(campaign_id),
        name = VALUES(name),
        effective_status = VALUES(effective_status),
        status = VALUES(status),
        configured_status = VALUES(configured_status),
        updated_time = VALUES(updated_time),
        created_time = VALUES(created_time),
        last_synced_at = NOW()
    `
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize)
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
      const values = []
      for (const r of chunk) {
        const aid = r.account_id
        const adId = String(r.id ?? '')
        const name = r.name ?? null
        const eff = r.effective_status ?? null
        const old = accountMaps.get(aid)?.get(adId)
        if (name !== old?.name || eff !== old?.effective_status) {
          pushStructureAdsHistory({ account_id: aid, ad_id: adId, name, effective_status: eff, source: 'track2_fast_sync' })
        }
        if (!accountMaps.has(aid)) accountMaps.set(aid, new Map())
        accountMaps.get(aid).set(adId, { name, effective_status: eff })
        values.push(
          aid,
          r.id,
          r.adset_id ?? null,
          r.campaign_id ?? null,
          name,
          eff,
          r.status ?? null,
          r.configured_status ?? null,
          normalizeUpdatedTimeToUtcZ(r.updated_time) ?? null,
          normalizeUpdatedTimeToUtcZ(r.created_time) ?? r.created_time ?? null
        )
      }
      await pool.execute(base + placeholders + update, values)
    }
  }

  await upsertCampaigns(campaignRows)
  await upsertAdsets(adsetRows)
  await upsertAds(adRows)

  let dirtyMarked = 0
  for (const [accountId, meta] of perAccountMeta.entries()) {
    await pool.execute(
      `INSERT INTO structure_sync_status
        (account_id, last_success_at, last_error, updated_at, last_sync_updated_ts, last_filter_since_sec, last_fast_sync_ts, last_fast_filter_since_sec)
       VALUES
        (?, NOW(), NULL, NOW(), ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
        last_success_at = NOW(),
        last_error = NULL,
        updated_at = NOW(),
        last_sync_updated_ts = COALESCE(VALUES(last_sync_updated_ts), last_sync_updated_ts),
        last_filter_since_sec = COALESCE(VALUES(last_filter_since_sec), last_filter_since_sec),
        last_fast_sync_ts = NOW(),
        last_fast_filter_since_sec = VALUES(last_fast_filter_since_sec)`,
      [accountId, meta.maxUpdatedTs, meta.sinceSec ?? null, meta.sinceSec ?? null]
    )
    if (markDirtyOnChange && meta.hasChanges) {
      await pool.execute(
        `UPDATE structure_sync_status
         SET fast_dirty = 1,
             fast_dirty_marked_at = NOW(),
             updated_at = NOW()
         WHERE account_id = ?`,
        [accountId]
      )
      dirtyMarked++
    }
  }

  return {
    ok: true,
    accounts: list.length,
    campaigns: campaignRows.length,
    adsets: adsetRows.length,
    ads: adRows.length,
    dirtyMarked
  }
}

/** 每小时结构轮转（近 3 天）：默认 6 账户，可调 12；并发固定 1；usage 高/熔断时本小时跳过 */
const HOURLY_FULL_DEFAULT_ACCOUNTS = 6
const HOURLY_FULL_MAX_ACCOUNTS = 12
const HOURLY_FULL_DEFAULT_ACCOUNT_CONCURRENCY = 5
const USAGE_SKIP_THRESHOLD = 85

const ROTATION_GLOBAL_LOCK = 'sync:hourly_rotation'

/**
 * 每小时结构轮转（近 3 天）（P1，永远让路 P0）。
 * 逐账户调用结构同步（默认旧路径 syncAccountStructureAds；可选 unified batch fast path）。
 * 防重入：全局 GET_LOCK 保证同一时间仅一轮轮转在跑。
 * 优先 has_full_synced=0 或 last_full_count=0；本地 count=0 且 has_full_synced=1 时全量修复。
 * @param {Object} facebookApi
 * @param {{ maxAccounts?: number, accountConcurrency?: number, useUnifiedBatch?: boolean, unifiedLimit?: number, unifiedMaxSoftPages?: number }} opts
 */
export async function runHourlyStructureFullRotation(facebookApi, opts = {}) {
  if (getCircuitBreakerStatus().isLocked) {
    logger.info('[结构轮转-近3天] 本小时跳过：Token 熔断')
    return { skipped: true, reason: 'circuit_breaker', synced: 0 }
  }
  const usage = getLastUsageRate()
  if (usage != null && usage >= USAGE_SKIP_THRESHOLD) {
    logger.info(`[结构轮转-近3天] 本小时跳过：API 使用率 ${usage}% >= ${USAGE_SKIP_THRESHOLD}%`)
    return { skipped: true, reason: 'usage_high', synced: 0 }
  }

  let rotationConn = null
  try {
    rotationConn = await pool.getConnection()
    const [lockRows] = await rotationConn.query(`SELECT GET_LOCK(?, 0) AS acquired`, [ROTATION_GLOBAL_LOCK])
    if (lockRows[0]?.acquired !== 1) {
      logger.info('[结构轮转-近3天] 本小时跳过：上一轮仍在执行，防重入')
      return { skipped: true, reason: 'rotation_running', synced: 0 }
    }

  const maxAccounts = Math.min(HOURLY_FULL_MAX_ACCOUNTS, opts.maxAccounts ?? HOURLY_FULL_DEFAULT_ACCOUNTS)
  const accountConcurrencyRaw = Number(opts.accountConcurrency ?? HOURLY_FULL_DEFAULT_ACCOUNT_CONCURRENCY)
  const accountConcurrency = Number.isFinite(accountConcurrencyRaw)
    ? Math.max(1, Math.min(Math.floor(accountConcurrencyRaw), HOURLY_FULL_DEFAULT_ACCOUNT_CONCURRENCY))
    : HOURLY_FULL_DEFAULT_ACCOUNT_CONCURRENCY
  const useUnifiedBatch = opts.useUnifiedBatch === true
  const unifiedLimitRaw = Number(opts.unifiedLimit ?? 500)
  const unifiedLimit = Number.isFinite(unifiedLimitRaw) ? Math.max(1, Math.min(Math.floor(unifiedLimitRaw), 500)) : 500
  const unifiedMaxSoftPagesRaw = Number(opts.unifiedMaxSoftPages ?? 20)
  const unifiedMaxSoftPages = Number.isFinite(unifiedMaxSoftPagesRaw) ? Math.max(1, Math.min(Math.floor(unifiedMaxSoftPagesRaw), 100)) : 20
  const threeDaysAgoSec = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000)
  const [rows] = await pool.query(
    `SELECT am.fb_account_id AS account_id,
            COALESCE(s.has_full_synced, 0) AS has_full_synced,
            COALESCE(s.last_full_count, -1) AS last_full_count,
            (SELECT COUNT(*) FROM structure_ads a WHERE a.account_id = am.fb_account_id) AS local_count
     FROM account_mappings am
     LEFT JOIN structure_sync_status s ON am.fb_account_id = s.account_id
     WHERE am.is_active = 1
     ORDER BY
       (CASE WHEN COALESCE(s.has_full_synced, 0) = 0 OR COALESCE(s.last_full_count, 0) = 0 THEN 0
             WHEN (SELECT COUNT(*) FROM structure_ads a WHERE a.account_id = am.fb_account_id) = 0 AND COALESCE(s.has_full_synced, 0) = 1 THEN 1
             ELSE 2 END),
       s.last_success_at ASC
     LIMIT ?`,
    [maxAccounts]
  )
  const toSync = (rows || []).map(r => String(r.account_id || '')).filter(Boolean)
  if (toSync.length === 0) {
    return { skipped: false, reason: null, synced: 0 }
  }
  logger.info(`[结构轮转-近3天] 本小时处理 ${toSync.length} 个账户（mode=${useUnifiedBatch ? 'unified_batch' : 'legacy'}, accountConcurrency=${accountConcurrency}）`)
  const accountLimit = pLimit(accountConcurrency)
  const results = await Promise.all(toSync.map((accountId) =>
    accountLimit(async () => {
      try {
        const result = useUnifiedBatch
          ? await fastSyncStructureForAccount(accountId, facebookApi, {
              sinceSec: threeDaysAgoSec,
              limit: unifiedLimit,
              maxSoftPagesPerEdge: unifiedMaxSoftPages,
              markDirtyOnChange: false
            })
          : await syncAccountStructureAds(accountId, facebookApi)
        if (!result.ok && result.reason === 'cooldown') logger.info(`[结构轮转-近3天] account=${accountId} 冷却中跳过`)
        else if (!result.ok && result.reason === 'lock_busy') logger.info(`[结构轮转-近3天] account=${accountId} 锁占用跳过`)
        return { accountId, ok: !!result.ok }
      } catch (err) {
        logger.warn(`[结构轮转-近3天] account=${accountId} 失败:`, err.message)
        return { accountId, ok: false }
      }
    })
  ))
  const synced = results.filter(r => r.ok).length
  return { skipped: false, reason: null, synced }
  } finally {
    if (rotationConn) {
      try {
        await rotationConn.query(`SELECT RELEASE_LOCK(?)`, [ROTATION_GLOBAL_LOCK])
      } catch (e) {
        logger.warn('[结构轮转-近3天] 释放全局锁失败:', e?.message)
      }
      rotationConn.release()
      rotationConn = null
    }
  }
}

/**
 * 结构完整性自愈：确保任意 structure_ads 的 campaign_id / adset_id 都能在对应上层结构表中找到
 * 
 * 场景：structure_ads 已有子广告，但 structure_campaigns 或 structure_adsets 暂未补齐（增量同步窗口可能导致）
 * 策略：对缺失的上层对象，写入最小占位记录保证关系链闭合
 * 
 * @param {string} [accountId] - 可选，指定账户；不传则检查全部活跃账户
 * @returns {Promise<{ campaignsHealed: number, adsetsHealed: number, errors: string[] }>}
 */
export async function healStructureIntegrity(accountId = null) {
  const result = { campaignsHealed: 0, adsetsHealed: 0, errors: [] }
  const accountFilter = accountId ? 'AND sa.account_id = ?' : ''

  try {
    // 1. 找出 structure_ads 中存在但 structure_campaigns 缺失的 campaign_id
    const [missingCampaigns] = await pool.query(
      `SELECT DISTINCT sa.account_id, sa.campaign_id
       FROM structure_ads sa
       LEFT JOIN structure_campaigns sc ON sa.account_id = sc.account_id AND sa.campaign_id = sc.campaign_id
       WHERE sc.campaign_id IS NULL
         AND sa.campaign_id IS NOT NULL
         AND sa.campaign_id != ''
         ${accountFilter}
       LIMIT 1000`,
      accountId ? [accountId] : []
    )

    if (missingCampaigns.length > 0) {
      logger.warn(`[结构自愈] 发现 ${missingCampaigns.length} 个缺失的 structure_campaigns 记录`)
      const values = []
      const params = []
      for (const row of missingCampaigns) {
        values.push('(?, ?, ?)')
        params.push(row.account_id, row.campaign_id, row.campaign_id)
      }
      try {
        await pool.query(
          `INSERT IGNORE INTO structure_campaigns (account_id, campaign_id, name) VALUES ${values.join(',')}`,
          params
        )
        result.campaignsHealed = missingCampaigns.length
        logger.info(`[结构自愈] 已补全 ${result.campaignsHealed} 条 structure_campaigns 占位记录`)
      } catch (err) {
        result.errors.push(`structure_campaigns 补全失败: ${err.message}`)
        logger.error(`[结构自愈] structure_campaigns 补全失败:`, err.message)
      }
    }

    // 2. 找出 structure_ads 中存在但 structure_adsets 缺失的 adset_id
    const [missingAdsets] = await pool.query(
      `SELECT DISTINCT sa.account_id, sa.adset_id, MAX(sa.campaign_id) AS campaign_id
       FROM structure_ads sa
       LEFT JOIN structure_adsets sas ON sa.account_id = sas.account_id AND sa.adset_id = sas.adset_id
       WHERE sas.adset_id IS NULL
         AND sa.adset_id IS NOT NULL
         AND sa.adset_id != ''
         ${accountFilter}
       GROUP BY sa.account_id, sa.adset_id
       LIMIT 1000`,
      accountId ? [accountId] : []
    )

    if (missingAdsets.length > 0) {
      logger.warn(`[结构自愈] 发现 ${missingAdsets.length} 个缺失的 structure_adsets 记录`)
      const values = []
      const params = []
      for (const row of missingAdsets) {
        values.push('(?, ?, ?, ?)')
        params.push(row.account_id, row.adset_id, row.adset_id, row.campaign_id || row.adset_id)
      }
      try {
        await pool.query(
          `INSERT IGNORE INTO structure_adsets (account_id, adset_id, name, campaign_id) VALUES ${values.join(',')}`,
          params
        )
        result.adsetsHealed = missingAdsets.length
        logger.info(`[结构自愈] 已补全 ${result.adsetsHealed} 条 structure_adsets 占位记录`)
      } catch (err) {
        result.errors.push(`structure_adsets 补全失败: ${err.message}`)
        logger.error(`[结构自愈] structure_adsets 补全失败:`, err.message)
      }
    }

    if (result.campaignsHealed === 0 && result.adsetsHealed === 0) {
      logger.debug('[结构自愈] 结构完整性检查通过，无需修复')
    }
  } catch (err) {
    result.errors.push(`结构自愈整体失败: ${err.message}`)
    logger.error('[结构自愈] 结构完整性检查异常:', err.message)
  }

  return result
}
