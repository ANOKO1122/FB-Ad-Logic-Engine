/**
 * 结构同步服务（顺序2 阶段 2.4）
 * 从 FB 拉取指定账户的 ads 结构并写入 structure_ads 表，供选择器读库使用。
 * 约束：账户级锁 + 冷却期 2 分钟。
 */
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { getCircuitBreakerStatus, getLastUsageRate } from './rateLimitService.js'

const COOLDOWN_MS = 120_000  // 2 分钟
const LOCK_PREFIX = 'sync:structure:'
// 每页之间间隔，减轻 FB 限流（手动同步是重型路径，宁愿慢一点也不要 burst 撞限流）
const PAGE_DELAY_MS = 1200
const ADS_FIELDS = 'id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time'
const CAMPAIGNS_FIELDS = 'id,name,effective_status,status,updated_time'
const ADSETS_FIELDS = 'id,name,effective_status,status,campaign_id,updated_time'

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
 * 分页：基于 structure_ads.id 的稳定游标，返回 paging.after。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureAdsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  const statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

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
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  // LIMIT 不能使用占位符（MySQL 预处理会报 ER_WRONG_ARGUMENTS），limit 已校验为 1..500，安全内联
  const limitRows = Math.min(501, limit + 1)
  sql += ` ORDER BY id ASC LIMIT ${limitRows}`

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
 * 过滤口径与 listStructureAdsFromDb 一致。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureCampaignsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  const statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

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
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  const limitRows = Math.min(501, limit + 1)
  sql += ` ORDER BY id ASC LIMIT ${limitRows}`

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
 * 过滤口径与 listStructureAdsFromDb 一致。
 *
 * @param {string} accountId - 广告账户 ID
 * @param {Object} opts - { q, limit, after, include_paused }
 * @returns {Promise<{ items: Array, paging: { after: string|null } }>}
 */
export async function listStructureAdsetsFromDb(accountId, opts = {}) {
  const q = String(opts.q || '').trim()
  const includePaused = opts.include_paused === '1' || opts.include_paused === true
  const rawLimit = Number(opts.limit || 50)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
  const after = opts.after != null && opts.after !== '' ? String(opts.after).trim() : null

  const statusList = q === ''
    ? (includePaused ? ['ACTIVE', 'PAUSED'] : ['ACTIVE'])
    : EFFECTIVE_STATUS_FILTER

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
  if (after) {
    sql += ` AND id > ?`
    params.push(after)
  }
  const limitRows = Math.min(501, limit + 1)
  sql += ` ORDER BY id ASC LIMIT ${limitRows}`

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
 * @param {Object} opts - { type, q, limit, after, include_paused }
 * @returns {Promise<{ items: Array<{ id, type, name, campaign_id, adset_id, effective_status, account_id }>, paging }>}
 */
export async function listStructureObjectsFromDb(accountId, opts = {}) {
  const type = String(opts.type || '').toLowerCase()
  const allowed = ['campaign', 'adset', 'ad']
  if (!allowed.includes(type)) {
    throw new Error(`type 只允许 campaign | adset | ad，当前: ${opts.type}`)
  }
  const listOpts = { q: opts.q, limit: opts.limit, after: opts.after, include_paused: opts.include_paused }
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
    (account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE
    adset_id = VALUES(adset_id),
    campaign_id = VALUES(campaign_id),
    name = VALUES(name),
    effective_status = VALUES(effective_status),
    status = VALUES(status),
    configured_status = VALUES(configured_status),
    updated_time = VALUES(updated_time),
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
        const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(payload.updated_time)
        await pool.execute(UPSERT_STRUCTURE_SQL, [
          accountId, adId,
          payload.adset_id ?? null, payload.campaign_id ?? null, payload.name ?? null,
          payload.effective_status ?? null, payload.status ?? null, payload.configured_status ?? null,
          updatedTimeNorm ?? null
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
        const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(ad.updated_time)
        await pool.execute(UPSERT_STRUCTURE_SQL, [
          accountId, id,
          ad.adset_id ?? null, ad.campaign_id ?? null, ad.name ?? null,
          ad.effective_status ?? null, ad.status ?? null, ad.configured_status ?? null,
          updatedTimeNorm ?? null
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

    const resolved = await facebookApi.resolveObjectsByIds(diffIds, { fields: ADS_FIELDS })
    let touched = 0
    for (const ad of resolved) {
      const id = String(ad.id || '')
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(ad.updated_time)
      await pool.execute(UPSERT_STRUCTURE_SQL, [
        accountId, id,
        ad.adset_id ?? null, ad.campaign_id ?? null, ad.name ?? null,
        ad.effective_status ?? null, ad.status ?? null, ad.configured_status ?? null,
        updatedTimeNorm ?? null
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

/** 实验开关：是否允许手动同步时尝试 updated_time 增量（文档已禁止作为主策略，现网不可靠，默认关闭） */
const ENABLE_INCREMENTAL_EXPERIMENT = false

/**
 * 执行 structure_ads 批量 upsert 和 structure_sync_status 更新（共享逻辑）
 * @param {Object} lockConnection
 * @param {string} accountId
 * @param {Array} allItems
 * @param {number|null} cursorTs - 当前游标
 * @param {boolean} isFullRun
 */
async function doStructureAdsUpsertAndStatus(lockConnection, accountId, allItems, cursorTs, isFullRun) {
  const UPSERT_BATCH_SIZE = 50
  const upsertBase = `
    INSERT INTO structure_ads
      (account_id, ad_id, adset_id, campaign_id, name, effective_status, status, configured_status, updated_time, last_synced_at)
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
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      values.push(
        accountId,
        item.id,
        item.adset_id ?? null,
        item.campaign_id ?? null,
        item.name ?? null,
        item.effective_status ?? null,
        item.status ?? null,
        item.configured_status ?? null,
        updatedTimeNorm ?? item.updated_time ?? null
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
      (account_id, last_success_at, last_error, updated_at, last_sync_updated_ts, last_full_count, has_full_synced, last_full_success_at)
    VALUES
      (?, NOW(), NULL, NOW(), ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      last_success_at = NOW(),
      last_error = NULL,
      updated_at = NOW(),
      last_sync_updated_ts = IF(? = 1, ?, last_sync_updated_ts),
      last_full_count = COALESCE(?, last_full_count),
      has_full_synced = CASE WHEN ? = 1 THEN 1 ELSE has_full_synced END,
      last_full_success_at = COALESCE(?, last_full_success_at)
  `
  await lockConnection.execute(upsertStatusSql, [
    accountId,
    newCursorTs,
    fullCount,
    isFullRun ? 1 : 0,
    fullSuccessAt,
    cursorChanged ? 1 : 0,
    newCursorTs,
    fullCount,
    isFullRun ? 1 : 0,
    fullSuccessAt
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
      (account_id, campaign_id, name, effective_status, status, updated_time, last_synced_at)
    VALUES
  `
  const upsertUpdate = `
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      effective_status = VALUES(effective_status),
      status = VALUES(status),
      updated_time = VALUES(updated_time),
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      values.push(
        accountId,
        item.id,
        item.name ?? null,
        item.effective_status ?? null,
        item.status ?? null,
        updatedTimeNorm ?? null
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
      (account_id, adset_id, campaign_id, name, effective_status, status, updated_time, last_synced_at)
    VALUES
  `
  const upsertUpdate = `
    ON DUPLICATE KEY UPDATE
      campaign_id = VALUES(campaign_id),
      name = VALUES(name),
      effective_status = VALUES(effective_status),
      status = VALUES(status),
      updated_time = VALUES(updated_time),
      last_synced_at = NOW()
  `
  for (let i = 0; i < allItems.length; i += UPSERT_BATCH_SIZE) {
    const chunk = allItems.slice(i, i + UPSERT_BATCH_SIZE)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')
    const values = []
    for (const item of chunk) {
      const updatedTimeNorm = normalizeUpdatedTimeToUtcZ(item.updated_time)
      values.push(
        accountId,
        item.id,
        item.campaign_id ?? null,
        item.name ?? null,
        item.effective_status ?? null,
        item.status ?? null,
        updatedTimeNorm ?? null
      )
    }
    await lockConnection.execute(upsertBase + placeholders + upsertUpdate, values)
  }
}

/**
 * 强制同步该账户的广告结构到 structure_ads（顺序2 2.4：重型全量/分页路径）
 * 默认策略：仅全量分页，不依赖 /ads 的 updated_time filtering（已证伪）。
 * 可选实验：ENABLE_INCREMENTAL_EXPERIMENT=true 时先尝试增量，失败/回退仍走全量。
 * @param {string} accountId - 广告账户 ID（如 act_xxx）
 * @param {Object} facebookApi - 已构造的 FacebookMarketingAPI 实例，需有 getStructurePage(accountId, edge, opts)
 * @param {Object} [opts] - 可选，{ useIncrementalExperiment: boolean } 覆盖实验开关
 * @returns {Promise<{ ok: boolean, reason?: string, synced_count?: number, duration_ms?: number, retry_after_sec?: number }>}
 */
export async function syncAccountStructureAds(accountId, facebookApi, opts = {}) {
  const startTime = Date.now()
  let lockConnection = null
  const lockName = LOCK_PREFIX + accountId
  const useIncrementalExperiment = opts.useIncrementalExperiment ?? ENABLE_INCREMENTAL_EXPERIMENT

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

    // 冷却期：按「上一次重型全量同步成功时间」structure_sync_status.last_success_at，避免被 Piggyback/伪增量误触发
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

    // ✅ 预检：若最近一次已知的 API 使用率很高，提前拒绝“重型全量同步”
    // 目的：避免在配额紧张时继续触发 FB 的 user request limit（更差体验：前端 90s 超时）
    const usageRate = getLastUsageRate()
    if (usageRate != null && Number.isFinite(Number(usageRate)) && Number(usageRate) >= 85) {
      const r = Number(usageRate)
      // 保守退避：使用率越高，建议等待越久（秒）
      const retryAfterSec = r >= 95 ? 3600 : (r >= 90 ? 600 : 120)
      await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      lockConnection.release()
      lockConnection = null
      logger.warn(`[2.4] usage 高，跳过手动结构全量 account=${accountId} usageRate=${r} retry_after_sec=${retryAfterSec}`)
      return { ok: false, reason: 'quota_high', retry_after_sec: retryAfterSec }
    }

    // 读取 structure_sync_status（仅全量时用于异常态判定；不再用游标做默认增量）
    const [statusRows] = await lockConnection.query(
      `SELECT last_sync_updated_ts, last_full_count, has_full_synced FROM structure_sync_status WHERE account_id = ?`,
      [accountId]
    )
    const status = statusRows[0] || null
    const cursorTs = status?.last_sync_updated_ts != null ? Number(status.last_sync_updated_ts) : null
    const lastFullCount = status?.last_full_count != null ? Number(status.last_full_count) : null
    const [countRows] = await lockConnection.query(
      `SELECT COUNT(*) AS n FROM structure_ads WHERE account_id = ?`,
      [accountId]
    )
    const currentLocalCount = Number(countRows[0]?.n ?? 0)

    const baseFiltering = [{ field: 'effective_status', operator: 'IN', value: EFFECTIVE_STATUS_FILTER }]

    // 1. campaigns：分页全量拉取并 upsert（不传 filtering：campaigns edge 对部分 status 值不兼容，易触发 FB #100；展示侧再过滤）
    const allCampaigns = []
    let campAfter = null
    do {
      const page = await facebookApi.getStructurePage(accountId, 'campaigns', {
        fields: CAMPAIGNS_FIELDS,
        limit: 100,
        after: campAfter,
        filtering: null
      })
      if (page?.items?.length) allCampaigns.push(...page.items)
      campAfter = page?.paging?.after ?? null
      if (campAfter) await sleep(PAGE_DELAY_MS)
    } while (campAfter)
    await doStructureCampaignsUpsert(lockConnection, accountId, allCampaigns)
    logger.info(`[2.4] campaigns 同步 account=${accountId} count=${allCampaigns.length}`)

    // 2. adsets：分页全量拉取并 upsert（不传 filtering：adsets edge 对部分 status 值不兼容，易触发 FB #100；展示侧再过滤）
    const allAdsets = []
    let adsetAfter = null
    do {
      const page = await facebookApi.getStructurePage(accountId, 'adsets', {
        fields: ADSETS_FIELDS,
        limit: 100,
        after: adsetAfter,
        filtering: null
      })
      if (page?.items?.length) allAdsets.push(...page.items)
      adsetAfter = page?.paging?.after ?? null
      if (adsetAfter) await sleep(PAGE_DELAY_MS)
    } while (adsetAfter)
    await doStructureAdsetsUpsert(lockConnection, accountId, allAdsets)
    logger.info(`[2.4] adsets 同步 account=${accountId} count=${allAdsets.length}`)

    let allItems = []
    let usedIncremental = false
    let fallbackReason = null

    // 仅当实验开关开启时尝试 updated_time 增量（文档禁止作为主策略，默认不执行）
    if (useIncrementalExperiment && cursorTs != null && Number.isFinite(cursorTs)) {
      const sinceTs = Math.max(0, cursorTs - 300)
      const sinceISO = new Date(sinceTs * 1000).toISOString()
      const incrementalFiltering = [...baseFiltering, { field: 'updated_time', operator: 'GREATER_THAN', value: sinceISO }]
      try {
        let after = null
        do {
          const page = await facebookApi.getStructurePage(accountId, 'ads', {
            fields: ADS_FIELDS,
            limit: 100,
            after,
            filtering: incrementalFiltering
          })
          if (page && Array.isArray(page.items) && page.items.length) allItems.push(...page.items)
          after = page?.paging?.after ?? null
          if (after) await sleep(PAGE_DELAY_MS)
        } while (after)
        usedIncremental = true
        if (allItems.length === 0) {
          const shouldFallback = currentLocalCount === 0 ||
            (lastFullCount != null && lastFullCount > 0 && currentLocalCount < lastFullCount * 0.3)
          if (shouldFallback) {
            fallbackReason = 'incremental_0_and_abnormal_local'
            usedIncremental = false
            allItems = []
          }
        }
      } catch (err) {
        usedIncremental = false
        fallbackReason = err.message || 'api_or_filter_error'
        allItems = []
        logger.warn(`[2.4] 实验增量请求失败，回退全量 account=${accountId} error=${err.message}`)
      }
    }

    // 默认路径：全量分页（手动同步 = 重型全量；或实验增量未用/回退后走这里）
    if (!usedIncremental) {
      if (fallbackReason) logger.warn(`[2.4] 回退全量 account=${accountId} reason=${fallbackReason}`)
      allItems = []
      let after = null
      do {
        const page = await facebookApi.getStructurePage(accountId, 'ads', {
          fields: ADS_FIELDS,
          limit: 100,
          after,
          filtering: baseFiltering
        })
        if (page?.items?.length) allItems.push(...page.items)
        after = page?.paging?.after ?? null
        if (after) await sleep(PAGE_DELAY_MS)
      } while (after)
    }

    const isFullRun = !usedIncremental || (usedIncremental && fallbackReason)
    await doStructureAdsUpsertAndStatus(lockConnection, accountId, allItems, cursorTs, isFullRun)

    await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
    lockConnection.release()
    lockConnection = null

    const durationMs = Date.now() - startTime
    const mode = usedIncremental && !fallbackReason ? 'incremental' : 'full'
    logger.info(`✅ [2.4] 结构同步完成 account=${accountId} mode=${mode} campaigns=${allCampaigns.length} adsets=${allAdsets.length} ads=${allItems.length} duration_ms=${durationMs}${fallbackReason ? ` fallback_reason=${fallbackReason}` : ''}`)
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

/** 每小时结构全量轮转：默认 6 账户，可调 12；并发固定 1；usage 高/熔断时本小时跳过 */
const HOURLY_FULL_DEFAULT_ACCOUNTS = 6
const HOURLY_FULL_MAX_ACCOUNTS = 12
const USAGE_SKIP_THRESHOLD = 85

const ROTATION_GLOBAL_LOCK = 'sync:hourly_rotation'

/**
 * 每小时结构全量轮转（P1，永远让路 P0）。
 * 逐账户调用 syncAccountStructureAds，同步 campaigns+adsets+ads 三层。
 * 防重入：全局 GET_LOCK 保证同一时间仅一轮轮转在跑，避免超时后下一小时定时器重入叠加压力。
 * 优先 has_full_synced=0 或 last_full_count=0；本地 count=0 且 has_full_synced=1 时全量修复。
 * @param {Object} facebookApi
 * @param {{ maxAccounts?: number }} opts - maxAccounts 默认 6，可上调 12
 */
export async function runHourlyStructureFullRotation(facebookApi, opts = {}) {
  if (getCircuitBreakerStatus().isLocked) {
    logger.info('[结构轮转] 本小时跳过：Token 熔断')
    return { skipped: true, reason: 'circuit_breaker', synced: 0 }
  }
  const usage = getLastUsageRate()
  if (usage != null && usage >= USAGE_SKIP_THRESHOLD) {
    logger.info(`[结构轮转] 本小时跳过：API 使用率 ${usage}% >= ${USAGE_SKIP_THRESHOLD}%`)
    return { skipped: true, reason: 'usage_high', synced: 0 }
  }

  let rotationConn = null
  try {
    rotationConn = await pool.getConnection()
    const [lockRows] = await rotationConn.query(`SELECT GET_LOCK(?, 0) AS acquired`, [ROTATION_GLOBAL_LOCK])
    if (lockRows[0]?.acquired !== 1) {
      logger.info('[结构轮转] 本小时跳过：上一轮仍在执行，防重入')
      return { skipped: true, reason: 'rotation_running', synced: 0 }
    }

  const maxAccounts = Math.min(HOURLY_FULL_MAX_ACCOUNTS, opts.maxAccounts ?? HOURLY_FULL_DEFAULT_ACCOUNTS)
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
       s.last_full_success_at ASC
     LIMIT ?`,
    [maxAccounts]
  )
  const toSync = (rows || []).map(r => String(r.account_id || '')).filter(Boolean)
  if (toSync.length === 0) {
    return { skipped: false, reason: null, synced: 0 }
  }
  logger.info(`[结构轮转] 本小时处理 ${toSync.length} 个账户（campaigns+adsets+ads 全量）`)
  let synced = 0
  for (const accountId of toSync) {
    try {
      const result = await syncAccountStructureAds(accountId, facebookApi)
      if (result.ok) synced++
      else if (result.reason === 'cooldown') logger.info(`[结构轮转] account=${accountId} 冷却中跳过`)
      else if (result.reason === 'lock_busy') logger.info(`[结构轮转] account=${accountId} 锁占用跳过`)
    } catch (err) {
      logger.warn(`[结构轮转] account=${accountId} 失败:`, err.message)
    }
  }
  return { skipped: false, reason: null, synced }
  } finally {
    if (rotationConn) {
      try {
        await rotationConn.query(`SELECT RELEASE_LOCK(?)`, [ROTATION_GLOBAL_LOCK])
      } catch (e) {
        logger.warn('[结构轮转] 释放全局锁失败:', e?.message)
      }
      rotationConn.release()
      rotationConn = null
    }
  }
}
