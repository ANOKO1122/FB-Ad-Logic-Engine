// Facebook Marketing API 客户端类和规则引擎类
// 注意：这个文件现在只包含业务逻辑类，不包含 Express 应用配置
import logger from './utils/logger.js'
import axios from 'axios'
import https from 'https'
import http from 'http'
import tls from 'tls'
import net from 'net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { parseProxyUrl, isSocksProxy } from './utils/proxyUtils.js'
import { fileURLToPath } from 'url'
import { recordRequest } from './utils/tlsErrorMonitor.js'
import { dirname, join } from 'path'
import { requestViaSocks5 } from './socks5.js'
import pool from './db/connection.js'
import { requireAuth, requireActive, isAdminLikeRole } from './middleware/authJwt.js'
import app from './app.js'  // 导入 Express 应用对象
import { 
  parseUsageHeader, 
  sleepBasedOnUsage, 
  fetchWithTimeout,
  checkTokenError,
  recordSuccess,
  getCircuitBreakerStatus
} from './services/rateLimitService.js'
import { queryRuleData, getAccountTimezone } from './services/ruleDataService.js'
import { getAccountsFromDatabase, syncAccountsFromFacebook } from './services/accountSyncService.js'
import {
  syncAccountStructureAds,
  listStructureAdsFromDb,
  listStructureCampaignsFromDb,
  listStructureAdsetsFromDb,
  listStructureObjectsFromDb,
  resolveStructureByIds
} from './services/structureSyncService.js'
import { assertAccountAccess, hasAccountAccess } from './utils/accountAccess.js'
import pLimit from 'p-limit'
import {
  normalizeConditionsToV2,
  getAllConditionsFromV2,
  validateTimeWindowConsistency
} from './utils/conditionsValidator.js'
import { calculateTimeWindow } from './utils/timeWindow.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 注意：dotenv.config() 已移到 server.js

// 代理协议探测缓存：host:port -> 'socks5' | 'http'
const proxyProtocolCache = new Map()

async function detectProxyProtocol(host, port) {
  const key = `${host}:${port}`
  const cached = proxyProtocolCache.get(key)
  if (cached) return cached

  // 先探测 SOCKS5：发送 0x05 0x01 0x00，期待返回 0x05 <method>
  const isSocks5 = await new Promise((resolve) => {
    const s = net.createConnection(port, host)
    const timer = setTimeout(() => {
      try { s.destroy() } catch {}
      resolve(false)
    }, 1500)

    s.on('connect', () => {
      try { s.write(Buffer.from([0x05, 0x01, 0x00])) } catch {}
    })
    s.on('data', (buf) => {
      clearTimeout(timer)
      const ok = buf && buf.length >= 2 && buf[0] === 0x05 && buf[1] !== 0xff
      try { s.destroy() } catch {}
      resolve(ok)
    })
    s.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })

  const protocol = isSocks5 ? 'socks5' : 'http'
  proxyProtocolCache.set(key, protocol)
  return protocol
}

// 注意：全局代理环境变量设置已移到 server.js

// 注意：Express 应用配置已移到 app.js
const FACEBOOK_API_VERSION = 'v24.0'
const FACEBOOK_API_BASE = `https://graph.facebook.com/${FACEBOOK_API_VERSION}`

// FB 全局请求调度：优先级 + 并发上限 + 排队超时监控
const FB_PRIORITY_LEVEL = {
  action: 1, // 规则动作（pause/activate/预算更新）最高优先
  today: 2,  // Today 热数据
  track2: 3, // 结构同步
  cold: 4    // 冷数据/归档/异步报表
}
const FB_GLOBAL_REQUEST_CONCURRENCY_RAW = Number(process.env.FB_GLOBAL_REQUEST_CONCURRENCY ?? 10)
const FB_GLOBAL_REQUEST_CONCURRENCY = Number.isFinite(FB_GLOBAL_REQUEST_CONCURRENCY_RAW)
  ? Math.max(1, Math.min(Math.floor(FB_GLOBAL_REQUEST_CONCURRENCY_RAW), 50))
  : 10
const FB_GLOBAL_QUEUE_TIMEOUT_MS_RAW = Number(process.env.FB_GLOBAL_QUEUE_TIMEOUT_MS ?? 30000)
const FB_GLOBAL_QUEUE_TIMEOUT_MS = Number.isFinite(FB_GLOBAL_QUEUE_TIMEOUT_MS_RAW)
  ? Math.max(1000, Math.min(Math.floor(FB_GLOBAL_QUEUE_TIMEOUT_MS_RAW), 120000))
  : 30000

// Insights 源头过滤：默认只取 spend>0 的记录
const DEFAULT_SPEND_FILTERING = Object.freeze([
  { field: 'spend', operator: 'GREATER_THAN', value: '0' }
])

function buildSpendFiltering () {
  // 预留扩展点：未来可根据配置调整过滤条件（如按多指标过滤）
  return DEFAULT_SPEND_FILTERING
}

function createAbortError(message = '请求已取消') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function isAbortLikeError(error) {
  return error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ERR_CANCELED'
}

function throwIfAborted(signal, message = '请求已取消') {
  if (signal?.aborted) {
    const reasonMessage = signal.reason?.message || signal.reason || message
    throw createAbortError(String(reasonMessage))
  }
}

function createTimeoutAwareSignal(signal, timeoutMs) {
  if (!signal) {
    return AbortSignal.timeout(timeoutMs)
  }

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort(createAbortError(`请求超时（${timeoutMs}ms）`))
  }, timeoutMs)

  const abortFromExternal = () => {
    clearTimeout(timeoutId)
    controller.abort(signal.reason || createAbortError('请求已取消'))
  }

  if (signal.aborted) {
    abortFromExternal()
  } else {
    signal.addEventListener('abort', abortFromExternal, { once: true })
  }

  return controller.signal
}

let fbQueueSeq = 0
let fbRunningCount = 0
const fbPendingQueue = []

function normalizeFbPriority(priority) {
  if (typeof priority === 'string') return FB_PRIORITY_LEVEL[priority] ?? FB_PRIORITY_LEVEL.track2
  if (Number.isFinite(Number(priority))) return Math.max(1, Math.min(Math.floor(Number(priority)), 9))
  return FB_PRIORITY_LEVEL.track2
}

function drainFbQueue() {
  while (fbRunningCount < FB_GLOBAL_REQUEST_CONCURRENCY && fbPendingQueue.length > 0) {
    fbPendingQueue.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq))
    const task = fbPendingQueue.shift()
    if (!task || task.cancelled) continue

    task.started = true
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle)
    fbRunningCount += 1

    const waitMs = Date.now() - task.enqueuedAt
    if (waitMs >= 3000 || task.priority === FB_PRIORITY_LEVEL.action) {
      logger.info(`[FBQueue] 开始执行 label=${task.label} priority=${task.priority} wait_ms=${waitMs} running=${fbRunningCount}/${FB_GLOBAL_REQUEST_CONCURRENCY} pending=${fbPendingQueue.length}`)
    }

    Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        fbRunningCount = Math.max(0, fbRunningCount - 1)
        drainFbQueue()
      })
  }
}

function enqueueFacebookRequest({ priority, label, queueTimeoutMs }, run) {
  return new Promise((resolve, reject) => {
    const task = {
      seq: ++fbQueueSeq,
      priority: normalizeFbPriority(priority),
      label: label || 'fb_request',
      enqueuedAt: Date.now(),
      queueTimeoutMs: Number.isFinite(Number(queueTimeoutMs)) ? Math.max(1000, Math.min(Math.floor(Number(queueTimeoutMs)), 120000)) : FB_GLOBAL_QUEUE_TIMEOUT_MS,
      run,
      resolve,
      reject,
      started: false,
      cancelled: false,
      timeoutHandle: null
    }

    task.timeoutHandle = setTimeout(() => {
      if (task.started || task.cancelled) return
      task.cancelled = true
      const idx = fbPendingQueue.findIndex(t => t.seq === task.seq)
      if (idx >= 0) fbPendingQueue.splice(idx, 1)
      const waitMs = Date.now() - task.enqueuedAt
      logger.warn(`[FBQueue] 排队超时 label=${task.label} priority=${task.priority} wait_ms=${waitMs} queue_timeout_ms=${task.queueTimeoutMs}`)
      reject(new Error(`FB queue timeout before request start (${waitMs}ms)`))
      drainFbQueue()
    }, task.queueTimeoutMs)

    fbPendingQueue.push(task)
    drainFbQueue()
  })
}

// Facebook API 客户端类
class FacebookMarketingAPI {
  constructor(accessToken) {
    this.accessToken = accessToken
  }

  /**
   * 返回默认的 spend>0 filtering 配置，用于 Insights 源头过滤与 Batch 构造
   */
  getDefaultSpendFiltering () {
    return buildSpendFiltering()
  }

  /**
   * 通用：拉取结构化对象列表的一页数据（campaigns / adsets / ads）
   * - 不使用 insights，避免“无消耗对象不可见”
   * - 支持 cursor(after) 分页、limit、filtering（effective_status / name contains）
   */
  async getStructurePage(adAccountId, edge, { fields, limit = 50, after = null, filtering = null } = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/${edge}`
    const params = {
      fields,
      limit,
      access_token: this.accessToken
    }
    if (after) params.after = after
    if (filtering) params.filtering = JSON.stringify(filtering)

    const data = await this.makeRequest(url, params, 'GET', null, {
      requestPriority: 'track2',
      requestLabel: `structure_page:${edge}`
    })
    if (data.error) {
      throw new Error(`Facebook API Error: ${data.error.message}`)
    }

    const items = (data.data || []).map((x) => ({
      id: String(x.id || ''),
      name: x.name || '',
      status: x.status,
      effective_status: x.effective_status,
      configured_status: x.configured_status,
      campaign_id: x.campaign_id,
      adset_id: x.adset_id,
      updated_time: x.updated_time || null,
      created_time: x.created_time || null
    })).filter(x => x.id)

    const afterCursor = data?.paging?.cursors?.after || null
    return { items, paging: { after: afterCursor, next: data?.paging?.next || null } }
  }

  /**
   * Batch API：一次请求拉取多个账户的 ads 结构页（最多 50 个子请求/批）
   * 用于每小时多账户结构轮转，减少 HTTP 往返。
   * @param {Array<{ accountId: string, after?: string }>} requests
   * @param {{ fields: string, filtering: Array }} opts - fields 与 filtering（与 getStructurePage 一致）
   * @returns {Promise<Array<{ accountId: string, items: Array, after?: string }>>}
   */
  async getStructureAdsBatch(requests, { fields, filtering } = {}) {
    if (!requests || requests.length === 0) return []
    const list = requests.slice(0, 50)
    const filteringStr = filtering ? JSON.stringify(filtering) : ''
    const batchRequests = list.map(({ accountId, after }) => {
      let rel = `${accountId}/ads?fields=${encodeURIComponent(fields)}&limit=100`
      if (filteringStr) rel += `&filtering=${encodeURIComponent(filteringStr)}`
      if (after) rel += `&after=${encodeURIComponent(after)}`
      return { method: 'GET', relative_url: rel }
    })
    const batchUrl = `${FACEBOOK_API_BASE}/`
    const batchParams = {
      batch: JSON.stringify(batchRequests),
      access_token: this.accessToken
    }
    const response = await this.makeRequest(batchUrl, batchParams, 'POST', null, {
      returnHeaders: true,
      timeout: 60000,
      requestPriority: 'track2',
      requestLabel: 'structure_batch_ads'
    })
    const responseData = (response && typeof response === 'object' && 'data' in response) ? response.data : response
    const responseHeaders = (response && typeof response === 'object' && 'headers' in response) ? response.headers : {}
    if (responseData?.error) throw new Error(`Batch API Error: ${responseData.error?.message || 'unknown'}`)
    const batchResponses = Array.isArray(responseData) ? responseData : []
    const results = []
    for (let i = 0; i < list.length; i++) {
      const { accountId } = list[i]
      const item = batchResponses[i]
      try {
        if (item?.code === 200 && item?.body) {
          const bodyData = JSON.parse(item.body)
          if (bodyData.error) {
            logger.warn(`[Batch] account=${accountId} ads 失败:`, bodyData.error.message)
            results.push({ accountId, items: [], after: null })
            continue
          }
          const data = bodyData.data || []
          const items = data.map((x) => ({
            id: String(x.id || ''),
            name: x.name || '',
            status: x.status,
            effective_status: x.effective_status,
            configured_status: x.configured_status,
            campaign_id: x.campaign_id,
            adset_id: x.adset_id,
            updated_time: x.updated_time || null,
            created_time: x.created_time || null
          })).filter(x => x.id)
          const afterCursor = bodyData?.paging?.cursors?.after || null
          results.push({ accountId, items, after: afterCursor })
        } else {
          results.push({ accountId, items: [], after: null })
        }
      } catch (e) {
        logger.warn(`[Batch] account=${accountId} 解析失败:`, e.message)
        results.push({ accountId, items: [], after: null })
      }
    }
    // 解析 usage 并动态休眠（与 ingestorService 一致）
    const usageHeader = responseHeaders['x-business-use-case-usage'] || responseHeaders['x-business-use-case-usage'.toLowerCase()]
    if (usageHeader) {
      const usageInfo = parseUsageHeader(usageHeader)
      await sleepBasedOnUsage(usageInfo)
    }
    return results
  }

  /**
   * 通用 Batch API：按顺序发送任意子请求集合，并保持结果顺序与请求顺序一致
   * - 自动按 50 条一批分片（Graph Batch 上限）
   * - 对每个子响应做双重 JSON 解析（外层数组元素 + body 字符串）
   * - 返回结构：[{ code, body, raw }, ...]，其中 raw 为原始子响应对象
   *
   * @param {Array<{ method: string, relative_url: string, body?: string }>} requests
   * @param {{ priority?: string|number, label?: string }} [opts]
   * @returns {Promise<Array<{ code: number, body: any, raw: any }>>}
   */
  async batchRequests(requests, { priority = 'action', label = 'actions_batch' } = {}) {
    if (!Array.isArray(requests) || requests.length === 0) return []

    const BATCH_LIMIT = 50
    const batchUrl = `${FACEBOOK_API_BASE}/`
    const allResults = []

    for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
      const chunk = requests.slice(i, i + BATCH_LIMIT)
      const batchParams = {
        batch: JSON.stringify(chunk),
        access_token: this.accessToken
      }

      const response = await this.makeRequest(batchUrl, batchParams, 'POST', null, {
        returnHeaders: true,
        timeout: 60000,
        requestPriority: priority,
        requestLabel: label
      })

      const responseData = (response && typeof response === 'object' && 'data' in response)
        ? response.data
        : response
      if (responseData?.error) {
        throw new Error(`Batch API Error: ${responseData.error?.message || 'unknown'}`)
      }

      const batchResponses = Array.isArray(responseData) ? responseData : []
      const chunkResults = batchResponses.map((subRes) => {
        let parsedBody = null
        if (subRes && subRes.body) {
          try {
            parsedBody = JSON.parse(subRes.body)
          } catch (e) {
            logger.warn('[Batch] 子响应 body 解析失败，将 raw body 作为字符串保留', {
              error: e.message
            })
          }
        }
        return {
          code: subRes?.code ?? 0,
          body: parsedBody,
          raw: subRes
        }
      })

      // 按分片顺序直接拼接，确保全局索引顺序与原始 requests 一致
      allResults.push(...chunkResults)
    }

    return allResults
  }

  /**
   * 统一 Batch：单账户一次请求拉 campaigns/adsets/ads 三个 edge
   * - 最简版：sinceSec 用 Unix 秒，不做 ISO 回退
   * - 每个 edge 独立解析与容错，任一 edge 失败不影响其他 edge
   * - 重点：FB Batch item.body 是双重转义 JSON 字符串，必须 JSON.parse(item.body)
   *
   * @param {string} adAccountId
   * @param {{
   *   sinceSec: number,
   *   limit?: number,
   *   campaignsFields?: string,
   *   adsetsFields?: string,
   *   adsFields?: string
   * }} opts
   * @returns {Promise<{
   *   campaigns: { items: Array, after: string|null, code: number|null, error: string|null },
   *   adsets: { items: Array, after: string|null, code: number|null, error: string|null },
   *   ads: { items: Array, after: string|null, code: number|null, error: string|null }
   * }>}
   */
  async unifiedStructureBatch(adAccountId, opts = {}) {
    const accountId = String(adAccountId || '').trim()
    if (!accountId) throw new Error('unifiedStructureBatch: adAccountId 不能为空')

    const sinceSec = Number(opts.sinceSec)
    if (!Number.isFinite(sinceSec)) {
      throw new Error('unifiedStructureBatch: sinceSec 必须是有效数字（Unix 秒）')
    }

    const limitRaw = Number(opts.limit ?? 500)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 500

    const campaignsFields = opts.campaignsFields || 'id,name,status,effective_status,updated_time,created_time'
    const adsetsFields = opts.adsetsFields || 'id,name,status,effective_status,updated_time,created_time,campaign_id'
    const adsFields = opts.adsFields || 'id,name,status,effective_status,configured_status,updated_time,created_time,adset_id,campaign_id'

    const buildFilteringValue = (val) => [{ field: 'updated_time', operator: 'GREATER_THAN', value: String(val) }]
    const filtering = JSON.stringify(buildFilteringValue(Math.floor(sinceSec)))
    const makeRelativeUrl = (edge, fields) =>
      `${accountId}/${edge}?fields=${encodeURIComponent(fields)}&limit=${limit}&filtering=${encodeURIComponent(filtering)}`
    const edgeFields = { campaigns: campaignsFields, adsets: adsetsFields, ads: adsFields }

    const batchRequests = [
      { method: 'GET', relative_url: makeRelativeUrl('campaigns', campaignsFields) },
      { method: 'GET', relative_url: makeRelativeUrl('adsets', adsetsFields) },
      { method: 'GET', relative_url: makeRelativeUrl('ads', adsFields) }
    ]

    const batchUrl = `${FACEBOOK_API_BASE}/`
    const response = await this.makeRequest(
      batchUrl,
      { batch: JSON.stringify(batchRequests), access_token: this.accessToken },
      'POST',
      null,
      {
        returnHeaders: true,
        timeout: 60000,
        requestPriority: 'track2',
        requestLabel: 'structure_batch_unified'
      }
    )

    const responseData = (response && typeof response === 'object' && 'data' in response) ? response.data : response
    if (responseData?.error) {
      throw new Error(`Batch API Error: ${responseData.error?.message || 'unknown'}`)
    }

    const batchResponses = Array.isArray(responseData) ? responseData : []
    const edgeNames = ['campaigns', 'adsets', 'ads']
    const result = {
      campaigns: { items: [], after: null, code: null, error: null },
      adsets: { items: [], after: null, code: null, error: null },
      ads: { items: [], after: null, code: null, error: null }
    }

    const mapItem = (x) => ({
      id: String(x.id || ''),
      name: x.name || '',
      status: x.status,
      effective_status: x.effective_status,
      configured_status: x.configured_status,
      campaign_id: x.campaign_id,
      adset_id: x.adset_id,
      updated_time: x.updated_time || null,
      created_time: x.created_time || null
    })

    const formatBodyError = (bodyData) => {
      const err = bodyData?.error
      if (!err) return null
      const msg = err.message || 'edge_error'
      const code = err.code != null ? ` code=${err.code}` : ''
      const subcode = err.error_subcode != null ? ` subcode=${err.error_subcode}` : ''
      return `${msg}${code}${subcode}`
    }

    const tryParseBodyJson = (rawBody) => {
      if (!rawBody) return null
      try { return JSON.parse(rawBody) } catch { return null }
    }

    const fallbackFetchEdgeFirstPage = async (edge) => {
      const unixValue = String(Math.floor(sinceSec))
      const isoValue = new Date(Math.floor(sinceSec) * 1000).toISOString()
      const candidates = [unixValue, isoValue]
      let lastErr = null
      for (let i = 0; i < candidates.length; i++) {
        const filteringObj = buildFilteringValue(candidates[i])
        try {
          const page = await this.getStructurePage(accountId, edge, {
            fields: edgeFields[edge],
            limit,
            after: null,
            filtering: filteringObj
          })
          result[edge].items = Array.isArray(page?.items) ? page.items : []
          result[edge].after = page?.paging?.after || null
          result[edge].code = 200
          result[edge].error = null
          if (i === 1) {
            logger.warn(`[UnifiedBatch] account=${accountId} edge=${edge} 已回退 ISO filtering 成功`)
          } else {
            logger.warn(`[UnifiedBatch] account=${accountId} edge=${edge} 已通过单 edge 回补成功`)
          }
          return
        } catch (err) {
          lastErr = err
        }
      }
      result[edge].error = lastErr?.message || result[edge].error || 'edge_refetch_failed'
    }

    for (let i = 0; i < edgeNames.length; i++) {
      const edge = edgeNames[i]
      const item = batchResponses[i]
      result[edge].code = item?.code ?? null

      if (item?.code !== 200 || !item?.body) {
        const bodyData = tryParseBodyJson(item?.body)
        const detail = formatBodyError(bodyData)
        result[edge].error = detail || (item?.body ? `HTTP_${item?.code ?? 'N/A'}` : 'empty_body')
        logger.warn(`[UnifiedBatch] account=${accountId} edge=${edge} 非成功响应 code=${item?.code ?? 'N/A'} error=${result[edge].error}`)
        continue
      }

      try {
        const bodyData = JSON.parse(item.body)
        if (bodyData?.error) {
          result[edge].error = formatBodyError(bodyData) || 'edge_error'
          logger.warn(`[UnifiedBatch] account=${accountId} edge=${edge} API错误: ${result[edge].error}`)
          continue
        }
        const data = Array.isArray(bodyData?.data) ? bodyData.data : []
        result[edge].items = data.map(mapItem).filter(x => x.id)
        result[edge].after = bodyData?.paging?.cursors?.after || null
      } catch (err) {
        result[edge].error = err.message || 'parse_error'
        logger.warn(`[UnifiedBatch] account=${accountId} edge=${edge} 解析失败: ${result[edge].error}`)
      }
    }

    // 单个 edge 在 batch 里失败时，按 edge 回补第一页（先 Unix 秒，再 ISO）
    for (const edge of edgeNames) {
      if (result[edge].error) {
        await fallbackFetchEdgeFirstPage(edge)
      }
    }

    return result
  }

  /**
   * 通用：根据对象 IDs 解析名称/状态（用于“回显”与 structure_ads 写库）
   * Graph 支持：GET /?ids=id1,id2&fields=...
   * 当 fields 含 adset_id,campaign_id,updated_time 时会一并映射到返回对象（供结构镜像表使用）。
   */
  async resolveObjectsByIds(ids, { fields = 'id,name,effective_status,status,configured_status', requestPriority = 'track2', requestLabel = 'resolve_objects', signal = null } = {}) {
    const list = (Array.isArray(ids) ? ids : String(ids || '').split(','))
      .map(s => String(s || '').trim())
      .filter(Boolean)
    if (list.length === 0) return []

    // Graph 限制：URL 过长会失败，做一个保守切分（每批 50）
    const chunks = []
    for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50))

    const all = []
    for (const chunk of chunks) {
      const url = `${FACEBOOK_API_BASE}/`
      const params = {
        ids: chunk.join(','),
        fields,
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'GET', null, {
        requestPriority,
        requestLabel,
        signal
      })
      if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)

      for (const id of chunk) {
        const obj = data?.[id]
        if (!obj) continue
        const item = {
          id: String(obj.id || id),
          name: obj.name || '',
          effective_status: obj.effective_status,
          status: obj.status,
          configured_status: obj.configured_status
        }
        if (obj.adset_id !== undefined) item.adset_id = obj.adset_id
        if (obj.campaign_id !== undefined) item.campaign_id = obj.campaign_id
        if (obj.updated_time !== undefined) item.updated_time = obj.updated_time || null
        if (obj.created_time !== undefined) item.created_time = obj.created_time || null
        all.push(item)
      }
    }
    return all
  }

  async getAdAccounts() {
    try {
      let url = `${FACEBOOK_API_BASE}/me/adaccounts`
      let params = {
        fields: 'id,name,account_id',
        limit: 200,
        access_token: this.accessToken
      }

      logger.info('📡 请求Facebook API(分页):', url)
      logger.info('📋 参数: fields=id,name,account_id, limit=200')

      const all = []
      const seen = new Set()
      let page = 0

      while (url) {
        page += 1
        const data = await this.makeRequest(url, params, 'GET')
        const pageAccounts = this.processAccountsResponse(data, `page_${page}`)
        for (const acc of pageAccounts) {
          const key = String(acc.id || acc.account_id || '').trim()
          if (!key || seen.has(key)) continue
          seen.add(key)
          all.push(acc)
        }

        // 下一页：paging.next 通常是完整 URL（自带 query），此时 params 置空避免重复拼接
        url = data?.paging?.next || null
        params = {} // next URL 已包含必要参数
      }

      logger.info(`✅ 分页汇总后广告账户数: ${all.length}`)
      return all
      
    } catch (error) {
      logger.error('❌ 获取广告账户失败:', error.message)
      logger.error('❌ 错误堆栈:', error.stack)
      throw new Error(`网络连接失败: ${error.message}. 请检查网络连接、防火墙或代理设置。`)
    }
  }
  
  processAccountsResponse(data, method = '') {
    if (data.error) {
      logger.error('❌ Facebook API错误:', JSON.stringify(data.error, null, 2))
      throw new Error(`Facebook API错误: ${data.error.message} (错误代码: ${data.error.code || 'N/A'}, 类型: ${data.error.type || 'N/A'})`)
    }
    
    const accounts = (data.data || []).map(account => ({
      id: account.id || account.account_id,
      name: account.name || `广告账户 ${account.account_id || account.id}`,
      account_id: account.account_id || account.id
    }))
    
    const methodText = method ? `（使用${method}）` : ''
    logger.info(`✅ 成功获取 ${accounts.length} 个广告账户${methodText}`)
    return accounts
  }

  /**
   * 获取账户时区（两步拉取：流派2）
   * 为什么需要这个函数？
   * - Facebook API 的账户时区是最可靠的来源（比数据库配置更准确）
   * - 在拉取 insights 前先获取时区，确保 time_range 计算与账户时区对齐
   * - 写入时把 timezone_name 落库，便于后续"数据时区优先"查询
   * 
   * @param {string} accountId - Facebook 账户ID
   * @returns {Promise<string>} 账户时区（如 'Asia/Shanghai'），失败时返回 'UTC'
   * 
   * @example
   * const timezone = await facebookApi.getAccountTimezone('act_123')
   * // 返回: 'Asia/Shanghai'
   */
  async getAccountTimezone(accountId, options = {}) {
    try {
      // 第1-3行：构造请求 URL 和参数
      // Facebook Graph API：/{account_id}?fields=timezone_name
      // 注意：accountId 需要包含 'act_' 前缀
      const url = `${FACEBOOK_API_BASE}/${accountId}`
      const params = {
        fields: 'timezone_name',
        access_token: this.accessToken
      }
      
      logger.info(`📡 获取账户 ${accountId} 的时区...`)
      
      // 第4-5行：发送请求
      const data = await this.makeRequest(url, params, 'GET', null, {
        requestPriority: 'today',
        requestLabel: 'account_timezone',
        signal: options?.signal || null
      })
      
      // 第6-7行：检查错误
      if (data.error) {
        logger.warn(`⚠️  获取账户 ${accountId} 时区失败:`, data.error.message)
        return 'UTC'  // 失败时返回默认时区
      }
      
      // 第8-10行：提取时区名称
      const timezoneName = data.timezone_name || 'UTC'
      logger.info(`✅ 账户 ${accountId} 时区: ${timezoneName}`)
      
      return timezoneName
    } catch (error) {
      // 第11-12行：如果请求失败，记录警告但返回默认时区（优雅降级）
      logger.warn(`⚠️  获取账户 ${accountId} 时区失败，使用默认 UTC:`, error.message)
      return 'UTC'
    }
  }

  // 通用请求方法：尝试多种方式发送请求，包括代理
  // @param {string} url - 请求 URL
  // @param {Object} params - 请求参数
  // @param {string} method - HTTP 方法（GET/POST）
  // @param {Object|null} body - 请求体（POST 请求）
  // @param {Object} options - 选项：{ returnHeaders, timeout, requestPriority, requestLabel, queueTimeoutMs }
  // @returns {Promise<Object|{data: Object, headers: Object}>} 响应数据或包含响应头的对象
  async makeRequest(url, params, method = 'GET', body = null, options = {}) {
    const {
      returnHeaders = false,
      timeout = 45000,
      requestPriority = 'track2',
      requestLabel = 'fb_request',
      queueTimeoutMs = FB_GLOBAL_QUEUE_TIMEOUT_MS,
      signal = null
    } = options

    return enqueueFacebookRequest(
      { priority: requestPriority, label: requestLabel, queueTimeoutMs },
      async () => {
        throwIfAborted(signal, `${requestLabel} 在发起前已被取消`)
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
        
        // 检查 Token 熔断器状态（使用静态导入，避免动态导入导致的问题）
        const breakerStatus = getCircuitBreakerStatus()
        if (breakerStatus.isLocked) {
          throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
        }

        // 方法1: 如果配置了代理，则先探测该端口到底是 SOCKS5 还是 HTTP 代理，避免 protocol mismatch
        if (proxyUrl) {
          const info = parseProxyUrl(proxyUrl)
          if (!info) {
            logger.warn('⚠️ 代理解析失败，跳过代理，尝试后续方式:', proxyUrl)
          } else {
            let scheme = info.scheme
            if (scheme === 'auto') {
              scheme = await detectProxyProtocol(info.host, info.port)
              logger.info(`🔎 代理协议探测结果: ${info.host}:${info.port} => ${scheme}`)
            }

            if (scheme === 'socks5' || scheme === 'socks4') {
              const socksUrl = info.raw.startsWith('socks') ? info.raw : `socks5://${info.host}:${info.port}`
              // 只重试「TLS 未建立前」的高置信瞬态错误，避免误重试 ECONNRESET/socket hang up（可能发生在请求已发送后）
              const isTransientSocksError = (err) => {
                const msg = (err?.message || err?.code || '') + ''
                return /Client network socket disconnected before secure TLS connection was established/i.test(msg) ||
                  /收到空响应/i.test(msg)
              }
              try {
                logger.info(`🔄 使用SOCKS代理: ${socksUrl}`)
                for (let attempt = 1; attempt <= 2; attempt++) {
                  try {
                    return await requestViaSocks5(url, params, socksUrl, method, body)
                  } catch (e) {
                    if (attempt === 1 && isTransientSocksError(e)) {
                      const jitter = 200 + Math.floor(Math.random() * 301) // 200-500ms
                      logger.info(`⚠️ 瞬态错误，${jitter}ms 后重试: ${e.message}`)
                      await new Promise(r => setTimeout(r, jitter))
                      continue
                    }
                    throw e
                  }
                }
              } catch (socks5Error) {
                logger.warn('⚠️ 原生SOCKS实现失败:', socks5Error.message)
                // 只有在明确是 socks URL 时才允许 socks-proxy-agent 兜底，避免对 HTTP 端口造成 protocol mismatch
                try {
                  logger.info(`🔄 尝试使用socks-proxy-agent: ${socksUrl}`)
                  const agent = new SocksProxyAgent(socksUrl, { timeout: timeout })
                  const config = { params, httpsAgent: agent, httpAgent: agent, timeout: timeout, signal }
                  
                  const requestPromise = method === 'POST' 
                    ? axios.post(url, body, config) 
                    : axios.get(url, config)

                  const resp = await fetchWithTimeout(requestPromise, timeout)
                  
                  // 检查 Token 错误
                  if (resp.data?.error) {
                    checkTokenError(resp.data)
                  } else {
                    recordSuccess()
                  }
                  
                  // 解析响应头并动态休眠（如果返回响应头）
                  if (returnHeaders && resp.headers) {
                    const usageHeader = resp.headers['x-business-use-case-usage'] || resp.headers['x-business-use-case-usage'.toLowerCase()]
                    if (usageHeader) {
                      const usageInfo = parseUsageHeader(usageHeader)
                      await sleepBasedOnUsage(usageInfo)
                    }
                  }
                  
                  logger.info('✅ socks-proxy-agent 请求成功')
                  return returnHeaders ? { data: resp.data, headers: resp.headers } : resp.data
                } catch (socksError) {
                  if (isAbortLikeError(socksError)) throw socksError
                  // 检查是否是 Token 错误
                  checkTokenError(socksError)
                  logger.warn('⚠️ socks-proxy-agent 也失败:', socksError.message)
                  throw socksError
                }
              }
            } else if (scheme === 'http') {
              // HTTP 代理：CONNECT 隧道（仅 http://；https:// 代理由方法3 HttpsProxyAgent 处理）
              try {
                throwIfAborted(signal, `${requestLabel} 在 HTTP 代理前已被取消`)
                logger.info('🔄 使用HTTP代理（CONNECT隧道）...')
                return await this.requestViaHttpProxy(url, params, `http://${info.host}:${info.port}`, method, body)
              } catch (proxyError) {
                if (isAbortLikeError(proxyError)) throw proxyError
                logger.warn('⚠️ HTTP代理隧道失败:', proxyError.message)
              }
            }
            // scheme === 'https' 或 其它：跳过 CONNECT，由方法3 HttpsProxyAgent 处理（支持 https:// 代理）
          }
        }
        
        // 方法3: 尝试使用axios with HTTP代理agent（排除 socks5h/socks5/socks4）
        if (proxyUrl && !isSocksProxy(proxyUrl)) {
          try {
            let httpProxyUrl = proxyUrl
            if (!httpProxyUrl.startsWith('http://') && !httpProxyUrl.startsWith('https://')) {
              httpProxyUrl = `http://${httpProxyUrl}`
            }
            const agent = new HttpsProxyAgent(httpProxyUrl)
            const config = {
              params,
              httpsAgent: agent,
              httpAgent: agent,
              timeout: timeout,
              signal
            }
            
            const requestPromise = method === 'POST' 
              ? axios.post(url, body, config) 
              : axios.get(url, config)

            const response = await fetchWithTimeout(requestPromise, timeout)
            
            // 检查 Token 错误
            if (response.data?.error) {
              checkTokenError(response.data)
            } else {
              recordSuccess()
            }
            
            // 解析响应头并动态休眠（如果返回响应头）
            if (returnHeaders && response.headers) {
              const usageHeader = response.headers['x-business-use-case-usage'] || response.headers['x-business-use-case-usage'.toLowerCase()]
              if (usageHeader) {
                const usageInfo = parseUsageHeader(usageHeader)
                await sleepBasedOnUsage(usageInfo)
              }
            }
            
            return returnHeaders ? { data: response.data, headers: response.headers } : response.data
          } catch (httpError) {
            if (isAbortLikeError(httpError)) throw httpError
            logger.warn('⚠️ HTTP代理agent失败:', httpError.message)
          }
        }
        
        // 方法4: 尝试使用原生fetch（Node.js 18+，会自动使用系统代理）
        if (typeof fetch !== 'undefined') {
          try {
            const queryString = new URLSearchParams(params).toString()
            const fullUrl = `${url}?${queryString}`
            logger.info('🔄 尝试使用原生fetch（自动使用系统代理）...')
            
            const fetchOptions = {
              method: method,
              headers: { 'Accept': 'application/json' },
              signal: createTimeoutAwareSignal(signal, timeout)
            }
            if (method === 'POST' && body) {
              fetchOptions.headers['Content-Type'] = 'application/json'
              fetchOptions.body = JSON.stringify(body)
            }
            
            const fetchPromise = fetch(fullUrl, fetchOptions)
            const response = await fetchWithTimeout(fetchPromise, timeout)
            
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}))
              checkTokenError(errorData)
              throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }
            
            const data = await response.json()
            
            // 检查 Token 错误
            if (data?.error) {
              checkTokenError(data)
            } else {
              recordSuccess()
            }
            
            // 解析响应头并动态休眠（如果返回响应头）
            if (returnHeaders && response.headers) {
              const usageHeader = response.headers.get('x-business-use-case-usage')
              if (usageHeader) {
                const usageInfo = parseUsageHeader(usageHeader)
                await sleepBasedOnUsage(usageInfo)
              }
            }
            
            return returnHeaders ? { data, headers: Object.fromEntries(response.headers.entries()) } : data
          } catch (fetchError) {
            if (isAbortLikeError(fetchError)) throw fetchError
            logger.warn('⚠️ 原生fetch失败:', fetchError.message)
          }
        }
        
        // 方法5: 最后尝试直接使用axios（不配置agent，依赖系统代理）
        logger.info('🔄 尝试使用axios（依赖系统代理）...')
        const config = {
          params,
          timeout: timeout,
          signal
        }
        
        const requestPromise = method === 'POST' 
          ? axios.post(url, body, config) 
          : axios.get(url, config)

        const response = await fetchWithTimeout(requestPromise, timeout)
        
        // 检查 Token 错误
        if (response.data?.error) {
          checkTokenError(response.data)
        } else {
          recordSuccess()
        }
        
        // 解析响应头并动态休眠（如果返回响应头）
        if (returnHeaders && response.headers) {
          const usageHeader = response.headers['x-business-use-case-usage'] || response.headers['x-business-use-case-usage'.toLowerCase()]
          if (usageHeader) {
            const usageInfo = parseUsageHeader(usageHeader)
            await sleepBasedOnUsage(usageInfo)
          }
        }
        
        return returnHeaders ? { data: response.data, headers: response.headers } : response.data
      }
    )
  }

  // 使用原生HTTP模块通过代理发送请求（最可靠的方法）
  async requestViaHttpProxy(targetUrl, params, proxyUrl, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      try {
        // 解析代理URL（使用统一工具，避免 socks5h 等误入时解析错误）
        const info = parseProxyUrl(proxyUrl)
        const proxyHost = info?.host || '127.0.0.1'
        const proxyPort = (info?.port && !Number.isNaN(info.port)) ? info.port : 10809
        
        // 解析目标URL
        const targetUrlObj = new URL(targetUrl)
        const targetHost = targetUrlObj.hostname
        const targetPort = targetUrlObj.port || 443
        
        logger.info(`🔗 通过HTTP代理建立隧道: ${proxyHost}:${proxyPort} -> ${targetHost}:${targetPort}`)
        
        // 构建查询字符串和路径
        const queryString = new URLSearchParams(params).toString()
        const path = queryString ? `${targetUrlObj.pathname}?${queryString}` : targetUrlObj.pathname
        
        // 连接到代理服务器，使用CONNECT方法建立隧道
        logger.info(`📡 正在连接到代理服务器 ${proxyHost}:${proxyPort}...`)
        const proxyReq = http.request({
          host: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: `${targetHost}:${targetPort}`,
          headers: {
            'Host': `${targetHost}:${targetPort}`,
            'Proxy-Connection': 'keep-alive',
            'Connection': 'keep-alive'
          },
          timeout: 10000
        }, (proxyRes) => {
          logger.info(`📥 收到代理响应: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
          
          // 检查代理响应状态
          if (proxyRes.statusCode !== 200) {
            let errorBody = ''
            proxyRes.on('data', (chunk) => { errorBody += chunk })
            proxyRes.on('end', () => {
              logger.error(`❌ 代理连接失败: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
              if (errorBody) {
                logger.error(`❌ 错误详情: ${errorBody}`)
              }
              reject(new Error(`代理连接失败: ${proxyRes.statusCode} ${proxyRes.statusMessage}${errorBody ? ' - ' + errorBody : ''}`))
            })
            return
          }
          
          logger.info('✅ 代理隧道建立成功')
          
          // 确保socket已准备好（CONNECT响应后，socket就是原始TCP连接）
          const tunnelSocket = proxyRes.socket
          
          // 监听socket错误
          tunnelSocket.on('error', (error) => {
            logger.error('❌ 隧道socket错误:', error.message)
            reject(new Error(`隧道连接错误: ${error.message}`))
          })
          
          // 等待socket完全准备好（确保CONNECT响应已完全处理）
          // 使用setImmediate确保在下一个事件循环中执行
          setImmediate(() => {
            try {
              logger.info('🔐 开始建立TLS连接...')
              
              // 在原始socket上建立TLS连接
              const tlsSocket = tls.connect({
                socket: tunnelSocket,
                host: targetHost,
                servername: targetHost,
                rejectUnauthorized: false
              }, () => {
                logger.info('✅ TLS连接建立成功，开始发送HTTP请求...')
                
                // TLS连接建立后，发送HTTP请求
                const headers = {
                  'Host': targetHost,
                  'Accept': 'application/json',
                  'User-Agent': 'Node.js Facebook Marketing API Client',
                  'Connection': 'close'
                }
                
                if (method === 'POST' && body) {
                  headers['Content-Type'] = 'application/json'
                  const bodyStr = JSON.stringify(body)
                  headers['Content-Length'] = Buffer.byteLength(bodyStr)
                }
                
                // 构建HTTP请求（确保格式正确）
                let requestLine = `${method} ${path} HTTP/1.1\r\n`
                let headerLines = Object.entries(headers)
                  .map(([key, value]) => `${key}: ${value}\r\n`)
                  .join('')
                const httpRequest = requestLine + headerLines + '\r\n'
                
                logger.info(`📤 发送HTTP请求: ${method} ${path}`)
                logger.info(`📤 请求头大小: ${httpRequest.length} 字节`)
                
                // 先发送请求头
                tlsSocket.write(httpRequest)
                
                // 如果是POST请求，发送body
                if (method === 'POST' && body) {
                  const bodyStr = JSON.stringify(body)
                  logger.info(`📤 请求体大小: ${bodyStr.length} 字节`)
                  tlsSocket.write(bodyStr)
                }
              })
              
              tlsSocket.on('error', (error) => {
                logger.error('❌ TLS连接错误:', error.message)
                logger.error('❌ 错误堆栈:', error.stack)
                
                // 记录 TLS 错误（用于监控）
                recordRequest(true)
                
                reject(new Error(`TLS连接失败: ${error.message}`))
              })
              
              // 接收HTTP响应 - 使用更可靠的方法
              let responseBuffer = Buffer.alloc(0)
              let responseHeaders = {}
              let responseBody = ''
              let isHeadersComplete = false
              let contentLength = null
              let isChunked = false
              
              tlsSocket.on('data', (chunk) => {
                responseBuffer = Buffer.concat([responseBuffer, chunk])
                
                if (!isHeadersComplete) {
                  // 查找HTTP响应头结束位置（\r\n\r\n）
                  const headerEnd = responseBuffer.indexOf(Buffer.from('\r\n\r\n'))
                  if (headerEnd !== -1) {
                    isHeadersComplete = true
                    const headerText = responseBuffer.subarray(0, headerEnd).toString('utf-8')
                    const bodyStart = headerEnd + 4
                    
                    // 解析响应头
                    const lines = headerText.split('\r\n')
                    const statusLine = lines[0]
                    const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)\s+(.+)/)
                    if (statusMatch) {
                      const statusCode = parseInt(statusMatch[1])
                      const statusMessage = statusMatch[2]
                      logger.info(`📥 收到HTTP响应: ${statusCode} ${statusMessage}`)
                    }
                    
                    // 解析其他响应头
                    for (let i = 1; i < lines.length; i++) {
                      const colonIndex = lines[i].indexOf(':')
                      if (colonIndex !== -1) {
                        const key = lines[i].substring(0, colonIndex).trim().toLowerCase()
                        const value = lines[i].substring(colonIndex + 1).trim()
                        responseHeaders[key] = value
                        
                        if (key === 'content-length') {
                          contentLength = parseInt(value)
                        } else if (key === 'transfer-encoding' && value.toLowerCase() === 'chunked') {
                          isChunked = true
                        }
                      }
                    }
                    
                    // 提取响应体（如果有）
                    if (responseBuffer.length > bodyStart) {
                      const bodyChunk = responseBuffer.subarray(bodyStart)
                      responseBody += bodyChunk.toString('utf-8')
                    }
                  }
                } else {
                  // 继续接收响应体
                  responseBody += chunk.toString('utf-8')
                }
                
                // 如果知道内容长度，检查是否接收完成
                if (contentLength !== null && responseBody.length >= contentLength) {
                  responseBody = responseBody.substring(0, contentLength)
                  tlsSocket.end()
                }
              })
              
              tlsSocket.on('end', () => {
                logger.info(`✅ 响应接收完成，总大小: ${responseBuffer.length} 字节，响应体: ${responseBody.length} 字节`)
                try {
                  if (!responseBody) {
                    logger.error('❌ 收到空响应体')
                    reject(new Error('收到空响应'))
                    return
                  }
                  
                  // 尝试解析JSON
                  const jsonData = JSON.parse(responseBody)
                  logger.info('✅ JSON解析成功')
                  
                  // 记录成功请求（用于监控）
                  recordRequest(false)
                  
                  resolve(jsonData)
                } catch (parseError) {
                  logger.error('❌ JSON解析失败:', parseError.message)
                  logger.error('❌ 响应数据（前1000字符）:', responseBody.substring(0, 1000))
                  reject(new Error(`解析响应失败: ${parseError.message}`))
                }
              })
              
              tlsSocket.setTimeout(60000, () => {
                logger.error('❌ TLS连接超时（60秒）')
                tlsSocket.destroy()
                tunnelSocket.destroy()
                reject(new Error('TLS连接超时'))
              })
            } catch (error) {
              logger.error('❌ 建立TLS连接时出错:', error.message)
              reject(error)
            }
          })
        })
        
        proxyReq.on('error', (error) => {
          logger.error('❌ 代理请求错误:', error.message)
          logger.error('❌ 错误代码:', error.code)
          logger.error('❌ 错误堆栈:', error.stack)
          reject(new Error(`代理连接错误: ${error.message} (${error.code})`))
        })
        
        proxyReq.on('timeout', () => {
          logger.error('❌ 代理连接超时（10秒）- timeout事件触发')
          proxyReq.destroy()
          reject(new Error('代理连接超时'))
        })
        
        // 添加socket连接事件监听
        proxyReq.on('socket', (socket) => {
          logger.info('🔌 Socket已分配')
          socket.on('connect', () => {
            logger.info('✅ Socket已连接到代理服务器')
          })
          socket.on('error', (error) => {
            logger.error('❌ Socket错误:', error.message)
          })
          socket.on('timeout', () => {
            logger.error('❌ Socket超时')
          })
        })
        
        proxyReq.setTimeout(10000, () => {
          logger.error('❌ 代理连接超时（setTimeout触发）- 10秒内未收到响应')
          proxyReq.destroy()
          reject(new Error('代理连接超时：10秒内未收到代理服务器响应'))
        })
        
        logger.info(`📤 发送CONNECT请求到代理: ${targetHost}:${targetPort}`)
        logger.info(`📤 CONNECT请求路径: ${targetHost}:${targetPort}`)
        proxyReq.end()
      } catch (error) {
        reject(error)
      }
    })
  }

  async getAds(adAccountId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adAccountId}/ads`
      const params = {
        // 增加层级/状态字段，前端可展示更完整的广告详情
        fields: 'id,name,status,effective_status,configured_status,adset_id,campaign_id,creative{id,name}',
        // 关键：显式提高 limit，并做分页，避免默认 25 条
        limit: 500,
        access_token: this.accessToken
      }
      const all = []
      let currentUrl = url
      let currentParams = params
      while (currentUrl) {
        const data = await this.makeRequest(currentUrl, currentParams, 'GET', null, {
          requestPriority: 'today',
          requestLabel: 'get_ads'
        })
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
        all.push(...(data.data || []))
        currentUrl = data?.paging?.next || null
        currentParams = { access_token: this.accessToken }
      }
      return all
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`获取广告列表失败: ${error.message}`)
    }
  }

  async getAdInsights(adAccountId, timeRange = null, options = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
    const level = options?.level || 'ad'
    // P0：Route1（账户级 GET）必须返回 ROI 核心字段，避免 purchase_value/roas 因字段缺失而整体失真
    const fullFields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,cpc,cpm,inline_link_clicks,unique_inline_link_clicks,actions,action_values,unique_actions,cost_per_action_type,purchase_roas,website_purchase_roas'
    // 兼容降级：去掉非核心展示字段，但保留 ROI 核心字段（actions/action_values/purchase_roas）
    const fallbackFields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,inline_link_clicks,unique_inline_link_clicks,actions,action_values,unique_actions,cost_per_action_type,purchase_roas,website_purchase_roas'

    const buildParams = (fields) => {
      const params = {
        fields,
        level,
        limit: Number.isFinite(Number(options?.limit)) ? Number(options.limit) : 200,
        access_token: this.accessToken
      }
      if (timeRange?.since && timeRange?.until) {
        params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until })
      } else if (timeRange?.preset) {
        params.date_preset = timeRange.preset
      } else {
        params.date_preset = 'today'
      }
      if (options?.useAccountAttributionSetting) params.use_account_attribution_setting = true
      if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length > 0) {
        params.action_attribution_windows = options.actionAttributionWindows
      }
      // 可选：在 FB 端就做 spend>0 过滤，减少包体与 CPU；可通过 DISABLE_SPEND_FILTERING 关闭
      if (options?.spendGreaterThanZero === true && process.env.DISABLE_SPEND_FILTERING !== '1') {
        const filtering = buildSpendFiltering()
        params.filtering = JSON.stringify(filtering)
      }
      return params
    }

    const mapItem = (item) => ({
      campaign_id: item.campaign_id,
      campaign_name: item.campaign_name,
      adset_id: item.adset_id,
      adset_name: item.adset_name,
      ad_id: item.ad_id,
      ad_name: item.ad_name,
      impressions: parseInt(item.impressions || '0'),
      clicks: parseInt(item.clicks || '0'),
      spend: parseFloat(item.spend || '0'),
      ctr: parseFloat(item.ctr || '0'),
      cpc: parseFloat(item.cpc || '0'),
      cpm: parseFloat(item.cpm || '0'),
      inline_link_clicks: item.inline_link_clicks,
      unique_inline_link_clicks: item.unique_inline_link_clicks,
      actions: item.actions,
      action_values: item.action_values,
      unique_actions: item.unique_actions,
      cost_per_action_type: item.cost_per_action_type,
      purchase_roas: item.purchase_roas,
      website_purchase_roas: item.website_purchase_roas,
      date_start: item.date_start,
      date_stop: item.date_stop
    })

    try {
      let currentParams = buildParams(fullFields)
      const allInsights = []
      let currentUrl = url

      while (currentUrl) {
        let data
        try {
          data = await this.makeRequest(currentUrl, currentParams, 'GET', null, {
            requestPriority: 'today',
            requestLabel: 'get_ad_insights',
            signal: options?.signal || null
          })
        } catch (e) {
          if (this.isInvalidFieldError(e) && currentParams.fields === fullFields) {
            currentParams = buildParams(fallbackFields)
            currentUrl = url
            continue
          }
          throw e
        }
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)

        const dataList = Array.isArray(data?.data) ? data.data : []
        const pageInsights = dataList.map(mapItem)
        allInsights.push(...pageInsights)

        currentUrl = data.paging?.next || null
        currentParams = { access_token: this.accessToken }
      }

      return allInsights
    } catch (error) {
      if (error.response?.data?.error) {
        throw new Error(`Facebook API Error: ${error.response.data.error.message}`)
      }
      throw error
    }
  }

  // 只统计 purchase（购买）作为转化（与需求一致）
  extractPurchaseCount(actions) {
    if (!actions || !Array.isArray(actions)) return 0
    const conversionActions = actions.filter((a) => {
      if (!a || !a.action_type) return false
      const t = String(a.action_type).toLowerCase()
      return t.includes('purchase')
    })
    return conversionActions.reduce((sum, a) => {
      const v = parseInt(a?.value || '0')
      return sum + (Number.isNaN(v) ? 0 : v)
    }, 0)
  }

  // 从数组中“选择一个最合适”的 action 值（避免重复 action_type 叠加导致倍率异常）
  pickActionValue(actions, { exact = [], contains = [] } = {}) {
    if (!actions || !Array.isArray(actions)) return 0
    const norm = (s) => String(s || '').toLowerCase()
    const list = actions
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    // 1) 精确匹配优先
    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseInt(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    // 2) 包含匹配兜底（取第一个命中的“优先级”项）
    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseInt(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    // 3) 如果只有一个匹配项，返回它；多个匹配项避免相加，取最大值（更接近 Ads Manager 单一口径）
    if (contains.length > 0) {
      const hits = list.filter(x => contains.some(sub => x.type.includes(norm(sub))))
      if (hits.length === 1) {
        const v = parseInt(hits[0].raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
      if (hits.length > 1) {
        let mx = 0
        for (const h of hits) {
          const v = parseInt(h.raw?.value || '0')
          if (!Number.isNaN(v)) mx = Math.max(mx, v)
        }
        return mx
      }
    }

    return 0
  }

  pickActionAmount(actionValues, { exact = [], contains = [] } = {}) {
    if (!actionValues || !Array.isArray(actionValues)) return 0
    const norm = (s) => String(s || '').toLowerCase()
    const list = actionValues
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    if (contains.length > 0) {
      const hits = list.filter(x => contains.some(sub => x.type.includes(norm(sub))))
      if (hits.length === 1) {
        const v = parseFloat(hits[0].raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
      if (hits.length > 1) {
        let mx = 0
        for (const h of hits) {
          const v = parseFloat(h.raw?.value || '0')
          if (!Number.isNaN(v)) mx = Math.max(mx, v)
        }
        return mx
      }
    }

    return 0
  }

  // 购买次数：优先使用最常见的 purchase 口径（避免把多个 purchase 变体加总）
  extractPurchaseCount(actions) {
    return this.pickActionValue(actions, {
      exact: [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ],
      contains: [
        'fb_pixel_purchase',
        '.purchase',
        'purchase'
      ]
    })
  }

  // 购买金额：同上逻辑（action_values）
  extractPurchaseAmount(actionValues) {
    return this.pickActionAmount(actionValues, {
      exact: [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ],
      contains: [
        'fb_pixel_purchase',
        '.purchase',
        'purchase'
      ]
    })
  }

  // cost_per_action_type：从数组里挑选某个 action_type 的官方“单次费用”
  pickCostPerActionType(costArr, { exact = [], contains = [] } = {}) {
    if (!costArr || !Array.isArray(costArr)) return null
    const norm = (s) => String(s || '').toLowerCase()
    const list = costArr
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? null : v
      }
    }
    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? null : v
      }
    }
    return null
  }

  // 像素事件（网站）action_type 的“最常用”映射：用于对齐 Ads Manager 的「网站购物/加购/结账/支付信息」
  pixelActionTypes(eventKey) {
    const k = String(eventKey || '').toLowerCase()
    // 说明：
    // - Ads Manager 里“网站购物”通常对应 offsite_conversion.fb_pixel_purchase
    // - 同时保留少量兜底（purchase / omni_purchase 等）避免不同账户配置差异
    if (k === 'purchase') return {
      exact: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
      contains: ['fb_pixel_purchase', '.purchase', 'purchase']
    }
    if (k === 'add_to_cart') return {
      exact: ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
      contains: ['fb_pixel_add_to_cart', 'add_to_cart']
    }
    if (k === 'initiate_checkout') return {
      exact: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
      contains: ['fb_pixel_initiate_checkout', 'initiate_checkout']
    }
    if (k === 'add_payment_info') return {
      exact: ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info'],
      contains: ['fb_pixel_add_payment_info', 'add_payment_info']
    }
    return { exact: [eventKey], contains: [eventKey] }
  }

  isInvalidFieldError(e) {
    const msg = String(
      e?.response?.data?.error?.message ||
      e?.error?.message ||
      e?.message ||
      ''
    )
    const lower = msg.toLowerCase()
    return (
      lower.includes('nonexisting summary field') ||
      lower.includes('unknown') ||
      lower.includes('invalid') ||
      lower.includes('unsupported') ||
      (lower.includes('field') && lower.includes('does not exist'))
    )
  }

  // ROI 深度指标：购买/加购/结账/支付 + 购买金额 + 独立链接点击（unique_actions 里提取 link_click）
  async getAdInsightsWithROI(adAccountId, timeRange = null, options = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
    const level = options?.level || 'ad'
    // 根据层级调整字段：adset/campaign 层级需要包含对应 id/name
    const idFields = level === 'adset' ? 'adset_id,adset_name' : (level === 'campaign' ? 'campaign_id,campaign_name' : 'ad_id,ad_name')
    const baseFields = `${idFields},actions,action_values,unique_actions,cost_per_action_type`
    const extraFields = 'cost_per_unique_link_click,cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = {
      fields: `${baseFields},${extraFields}`,
      level: level,
      access_token: this.accessToken
    }
    if (timeRange?.since && timeRange?.until) {
      params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until })
    } else if (timeRange?.preset) {
      params.date_preset = timeRange.preset
    } else {
      params.date_preset = 'today'
    }
    if (options?.useAccountAttributionSetting) params.use_account_attribution_setting = true
    if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length) {
      params.action_attribution_windows = options.actionAttributionWindows
    }

    let data
    try {
      data = await this.makeRequest(url, params, 'GET', null, {
        requestPriority: 'cold',
        requestLabel: 'get_ad_insights_roi'
      })
      if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
    } catch (e) {
      // 有些账号/版本对部分字段不支持：降级为“最稳字段集”，保证接口可用
      if (this.isInvalidFieldError(e)) {
        const fallbackParams = { ...params, fields: baseFields }
        data = await this.makeRequest(url, fallbackParams, 'GET', null, {
          requestPriority: 'cold',
          requestLabel: 'get_ad_insights_roi_fallback'
        })
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      } else {
        throw e
      }
    }

    return (data.data || []).map(item => {
      // 根据层级确定主键字段
      const idKey = level === 'adset' ? 'adset_id' : (level === 'campaign' ? 'campaign_id' : 'ad_id')
      const idValue = String(item[idKey] || '')
      return {
        [idKey]: idValue,
        // counts / values
        purchases: this.pickActionValue(item.actions, this.pixelActionTypes('purchase')),
        purchase_value: this.pickActionAmount(item.action_values, this.pixelActionTypes('purchase')),
        add_to_cart: this.pickActionValue(item.actions, this.pixelActionTypes('add_to_cart')),
        initiate_checkout: this.pickActionValue(item.actions, this.pixelActionTypes('initiate_checkout')),
        add_payment_info: this.pickActionValue(item.actions, this.pixelActionTypes('add_payment_info')),
        unique_link_clicks: this.pickActionValue(item.unique_actions, { exact: ['link_click'], contains: ['link_click'] }),

        // 官方费用字段（用于更贴近 Ads Manager）
        cpa: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('purchase')),
        cp_atc: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_to_cart')),
        cp_ic: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('initiate_checkout')),
        cp_api: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_payment_info')),

        // uCPC：Ads Manager “单次链接点击费用-独立用户”优先用官方 cost_per_unique_*（不同账户可能落在 link_click 或 inline_link_click）
        ucpc: (() => {
          const a = parseFloat(item?.cost_per_unique_link_click || '')
          if (!Number.isNaN(a) && a > 0) return a
          const b = parseFloat(item?.cost_per_unique_inline_link_click || '')
          if (!Number.isNaN(b) && b > 0) return b
          return null
        })(),
        unique_inline_link_clicks: (() => {
          const v = parseInt(item?.unique_inline_link_clicks || '0')
          return Number.isNaN(v) ? null : v
        })()
      }
    })
  }

  async startRoiAsyncJob(adAccountId, timeRange = null, options = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
    const level = options?.level || 'ad'
    // 根据层级调整字段：adset/campaign 层级需要包含对应 id/name
    const idFields = level === 'adset' ? 'adset_id,adset_name' : (level === 'campaign' ? 'campaign_id,campaign_name' : 'ad_id,ad_name')
    const baseFields = `${idFields},actions,action_values,unique_actions,cost_per_action_type`
    // 注意：cost_per_unique_link_click 在某些 report-run 场景会导致 (#100) nonexisting summary field，
    // 会让 /{report_run_id}/insights 直接 400，从而前端一直轮询失败。这里异步任务不请求它，避免“卡死”。
    const extraFields = 'cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = {
      fields: `${baseFields},${extraFields}`,
      level: level,
      async: true,
      access_token: this.accessToken
    }
    if (timeRange?.since && timeRange?.until) {
      params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until })
    } else if (timeRange?.preset) {
      params.date_preset = timeRange.preset
    } else {
      params.date_preset = 'today'
    }
    if (options?.useAccountAttributionSetting) params.use_account_attribution_setting = true
    if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length) {
      params.action_attribution_windows = options.actionAttributionWindows
    }

    try {
      const data = await this.makeRequest(url, params, 'POST', null, {
        requestPriority: 'cold',
        requestLabel: 'start_roi_async_job'
      })
      if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      return data.report_run_id || data.id
    } catch (e) {
      if (this.isInvalidFieldError(e)) {
        const fallbackParams = { ...params, fields: baseFields }
        const data = await this.makeRequest(url, fallbackParams, 'POST', null, {
          requestPriority: 'cold',
          requestLabel: 'start_roi_async_job_fallback'
        })
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
        return data.report_run_id || data.id
      }
      throw e
    }
  }

  async getReportRunStatus(reportRunId) {
    const url = `${FACEBOOK_API_BASE}/${reportRunId}`
    const params = { fields: 'async_status,async_percent_completion', access_token: this.accessToken }
    const data = await this.makeRequest(url, params, 'GET', null, {
      requestPriority: 'cold',
      requestLabel: 'report_run_status'
    })
    if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
    const percent = parseInt(data.async_percent_completion || '0')
    return { status: data.async_status, percent: Number.isNaN(percent) ? 0 : percent }
  }

  async getReportRunInsightsAll(reportRunId) {
    let url = `${FACEBOOK_API_BASE}/${reportRunId}/insights`
    // report-run 的 insights 拉取：显式指定 fields，避免 FB 尝试返回某些“不存在的 summary 字段”导致 400
    const baseFields = 'ad_id,actions,action_values,unique_actions,cost_per_action_type'
    const extraFields = 'cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = { limit: 500, fields: `${baseFields},${extraFields}`, access_token: this.accessToken }
    const rows = []
    while (url) {
      let data
      try {
        data = await this.makeRequest(url, params, 'GET', null, {
          requestPriority: 'cold',
          requestLabel: 'report_run_insights'
        })
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      } catch (e) {
        // 若 report-run 不支持 extraFields，则降级回 baseFields，至少拿到购买/漏斗/官方 CPA
        if (this.isInvalidFieldError(e)) {
          const fallbackParams = { ...params, fields: baseFields }
          data = await this.makeRequest(url, fallbackParams, 'GET', null, {
            requestPriority: 'cold',
            requestLabel: 'report_run_insights_fallback'
          })
          if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
        } else {
          throw e
        }
      }
      rows.push(...(data.data || []))
      url = data.paging?.next || null
      // 下一页是完整 URL，后续请求不用 params（next 已带 token），但为了安全仍带 token
      params.access_token = this.accessToken
    }
    return rows
  }

  extractRoiFromInsights(rows, level = 'ad') {
    const out = {}
    // 根据层级确定主键字段
    const idKey = level === 'adset' ? 'adset_id' : (level === 'campaign' ? 'campaign_id' : 'ad_id')
    for (const item of rows || []) {
      const id = String(item[idKey] || '')
      if (!id) continue
      out[id] = {
        [idKey]: id,
        purchases: this.pickActionValue(item.actions, this.pixelActionTypes('purchase')),
        purchase_value: this.pickActionAmount(item.action_values, this.pixelActionTypes('purchase')),
        add_to_cart: this.pickActionValue(item.actions, this.pixelActionTypes('add_to_cart')),
        initiate_checkout: this.pickActionValue(item.actions, this.pixelActionTypes('initiate_checkout')),
        add_payment_info: this.pickActionValue(item.actions, this.pixelActionTypes('add_payment_info')),
        unique_link_clicks: this.pickActionValue(item.unique_actions, { exact: ['link_click'], contains: ['link_click'] }),

        cpa: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('purchase')),
        cp_atc: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_to_cart')),
        cp_ic: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('initiate_checkout')),
        cp_api: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_payment_info')),
        ucpc: (() => {
          const a = parseFloat(item?.cost_per_unique_link_click || '')
          if (!Number.isNaN(a) && a > 0) return a
          const b = parseFloat(item?.cost_per_unique_inline_link_click || '')
          if (!Number.isNaN(b) && b > 0) return b
          return null
        })(),
        unique_inline_link_clicks: (() => {
          const v = parseInt(item?.unique_inline_link_clicks || '0')
          return Number.isNaN(v) ? null : v
        })()
      }
    }
    return out
  }

  async pauseAd(adId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adId}`
      const params = {
        status: 'PAUSED',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'POST', null, {
        requestPriority: 'action',
        requestLabel: 'pause_ad'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`暂停广告失败: ${error.message}`)
    }
  }

  async activateAd(adId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adId}`
      const params = {
        status: 'ACTIVE',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'POST', null, {
        requestPriority: 'action',
        requestLabel: 'activate_ad'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`激活广告失败: ${error.message}`)
    }
  }

  // ============================================
  // M4 同层执行：adset / campaign 状态动作 API
  // ============================================

  async pauseAdset(adsetId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const body = {
        status: 'PAUSED',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'pause_adset'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`暂停广告组失败: ${error.message}`)
    }
  }

  async activateAdset(adsetId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const body = {
        status: 'ACTIVE',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'activate_adset'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`激活广告组失败: ${error.message}`)
    }
  }

  async pauseCampaign(campaignId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${campaignId}`
      const body = {
        status: 'PAUSED',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'pause_campaign'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`暂停广告系列失败: ${error.message}`)
    }
  }

  async activateCampaign(campaignId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${campaignId}`
      const body = {
        status: 'ACTIVE',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'activate_campaign'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`激活广告系列失败: ${error.message}`)
    }
  }

  /**
   * 获取广告组预算（M4 3.5：对上游暴露「分」）
   * FB API 的 daily_budget 读写均为账户最小货币单位（USD=分），GET 返回的已是分，不要乘 100
   * @returns {number} 预算（美分，整数）
   */
  async getAdsetBudget(adsetId) {
    const detail = await this.getAdsetBudgetDetail(adsetId)
    const raw = detail.daily_budget > 0 ? detail.daily_budget : detail.lifetime_budget
    return Math.round(Number(raw))
  }

  /**
   * 获取广告组预算明细（用于 ABO/CBO 判断：有则调 AdSet，无则向上调 Campaign）
   * @returns {{ daily_budget: number, lifetime_budget: number }} 美分，整数
   */
  async getAdsetBudgetDetail(adsetId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const params = {
        fields: 'daily_budget,lifetime_budget,budget_remaining',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'GET', null, {
        requestPriority: 'action',
        requestLabel: 'get_adset_budget_detail'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return {
        daily_budget: Math.round(Number(data.daily_budget ?? 0)),
        lifetime_budget: Math.round(Number(data.lifetime_budget ?? 0))
      }
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`获取广告组预算失败: ${error.message}`)
    }
  }

  /**
   * 更新广告组预算（M4 3.5：上游约定「分」；FB API 的 daily_budget 也要求「分」即最小货币单位）
   * FB API 要求 POST 参数放在 Body 中，不能放在 URL Query，否则返回 400。
   * @param {number} newBudgetCents - 预算（美分，整数）
   */
  async updateAdsetBudget(adsetId, newBudgetCents, isDaily = true) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const field = isDaily ? 'daily_budget' : 'lifetime_budget'
      // 参数放 Body，避免 400；makeRequest 收到 body 时以 JSON 发送
      const body = {
        [field]: Math.round(newBudgetCents),
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'update_adset_budget'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`更新广告组预算失败: ${error.message}`)
    }
  }

  /**
   * 获取广告系列预算（CBO/优势+系列预算时预算在 Campaign 上）
   * FB API 的 daily_budget/lifetime_budget 为账户最小货币单位（USD=分）
   * @returns {number} 预算（美分，整数），无则 0
   */
  async getCampaignBudget(campaignId) {
    const detail = await this.getCampaignBudgetDetail(campaignId)
    const raw = detail.daily_budget > 0 ? detail.daily_budget : detail.lifetime_budget
    return Math.round(Number(raw))
  }

  /**
   * 获取广告系列预算明细（用于 CBO 时决定用 daily 还是 lifetime 更新）
   * @returns {{ daily_budget: number, lifetime_budget: number }} 美分，整数
   */
  async getCampaignBudgetDetail(campaignId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${campaignId}`
      const params = {
        fields: 'daily_budget,lifetime_budget,budget_remaining',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'GET', null, {
        requestPriority: 'action',
        requestLabel: 'get_campaign_budget_detail'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return {
        daily_budget: Math.round(Number(data.daily_budget ?? 0)),
        lifetime_budget: Math.round(Number(data.lifetime_budget ?? 0))
      }
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`获取广告系列预算失败: ${error.message}`)
    }
  }

  /**
   * 更新广告系列预算（CBO 时用；参数放 Body，与 updateAdsetBudget 一致）
   * @param {number} newBudgetCents - 预算（美分，整数）
   */
  async updateCampaignBudget(campaignId, newBudgetCents, isDaily = true) {
    try {
      const url = `${FACEBOOK_API_BASE}/${campaignId}`
      const field = isDaily ? 'daily_budget' : 'lifetime_budget'
      const body = {
        [field]: Math.round(newBudgetCents),
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, {}, 'POST', body, {
        requestPriority: 'action',
        requestLabel: 'update_campaign_budget'
      })
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`更新广告系列预算失败: ${error.message}`)
    }
  }
}

// 规则引擎类
class RuleEngine {
  constructor(api) {
    this.api = api
    // 第1行：保存 Facebook API 客户端（用于执行动作，如暂停广告、调整预算）
    // 注意：虽然规则评估改为从数据库查询，但动作执行仍需要调用 Facebook API
  }

  /**
   * 评估规则（增强版：支持从数据库查询数据、目标筛选、AND/OR 逻辑）
   * @param {Object} rule - 规则对象（包含 conditions, logic_operator, target_level, target_ids, timezone_name 等）
   * @param {string|Array} accountIdOrInsights - Facebook 账户ID（新版本）或 insights 数组（旧版本，兼容）
   * @param {Array} insightsOrAds - 可选：insights 数组（旧版本）或 ads 数组（旧版本，兼容）
   * @param {Array} ads - 可选：ads 数组（旧版本，兼容）
   * @returns {Promise<boolean|Array>} 旧版本返回 boolean，新版本返回匹配的广告数据数组
   * 
   * 【增强功能】
   * 1. 支持从数据库查询数据（完全离线）
   * 2. 支持 target_level 和 target_ids 筛选
   * 3. 支持 AND/OR 逻辑运算符
   * 4. 支持时间窗口（time_window）
   * 
   * 【向后兼容】
   * - 如果第一个参数是字符串（accountId），使用新版本（从数据库查询）
   * - 如果第一个参数是数组（insights），使用旧版本（从 Facebook API 数据评估）
   */
  async evaluateRule(rule, accountIdOrInsights, insightsOrAds = null, ads = null) {
    // 第1-5行：判断调用方式（新版本还是旧版本）
    // 如果第一个参数是字符串，说明是新版本（传入 accountId）
    // 如果第一个参数是数组，说明是旧版本（传入 insights）
    const isNewVersion = typeof accountIdOrInsights === 'string'
    
    if (!isNewVersion) {
      // 旧版本：使用 Facebook API 返回的数据（向后兼容）
      return this.evaluateRuleLegacy(rule, accountIdOrInsights, insightsOrAds)
    }

    // 新版本：从数据库查询数据
    const accountId = accountIdOrInsights
    const insights = null  // 新版本不使用 insights
    const adsParam = null  // 新版本不使用 ads
    // 第2-3行：检查规则是否启用（如果未启用，直接返回空数组）
    if (!rule.enabled) {
      return []
    }

    // 第4-5行：获取账户时区（用于时间窗口计算）
    // 统一用 account_mappings.timezone_name，忽略 rules.timezone_name（历史 UTC 不影响）
    const timezoneName = await getAccountTimezone(accountId)

    // 第6-20行：根据 targetLevel 和 targetIds 筛选目标广告ID（多账户规则：仅取当前 accountId 下的目标）
    const ruleTargetLevel = rule.targetLevel || rule.target_level
    const targetByAccount = rule.targetByAccount ?? rule.target_by_account
    let ruleTargetIds = []
    if (targetByAccount && typeof targetByAccount === 'object' && accountId in targetByAccount) {
      const arr = targetByAccount[accountId]
      ruleTargetIds = Array.isArray(arr) ? arr.map(id => String(id)).filter(Boolean) : []
    } else if (targetByAccount && typeof targetByAccount === 'object') {
      // 多账户规则下该账户未在 target_by_account 中，本账户无目标（仅对有选中的账户有目标）
      ruleTargetIds = []
    } else {
      const raw = rule.targetIds || rule.target_ids || []
      const withAccount = raw.filter(id => String(id).trim().startsWith(accountId + ':'))
      if (withAccount.length > 0) {
        ruleTargetIds = withAccount.map(s => String(s).slice(String(s).indexOf(':') + 1)).filter(Boolean)
      } else {
        ruleTargetIds = raw.map(id => String(id)).filter(Boolean)
      }
    }
    let targetAdIds = []

    if (ruleTargetLevel && ruleTargetIds.length > 0) {
      if (ruleTargetLevel === 'ad') {
        targetAdIds = ruleTargetIds
        logger.info(`    🎯 规则限定目标广告: ${targetAdIds.length} 个 (${targetAdIds.slice(0, 3).join(', ')}${targetAdIds.length > 3 ? '...' : ''})`)
      } else {
        try {
          const filterColumn = ruleTargetLevel === 'adset' ? 'adset_id' : 'campaign_id'
          const placeholders = ruleTargetIds.map(() => '?').join(',')
          const [rows] = await pool.execute(`
            SELECT DISTINCT ad_id
            FROM structure_ads
            WHERE account_id = ?
              AND ${filterColumn} IN (${placeholders})
          `, [accountId, ...ruleTargetIds.map(id => String(id))])
          targetAdIds = rows.map(row => String(row.ad_id || '')).filter(id => id)
          logger.info(`    🎯 规则限定目标${ruleTargetLevel === 'adset' ? '广告组' : '广告系列'}: ${ruleTargetIds.length} 个，包含广告: ${targetAdIds.length} 个`)
        } catch (error) {
          logger.error(`    ❌ 查询 ${ruleTargetLevel} 下的广告ID失败:`, error.message)
          targetAdIds = []
        }
      }
    } else if (ruleTargetLevel && ruleTargetIds.length === 0 && targetByAccount && accountId in targetByAccount) {
      targetAdIds = []
    } else if (targetByAccount && typeof targetByAccount === 'object' && !(accountId in targetByAccount)) {
      // 多账户规则：该账户不在 target_by_account 中，本账户无目标，不查全量
      targetAdIds = []
    } else if (!ruleTargetLevel || ruleTargetIds.length === 0) {
      // 未指定 target 时从 structure_ads 取账户下全部 ad_id，与 campaign/adset 口径一致（含 spend=0 广告）
      try {
        const [rows] = await pool.execute(`
          SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ?
        `, [accountId])
        
        targetAdIds = rows.map(row => String(row.ad_id || '')).filter(id => id)
      } catch (error) {
        logger.error(`❌ 查询账户下所有广告ID失败 (accountId: ${accountId}):`, error.message)
        // 如果查询失败，返回空数组（不抛错，保证系统可用性）
        return []
      }
    }

    if (targetAdIds.length === 0) {
      // 如果没有目标广告，返回空数组
      return []
    }

    // 第21-35行：从数据库查询数据（使用 ruleDataService）
    // 注意：每个条件可能有不同的 time_window，需要分别查询
    // 为了简化，我们使用第一个条件的 time_window（如果所有条件都有 time_window）
    const logicOp = rule.logicOperator ?? rule.logic_operator ?? 'AND'
    const timeWindow = this.getTimeWindowFromConditions(rule.conditions, logicOp) || 'today'
    const customRange = timeWindow === 'custom_range' ? this.getCustomRangeFromConditions(rule.conditions, logicOp) : null

    let ruleData = []
    try {
      logger.info(`    📊 开始查询规则数据 (time_window=${timeWindow}, 广告数=${targetAdIds.length})...`)
      // 使用 ruleDataService 查询数据（完全离线，不调用 Facebook API）
      // 阶段A修复：queryRuleData 现在返回 { data, warnings }，需要解构
      const result = await queryRuleData(accountId, targetAdIds, timeWindow, timezoneName, customRange)
      ruleData = result.data || result  // 兼容旧格式（如果返回的是数组）
      logger.info(`    📊 规则数据查询完成，共 ${Array.isArray(ruleData) ? ruleData.length : 0} 条`)
    } catch (error) {
      // 如果数据库查询失败，记录错误并返回空数组（不抛错，保证系统可用性）
      logger.error(`❌ 规则数据查询失败 (accountId: ${accountId}, rule: ${rule.ruleName || rule.id}):`, error.message)
      return []
    }
    
    // 第36-50行：评估每个广告是否满足规则条件
    // 根据 logic_operator 选择不同的评估方法（AND 或 OR）
    const matchedAds = []
    
    // 确保 ruleData 是数组（兼容旧格式）
    const dataArray = Array.isArray(ruleData) ? ruleData : []
    
    for (const adData of dataArray) {
      // 评估条件（支持 AND/OR 逻辑）
      const conditionTrace = this.buildConditionTrace(rule.conditions, adData, rule.logicOperator ?? rule.logic_operator ?? 'AND')
      const conditionsMet = this.isConditionTraceMatched(conditionTrace)
      
      if (conditionsMet) {
        const targetLevel = String(rule.targetLevel || rule.target_level || adData.object_type || 'ad').toLowerCase()
        const objectType = adData.object_type || targetLevel
        const objectId = String(
          adData.object_id
          || (objectType === 'campaign' ? adData.campaign_id : (objectType === 'adset' ? (adData.ad_set_id || adData.adset_id) : adData.ad_id))
          || ''
        ).trim()
        const objectName = adData.object_name
          || (objectType === 'campaign' ? adData.campaign_name : (objectType === 'adset' ? (adData.adset_name || adData.ad_set_name) : adData.ad_name))
          || null
        const statusSourceRef = adData.status_source_ref
          || (objectType === 'campaign'
            ? 'structure_campaigns.effective_status'
            : (objectType === 'adset' ? 'structure_adsets.effective_status' : 'ad_snapshots.status'))
        // 如果满足条件，添加到匹配列表
        // 🔧 修复：使用扁平结构，与 actionExecutorService 期望的结构一致
        matchedAds.push({
          ad_id: adData.ad_id,
          ad_name: adData.ad_name,
          ad_set_id: adData.ad_set_id,  // 用于预算调整动作
          campaign_id: adData.campaign_id ?? null,  // CBO 时向上调系列预算
          objectType,
          objectId: objectId || null,
          objectName,
          statusSourceRef,
          aggregationTrace: adData.aggregationTrace || null,
          conditionTrace,
          status: adData.status,        // M4 Pre-Flight：用于 pause/activate 目标已达成判断
          mute_until: adData.mute_until,  // M4 Smart Mute：挂起截止时间
          mute_reason: adData.mute_reason, // M4 Smart Mute：挂起原因
          // 直接复制指标到顶层（扁平结构）
          spend: adData.spend,
          purchases: adData.purchases,
          cpc: adData.cpc,
          ucpc: adData.ucpc,
          roas: adData.roas,
          cpa: adData.cpa,
          add_to_cart_cost: adData.add_to_cart_cost,
          checkout_cost: adData.checkout_cost,
          payment_cost: adData.payment_cost,
          // 原始计数（用于高级分析）
          link_clicks: adData.link_clicks,
          unique_link_clicks: adData.unique_link_clicks,
          purchase_value: adData.purchase_value,
          add_to_cart_count: adData.add_to_cart_count,
          initiate_checkout_count: adData.initiate_checkout_count,
          add_payment_info_count: adData.add_payment_info_count
        })
      }
    }

    // 第51行：返回匹配的广告列表
    logger.info(`    ✅ 评估完成，匹配 ${matchedAds.length} 个广告`)
    return matchedAds
  }

  /**
   * 使用已拉取的规则数据评估规则（无 DB 调用，供 RuleEngineDispatcher 合并读使用）
   * @param {Object} rule - 规则对象（含 conditions, logicOperator/logic_operator, actions, enabled）
   * @param {Array<Object>} ruleDataArray - 已查询的广告数据数组（与 queryRuleData 返回格式一致）
   * @returns {Array<Object>} 匹配的广告列表（与 evaluateRule 返回的 matchedAds 结构一致）
   */
  evaluateRuleWithData(rule, ruleDataArray) {
    if (!rule.enabled) return []
    const logicOp = rule.logicOperator ?? rule.logic_operator ?? 'AND'
    const dataArray = Array.isArray(ruleDataArray) ? ruleDataArray : []
    const matchedAds = []
    for (const adData of dataArray) {
      const conditionTrace = this.buildConditionTrace(rule.conditions, adData, logicOp)
      const conditionsMet = this.isConditionTraceMatched(conditionTrace)
      if (conditionsMet) {
        const targetLevel = String(rule.targetLevel || rule.target_level || adData.object_type || 'ad').toLowerCase()
        const objectType = adData.object_type || targetLevel
        const objectId = String(
          adData.object_id
          || (objectType === 'campaign' ? adData.campaign_id : (objectType === 'adset' ? (adData.ad_set_id || adData.adset_id) : adData.ad_id))
          || ''
        ).trim()
        const objectName = adData.object_name
          || (objectType === 'campaign' ? adData.campaign_name : (objectType === 'adset' ? (adData.adset_name || adData.ad_set_name) : adData.ad_name))
          || null
        const statusSourceRef = adData.status_source_ref
          || (objectType === 'campaign'
            ? 'structure_campaigns.effective_status'
            : (objectType === 'adset' ? 'structure_adsets.effective_status' : 'ad_snapshots.status'))
        matchedAds.push({
          ad_id: adData.ad_id,
          ad_name: adData.ad_name,
          ad_set_id: adData.ad_set_id,
          campaign_id: adData.campaign_id ?? null,
          objectType,
          objectId: objectId || null,
          objectName,
          statusSourceRef,
          aggregationTrace: adData.aggregationTrace || null,
          conditionTrace,
          status: adData.status,
          mute_until: adData.mute_until,
          mute_reason: adData.mute_reason,
          spend: adData.spend,
          purchases: adData.purchases,
          cpc: adData.cpc,
          ucpc: adData.ucpc,
          roas: adData.roas,
          cpa: adData.cpa,
          add_to_cart_cost: adData.add_to_cart_cost,
          checkout_cost: adData.checkout_cost,
          payment_cost: adData.payment_cost,
          link_clicks: adData.link_clicks,
          unique_link_clicks: adData.unique_link_clicks,
          purchase_value: adData.purchase_value,
          add_to_cart_count: adData.add_to_cart_count,
          initiate_checkout_count: adData.initiate_checkout_count,
          add_payment_info_count: adData.add_payment_info_count
        })
      }
    }
    return matchedAds
  }

  /**
   * 评估规则（旧版本：使用 Facebook API 返回的数据，向后兼容）
   * @param {Object} rule - 规则对象
   * @param {Array} insights - Facebook API 返回的 insights
   * @param {Array} ads - Facebook API 返回的 ads
   * @returns {Promise<boolean>} 是否有广告满足条件
   */
  async evaluateRuleLegacy(rule, insights, ads) {
    // 第1行：检查规则是否启用
    if (!rule.enabled) return false

    // 第2-10行：遍历所有 insights，评估每个广告
    for (const insight of insights) {
      const ad = ads.find(a => a.id === insight.ad_id)
      if (!ad) continue

      // 检查所有条件是否满足（使用 AND 逻辑，旧版本不支持 OR）
      const conditionsMet = rule.conditions.every(condition => {
        return this.evaluateCondition(condition, insight)
      })

      if (conditionsMet) {
        // 执行所有操作（使用旧版本的 executeActions）
        await this.executeActionsLegacy(rule.actions, ad, insight)
        return true
      }
    }

    return false
  }

  /**
   * 执行动作（旧版本：向后兼容）
   * @param {Array} actions - 动作数组
   * @param {Object} ad - 广告对象（包含 id, adset_id 等）
   * @param {Object} insight - 洞察数据
   */
  async executeActionsLegacy(actions, ad, insight) {
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'pause_ad':
            await this.api.pauseAd(ad.id)
            break
          case 'activate_ad':
            await this.api.activateAd(ad.id)
            break
          case 'increase_budget':
          case 'decrease_budget':
            await this.adjustBudget(ad.adset_id, action)
            break
        }
      } catch (error) {
        logger.error(`执行操作失败: ${action.type}`, error)
      }
    }
  }

  /**
   * 从条件中提取时间窗口（支持 v1 array / v2 object）
   * 同规则内 time_window 须一致，不一致则抛错
   * @param {Array|Object} conditions - v1 数组或 v2 对象
   * @param {string} logicOperator - v1 的 logicOperator
   * @returns {string} 时间窗口类型
   */
  getTimeWindowFromConditions(conditions, logicOperator = 'AND') {
    const v2 = normalizeConditionsToV2(conditions, logicOperator)
    const all = getAllConditionsFromV2(v2)
    if (all.length === 0) return 'today'

    const ok = validateTimeWindowConsistency(v2)
    if (!ok.valid) throw new Error(ok.error)

    for (const c of all) {
      if (c.time_window) return c.time_window
    }
    return 'today'
  }

  /**
   * 从条件中提取 custom_range（支持 v1/v2，仅当 time_window='custom_range' 时使用）
   * 同规则内 custom_range 须一致，不一致则抛错
   */
  getCustomRangeFromConditions(conditions, logicOperator = 'AND') {
    const v2 = normalizeConditionsToV2(conditions, logicOperator)
    const all = getAllConditionsFromV2(v2)
    if (all.length === 0) return null

    const ok = validateTimeWindowConsistency(v2)
    if (!ok.valid) throw new Error(ok.error)

    for (const c of all) {
      if (c.time_window === 'custom_range' && c.custom_range?.since && c.custom_range?.until) {
        return { since: c.custom_range.since, until: c.custom_range.until }
      }
    }
    return null
  }

  /**
   * 评估所有条件（DNF：OR of AND groups）
   * 支持 v1 与 v2，先归一化再评估
   * @param {Array|Object} conditions - v1 数组或 v2 对象
   * @param {Object} adData - 广告数据
   * @param {string} logicOperator - v1 的 logicOperator
   * @returns {boolean} 是否满足至少一个 AND 组
   */
  evaluateConditions(conditions, adData, logicOperator = 'AND') {
    const v2 = normalizeConditionsToV2(conditions, logicOperator)
    if (!v2.groups?.length) return true
    return v2.groups.some(g =>
      (g.conditions || []).every(c => this.evaluateCondition(c, adData))
    )
  }

  buildConditionTrace(conditions, adData, logicOperator = 'AND') {
    const v2 = normalizeConditionsToV2(conditions, logicOperator)
    const groups = Array.isArray(v2?.groups) ? v2.groups : []
    if (groups.length === 0) return []
    const traces = []
    let traceIndex = 0
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]
      const conds = Array.isArray(group?.conditions) ? group.conditions : []
      for (let conditionIndex = 0; conditionIndex < conds.length; conditionIndex++) {
        const condition = conds[conditionIndex]
        const actual = this.getMetricValue(condition.metric, adData)
        const expected = condition.value
        const passed = this.evaluateCondition(condition, adData)
        traces.push({
          index: traceIndex++,
          groupIndex,
          conditionIndex,
          metric: condition.metric,
          operator: condition.operator,
          threshold: expected,
          actual,
          passed,
          formula: `${condition.metric} ${condition.operator} ${expected}`
        })
      }
    }
    return traces
  }

  isConditionTraceMatched(conditionTrace) {
    if (!Array.isArray(conditionTrace) || conditionTrace.length === 0) return true
    const groupPassed = new Map()
    for (const item of conditionTrace) {
      if (!groupPassed.has(item.groupIndex)) groupPassed.set(item.groupIndex, true)
      if (!item.passed) groupPassed.set(item.groupIndex, false)
    }
    return [...groupPassed.values()].some(Boolean)
  }

  /**
   * 评估单个条件（增强版：支持时间窗口）
   * @param {Object} condition - 条件对象 { metric, operator, value, time_window }
   * @param {Object} adData - 广告数据（来自数据库查询，已包含时间窗口数据）
   * @returns {boolean} 是否满足条件
   * 
   * 【增强功能】
   * - 支持 time_window 参数（虽然数据已经按 time_window 查询，这里保留兼容性）
   * - 支持新的指标（roas, cpa, purchases 等）
   */
  evaluateCondition(condition, adData) {
    // 第1行：获取指标值（从 adData 中提取）
    const metricValue = this.getMetricValue(condition.metric, adData)
    
    // 第2-15行：根据操作符评估条件
    // 支持的操作符：gt, lt, eq, gte, lte, ne（不等于）
    switch (condition.operator) {
      case 'gt':
        return metricValue > condition.value
      case 'lt':
        return metricValue < condition.value
      case 'eq':
        return metricValue === condition.value
      case 'ne':
        return metricValue !== condition.value
      case 'gte':
        return metricValue >= condition.value
      case 'lte':
        return metricValue <= condition.value
      default:
        // 如果操作符不支持，返回 false（保守策略）
        logger.warn(`⚠️  不支持的操作符: ${condition.operator}`)
        return false
    }
  }

  /**
   * 获取指标值（增强版：支持新字段）
   * @param {string} metric - 指标名称（如 'spend', 'purchases', 'roas', 'cpa' 等）
   * @param {Object} adData - 广告数据（来自数据库查询或 Facebook API）
   * @returns {number} 指标值（如果不存在，返回 0 或 null）
   * 
   * 【增强功能】
   * - 支持新字段：roas, cpa, purchases, purchase_value, ucpc, add_to_cart_cost 等
   * - 兼容旧字段：ctr, cpc, spend, conversions, clicks, impressions, cpm
   * - 防御性编程：如果字段不存在，返回 0（避免 NaN 传播）
   */
  getMetricValue(metric, adData) {
    // 第1-15行：支持新字段（来自数据库查询）
    // 这些字段在 ruleDataService 中已经计算好，直接使用
    switch (metric) {
      // 绝对值指标
      case 'spend':
        return parseFloat(adData.spend || 0)
      case 'purchases':
        return parseInt(adData.purchases || 0)
      case 'purchase_value':
        return parseFloat(adData.purchase_value || 0)
      case 'link_clicks':
        return parseInt(adData.link_clicks || 0)
      case 'unique_link_clicks':
        return parseInt(adData.unique_link_clicks || 0)
      case 'add_to_cart_count':
        return parseInt(adData.add_to_cart_count || 0)
      case 'initiate_checkout_count':
        return parseInt(adData.initiate_checkout_count || 0)
      case 'add_payment_info_count':
        return parseInt(adData.add_payment_info_count || 0)
      
      // 单价/比率类指标
      case 'cpc':
        return adData.cpc != null ? parseFloat(adData.cpc) : 0
      case 'roas':
        return adData.roas != null ? parseFloat(adData.roas) : 0
      case 'cpa':
        return adData.cpa != null ? parseFloat(adData.cpa) : 0
      case 'ucpc':
        return adData.ucpc != null ? parseFloat(adData.ucpc) : 0
      case 'add_to_cart_cost':
        return adData.add_to_cart_cost != null ? parseFloat(adData.add_to_cart_cost) : 0
      case 'checkout_cost':
        return adData.checkout_cost != null ? parseFloat(adData.checkout_cost) : 0
      case 'payment_cost':
        return adData.payment_cost != null ? parseFloat(adData.payment_cost) : 0
      
      // 兼容旧字段（来自 Facebook API）
      case 'ctr':
        return parseFloat(adData.ctr || 0)
      case 'conversions':
        // conversions 兼容 purchases（购买次数）
        return parseInt(adData.conversions || adData.purchases || 0)
      case 'clicks':
        // clicks 兼容 link_clicks
        return parseInt(adData.clicks || adData.link_clicks || 0)
      case 'impressions':
        return parseInt(adData.impressions || 0)
      case 'cpm':
        return parseFloat(adData.cpm || 0)
      
      default:
        // 如果指标不支持，返回 0（保守策略，避免 NaN 传播）
        logger.warn(`⚠️  不支持的指标: ${metric}`)
        return 0
    }
  }

  /**
   * 执行动作（增强版：使用 ad_set_id 执行预算调整）
   * @param {Array} actions - 动作数组
   * @param {Object} matchedAd - 匹配的广告数据（包含 ad_id, ad_set_id 等）
   * @returns {Promise<Array>} 执行结果数组
   * 
   * 【增强功能】
   * - 使用 ad_set_id 执行预算调整（从数据库查询的数据中获取 ad_set_id）
   * - 支持 Dry Run 模式（is_simulation）
   * - 错误处理：单个动作失败不影响其他动作
   */
  async executeActions(actions, matchedAd, isSimulation = false) {
    // 第1-2行：如果动作数组为空，直接返回
    if (!actions || actions.length === 0) {
      return []
    }

    // 第3-4行：初始化结果数组，用于记录每个动作的执行结果
    const results = []

    // 第5-25行：遍历所有动作，逐个执行
    for (const action of actions) {
      try {
        // 第6-7行：如果是 Dry Run 模式，只记录日志，不执行真实动作
        if (isSimulation) {
          logger.info(`[Dry Run] 广告 ${matchedAd.ad_id} 将执行动作: ${action.type}`, action)
          results.push({ action, status: 'simulated', success: true })
          continue
        }

        // 第8-20行：根据动作类型执行不同的操作
        switch (action.type) {
          case 'pause_ad':
            // 暂停广告（使用 ad_id）
            await this.api.pauseAd(matchedAd.ad_id)
            results.push({ action, status: 'executed', success: true })
            break
          
          case 'activate_ad':
            // 激活广告（使用 ad_id）
            await this.api.activateAd(matchedAd.ad_id)
            results.push({ action, status: 'executed', success: true })
            break
          
          case 'increase_budget':
          case 'decrease_budget':
            // 调整预算（使用 ad_set_id，从数据库查询的数据中获取）
            // 注意：ad_set_id 在 ruleDataService 查询时已经包含在返回数据中
            if (matchedAd.ad_set_id) {
              await this.adjustBudget(matchedAd.ad_set_id, action)
              results.push({ action, status: 'executed', success: true })
            } else {
              // 如果 ad_set_id 不存在，记录错误
              logger.error(`❌ 无法调整预算：广告 ${matchedAd.ad_id} 没有 ad_set_id`)
              results.push({ action, status: 'failed', success: false, error: 'ad_set_id 不存在' })
            }
            break
          
          default:
            // 如果动作类型不支持，记录警告
            logger.warn(`⚠️  不支持的动作类型: ${action.type}`)
            results.push({ action, status: 'skipped', success: false, error: '不支持的动作类型' })
        }
      } catch (error) {
        // 第21-22行：如果动作执行失败，记录错误但不中断其他动作
        logger.error(`❌ 执行动作失败: ${action.type} (广告: ${matchedAd.ad_id})`, error.message)
        results.push({ action, status: 'failed', success: false, error: error.message })
      }
    }

    // 第23行：返回所有动作的执行结果
    return results
  }

  /**
   * 调整预算（增强版：使用 ad_set_id）
   * @param {string} adsetId - 广告组ID（从数据库查询的数据中获取）
   * @param {Object} action - 动作对象 { type: 'increase_budget' | 'decrease_budget', value: number }
   * @returns {Promise<void>}
   * 
   * 【增强功能】
   * - 使用 ad_set_id 执行预算调整（不需要额外查询 Facebook API）
   * - 支持百分比调整（value 为百分比，如 20 表示增加 20%）
   * - 支持预算上限护栏（max_daily_budget）
   */
  async adjustBudget(adsetId, action) {
    const currentBudgetCents = await this.api.getAdsetBudget(adsetId)
    let newBudgetCents
    if (action.value !== undefined) {
      if (action.type === 'increase_budget') {
        newBudgetCents = currentBudgetCents * (1 + action.value / 100)
      } else {
        newBudgetCents = currentBudgetCents * (1 - action.value / 100)
      }
    } else {
      newBudgetCents = action.type === 'increase_budget' ? currentBudgetCents * 1.1 : currentBudgetCents * 0.9
    }
    newBudgetCents = Math.max(100, Math.round(newBudgetCents))
    if (action.max_daily_budget != null) {
      newBudgetCents = Math.min(newBudgetCents, Math.round(Number(action.max_daily_budget)))
    }
    await this.api.updateAdsetBudget(adsetId, newBudgetCents)
  }
}

// API 路由
// 注意：这些路由只在 app 对象存在时注册（避免测试时的循环依赖问题）
if (app) {
// 获取广告账户列表（按登录用户隔离）
// 优化：默认从数据库读取，避免频繁调用 FB API 导致限流
// 支持 ?force=1 参数，管理员可强制从 FB 刷新
app.get('/api/accounts', requireAuth, requireActive, async (req, res) => {
  const startTime = Date.now()
  try {
    logger.info('')
    logger.info('='.repeat(50))
    logger.info('📥 收到请求: GET /api/accounts')
    logger.info('👤 当前用户:', req.user.username, '| 角色:', req.user.role, '| 负责人:', req.user.owner_name || '无')
    logger.info('⏰ 时间:', new Date().toLocaleString('zh-CN'))
    
    // 检查是否强制从 FB 刷新（仅管理员可用）
    const forceRefresh = req.query.force === '1' || req.query.force === 'true'
    
    if (forceRefresh && isAdminLikeRole(req.user.role)) {
      logger.info('🔄 管理员触发强制刷新，从 Facebook API 同步账户...')
      await syncAccountsFromFacebook()
    }
    
    // 从数据库读取账户列表（不调用 FB API）
    logger.info('🔍 从数据库获取账户列表...')
    const accounts = await getAccountsFromDatabase(req.user)
    
    const duration = Date.now() - startTime
    logger.info(`✅ 成功返回 ${accounts.length} 个账户 (耗时: ${duration}ms)`)
    logger.info('📋 账户列表:')
    accounts.forEach((acc, index) => {
      logger.info(`   ${index + 1}. ${acc.name} (${acc.id})`)
    })
    logger.info('='.repeat(50))
    logger.info('')
    
    res.json({ accounts })
  } catch (error) {
    const duration = Date.now() - startTime
    logger.error('❌ 获取账户列表失败 (耗时: ' + duration + 'ms)')
    logger.error('❌ 错误消息:', error.message)
    logger.error('❌ 错误堆栈:', error.stack)
    logger.info('='.repeat(50))
    logger.info('')
    
    res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    })
  }
})

// 解析目标ID为可展示信息（用于回显/失效提示）
// GET /api/structure/resolve?ids=1,2,3
// 【2.2 resolve 回显查库】优先从 structure_campaigns / structure_adsets / structure_ads 三表查，DB miss 返回 missing，不穿透 FB
// 注意：静态路由必须放在动态路由 /:level 前面，否则会被 /:level 捕获
app.get('/api/structure/resolve', requireAuth, requireActive, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').trim()
    if (!ids) return res.json({ items: [] })

    const idList = ids.split(',').map(s => s.trim()).filter(Boolean)
    const items = await resolveStructureByIds(idList)
    res.json({ items })
  } catch (e) {
    logger.error('解析对象ID失败:', e)
    res.status(500).json({ error: e.message })
  }
})

// 强制同步该账户广告结构到 structure_ads（顺序2 阶段 2.4）
// POST /api/sync/structure  body: { account_id: "act_xxx" } 或 query: account_id=act_xxx
app.post('/api/sync/structure', requireAuth, requireActive, async (req, res) => {
  try {
    const accountId = (req.body?.account_id || req.query?.account_id || '').trim()
    if (!accountId) return res.status(400).json({ error: '缺少 account_id（body 或 query）' })
    if (!(await assertAccountAccess(req, res, accountId))) return

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) return res.status(401).json({ error: 'Facebook访问令牌未配置' })

    const api = new FacebookMarketingAPI(token)
    const result = await syncAccountStructureAds(accountId, api)

    if (result.ok) {
      return res.json({
        ok: true,
        account_id: accountId,
        synced_count: result.synced_count,
        synced_campaigns: result.synced_campaigns,
        synced_adsets: result.synced_adsets,
        duration_ms: result.duration_ms
      })
    }
    if (result.reason === 'cooldown') {
      return res.status(429).json({
        ok: false,
        reason: 'cooldown',
        retry_after_sec: result.retry_after_sec
      })
    }
    if (result.reason === 'quota_high') {
      return res.status(429).json({
        ok: false,
        reason: 'quota_high',
        retry_after_sec: result.retry_after_sec
      })
    }
    if (result.reason === 'lock_busy') {
      return res.status(409).json({ ok: false, reason: 'lock_busy' })
    }
    return res.status(500).json({ ok: false, error: 'unknown' })
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e)
    // FB 常见“用户级限流”会以 400 返回：User request limit reached
    if (/user request limit reached/i.test(msg) || /rate limit/i.test(msg) || /rate limiting/i.test(msg)) {
      logger.warn(`同步结构触发 FB 限流: ${msg}`)
      return res.status(429).json({
        ok: false,
        reason: 'fb_rate_limited',
        retry_after_sec: 3600,
        error: msg
      })
    }
    logger.error('同步结构失败:', e)
    res.status(500).json({ error: msg })
  }
})

// 统一结构入口（方案 B：服务层聚合）— 须在 :level 之前注册，否则 /structure/objects 会被 :level 匹配成 level=objects 导致 400
// GET /api/structure/objects?account_id=act_xxx&type=campaign|adset|ad&q=&limit=&after=&include_paused=
app.get('/api/structure/objects', requireAuth, requireActive, async (req, res) => {
  try {
    const account_id = (req.query.account_id || '').trim()
    const type = (req.query.type || '').toLowerCase()
    const after = req.query.after != null ? String(req.query.after) : null
    const q = req.query.q != null ? String(req.query.q) : ''
    const rawLimit = Number(req.query.limit || 50)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
    const include_paused = req.query.include_paused
    const scope_status = req.query.scope_status != null ? String(req.query.scope_status) : undefined
    const scope_status_exclude = req.query.scope_status_exclude != null ? String(req.query.scope_status_exclude) : undefined
    const name_exclude = req.query.name_exclude != null ? String(req.query.name_exclude) : undefined
    const scopeCreatedWithinHoursRaw = req.query.scope_created_within_hours
    const scopeCreatedWithinHours = scopeCreatedWithinHoursRaw != null ? parseInt(scopeCreatedWithinHoursRaw, 10) : undefined
    const scope_created_within_hours = Number.isFinite(scopeCreatedWithinHours) && scopeCreatedWithinHours > 0 ? scopeCreatedWithinHours : undefined

    if (!account_id) return res.status(400).json({ error: '缺少 account_id 参数' })
    if (!['campaign', 'adset', 'ad'].includes(type)) return res.status(400).json({ error: 'type 只允许 campaign | adset | ad' })
    if (!(await assertAccountAccess(req, res, account_id))) return

    const result = await listStructureObjectsFromDb(account_id, { type, q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours })
    const sourceTable = result._source || (type === 'campaign' ? 'structure_campaigns' : type === 'adset' ? 'structure_adsets' : 'structure_ads')
    logger.info('[2.2] GET /api/structure/objects', { account_id, type, count: result.items.length, has_next: !!result.paging?.after })
    return res.json({
      items: result.items,
      paging: result.paging ? { after: result.paging.after } : {},
      meta: { type, limit, q: q ? String(q).trim() : null, source: sourceTable }
    })
  } catch (e) {
    logger.error('统一结构列表失败:', e)
    res.status(500).json({ error: e.message })
  }
})

// 多账户结构列表（规则页多选账户用）— 须在 :level 之前注册
// GET /api/structure/objects/multi?account_ids=act_1,act_2&type=ad|adset|campaign&q=&limit=50&after=&include_paused=
// after 为 base64(JSON.stringify({ i, a, pas }))：i=当前账户下标，a=该账户游标，pas=首轮每账户 after 列表
app.get('/api/structure/objects/multi', requireAuth, requireActive, async (req, res) => {
  try {
    const accountIdsRaw = (req.query.account_ids || '').trim()
    const type = (req.query.type || '').toLowerCase()
    const q = req.query.q != null ? String(req.query.q) : ''
    const rawLimit = Number(req.query.limit || 50)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
    const include_paused = req.query.include_paused
    // 兼容各客户端：Query 里可能是 "1" | 1 | "true" | true，未传时为 undefined
    const includePausedEffective = include_paused === '1' || include_paused === 1 || include_paused === 'true' || include_paused === true
    if (req.query.include_paused != null && !includePausedEffective && String(include_paused).trim() !== '') {
      logger.warn('[multi] include_paused 收到非常规值，将按「不含已暂停」处理', { received: req.query.include_paused })
    }
    const afterRaw = req.query.after != null && req.query.after !== '' ? String(req.query.after).trim() : null
    const scope_status = req.query.scope_status != null ? String(req.query.scope_status) : undefined
    const scope_status_exclude = req.query.scope_status_exclude != null ? String(req.query.scope_status_exclude) : undefined
    const name_exclude = req.query.name_exclude != null ? String(req.query.name_exclude) : undefined
    const scopeCreatedWithinHoursRaw = req.query.scope_created_within_hours
    const scopeCreatedWithinHours = scopeCreatedWithinHoursRaw != null ? parseInt(scopeCreatedWithinHoursRaw, 10) : undefined
    const scope_created_within_hours = Number.isFinite(scopeCreatedWithinHours) && scopeCreatedWithinHours > 0 ? scopeCreatedWithinHours : undefined

    if (!accountIdsRaw) return res.status(400).json({ error: '缺少 account_ids 参数' })
    if (!['campaign', 'adset', 'ad'].includes(type)) return res.status(400).json({ error: 'type 只允许 campaign | adset | ad' })

    logger.info('[multi] 请求参数', { include_paused: req.query.include_paused, includePausedEffective, type, limit })

    const requestedIds = [...new Set(accountIdsRaw.split(',').map(s => s.trim()).filter(Boolean))]
    if (requestedIds.length === 0) return res.status(400).json({ error: 'account_ids 至少包含一个有效账户 ID' })

    const allowedIds = []
    for (const id of requestedIds) {
      if (await hasAccountAccess(req, id)) allowedIds.push(id)
    }
    if (allowedIds.length === 0) {
      return res.status(403).json({ error: '无权访问所请求的任一广告账户', code: 'ACCOUNT_FORBIDDEN' })
    }

    const MULTI_ACCOUNT_IDS_MAX = 20
    const MULTI_ACCOUNT_IDS_MAX_ADMIN = 50
    const isAdmin = req.user && isAdminLikeRole(req.user.role)
    const maxAccounts = isAdmin ? MULTI_ACCOUNT_IDS_MAX_ADMIN : MULTI_ACCOUNT_IDS_MAX
    if (allowedIds.length > maxAccounts) {
      return res.status(400).json({
        error: `单次请求最多选择 ${maxAccounts} 个广告账户`,
        code: 'TOO_MANY_ACCOUNTS'
      })
    }

    const sourceTable = type === 'campaign' ? 'structure_campaigns' : type === 'adset' ? 'structure_adsets' : 'structure_ads'

    if (afterRaw) {
      let cursor
      try {
        cursor = JSON.parse(Buffer.from(afterRaw, 'base64').toString('utf8'))
        if (cursor == null || typeof cursor.i !== 'number' || !Array.isArray(cursor.pas)) {
          return res.status(400).json({ error: 'after 游标无效' })
        }
      } catch {
        return res.status(400).json({ error: 'after 游标无效' })
      }
      const { i, a, pas } = cursor
      if (i < 0 || i >= allowedIds.length) {
        return res.status(400).json({ error: 'after 游标无效' })
      }
      const accountId = allowedIds[i]
      const result = await listStructureObjectsFromDb(accountId, { type, q, limit, after: a || null, include_paused: includePausedEffective, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours })
      const items = result.items.map((item) => ({ ...item, account_id: item.account_id || accountId }))
      const hasNext = result.paging && result.paging.after != null
      const nextPas = [...(pas || [])]
      if (i < nextPas.length) nextPas[i] = result.paging?.after ?? null
      let nextAfter
      if (hasNext) {
        nextAfter = Buffer.from(JSON.stringify({ i, a: result.paging.after, pas: nextPas })).toString('base64')
      } else if (i + 1 < allowedIds.length) {
        // 只对「还有下一页」的账户返回游标，跳过 pas[j]==null 的账户，避免用 after=null 再拉第一页导致重复
        let nextI = -1
        for (let j = i + 1; j < nextPas.length; j++) {
          if (nextPas[j] != null) {
            nextI = j
            break
          }
        }
        if (nextI >= 0) {
          nextAfter = Buffer.from(JSON.stringify({ i: nextI, a: nextPas[nextI], pas: nextPas })).toString('base64')
        } else {
          nextAfter = undefined
        }
      } else {
        nextAfter = undefined
      }
      const hasMore = nextAfter != null
      logger.info('[2.2] GET /api/structure/objects/multi (after)', { allowed: allowedIds.length, type, accountIndex: i, count: items.length, has_more: hasMore })
      const perAccountAfterMeta = {}
      allowedIds.forEach((aid, idx) => { perAccountAfterMeta[aid] = nextPas[idx] ?? null })
      return res.json({
        items,
        paging: { after: nextAfter, has_more: hasMore },
        meta: {
          type,
          source: sourceTable,
          accounts: allowedIds.length,
          requested_accounts: requestedIds.length,
          allowed_accounts: allowedIds.length,
          denied_accounts: Math.max(0, requestedIds.length - allowedIds.length),
          per_account_after: perAccountAfterMeta,
          has_more: hasMore
        }
      })
    }

    const perAccountLimit = Math.max(1, Math.ceil(limit / allowedIds.length))
    const allItems = []
    const seen = new Set()
    const perAccountAfter = []
    const pl = pLimit(4)
    const results = await Promise.all(allowedIds.map((accountId, idx) =>
      pl(() =>
        listStructureObjectsFromDb(accountId, {
          type,
          q,
          limit: perAccountLimit,
          after: null,
          include_paused: includePausedEffective,
          scope_status,
          scope_status_exclude,
          name_exclude,
          scope_created_within_hours
        }).then(result => ({ idx, accountId, result }))
      )
    ))
    for (const { accountId, result } of results) {
      perAccountAfter.push(result.paging?.after ?? null)
      for (const item of result.items) {
        const key = `${item.account_id || accountId}:${item.id}`
        if (seen.has(key)) continue
        seen.add(key)
        allItems.push({ ...item, account_id: item.account_id || accountId })
      }
    }
    const items = allItems.slice(0, limit)
    const hasAnyMore = perAccountAfter.some((a) => a != null)
    const hasMore = hasAnyMore
    let nextAfter
    if (hasMore) {
      const firstI = perAccountAfter.findIndex((a) => a != null)
      if (firstI >= 0) {
        nextAfter = Buffer.from(JSON.stringify({ i: firstI, a: perAccountAfter[firstI], pas: perAccountAfter })).toString('base64')
      }
    }
    const perAccountAfterMeta = {}
    allowedIds.forEach((aid, idx) => { perAccountAfterMeta[aid] = perAccountAfter[idx] ?? null })
    logger.info('[2.2] GET /api/structure/objects/multi', { requested: requestedIds.length, allowed: allowedIds.length, type, count: items.length, has_more: hasMore })
    return res.json({
      items,
      paging: { after: nextAfter, has_more: hasMore },
      meta: {
        type,
        source: sourceTable,
        accounts: allowedIds.length,
        requested_accounts: requestedIds.length,
        allowed_accounts: allowedIds.length,
        denied_accounts: Math.max(0, requestedIds.length - allowedIds.length),
        per_account_limit: perAccountLimit,
        per_account_after: perAccountAfterMeta,
        has_more: hasMore
      }
    })
  } catch (e) {
    logger.error('多账户结构列表失败:', e)
    res.status(500).json({ error: e.message })
  }
})

// 结构化对象列表（替代 /api/insights 用于"选择列表"）
// GET /api/structure/:level?account_id=act_xxx&limit=50&after=...&q=keyword&include_paused=1
// level: campaigns | adsets | ads
// 【2.2】三层均查库，0 FB 列表调用
app.get('/api/structure/:level', requireAuth, requireActive, async (req, res) => {
  try {
    const { level } = req.params
    const account_id = (req.query.account_id || '').trim()
    const after = req.query.after != null ? String(req.query.after) : null
    const q = req.query.q != null ? String(req.query.q) : ''
    const rawLimit = Number(req.query.limit || 50)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 50
    if (!account_id) return res.status(400).json({ error: '缺少 account_id 参数' })
    if (!(await assertAccountAccess(req, res, account_id))) return

    const include_paused = req.query.include_paused
    const scope_status = req.query.scope_status != null ? String(req.query.scope_status) : undefined
    const scope_status_exclude = req.query.scope_status_exclude != null ? String(req.query.scope_status_exclude) : undefined
    const name_exclude = req.query.name_exclude != null ? String(req.query.name_exclude) : undefined
    const scopeCreatedWithinHoursRaw = req.query.scope_created_within_hours
    const scopeCreatedWithinHours = scopeCreatedWithinHoursRaw != null ? parseInt(scopeCreatedWithinHoursRaw, 10) : undefined
    const scope_created_within_hours = Number.isFinite(scopeCreatedWithinHours) && scopeCreatedWithinHours > 0 ? scopeCreatedWithinHours : undefined
    const opts = { q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours }

    const edgeMap = { campaigns: 'campaigns', adsets: 'adsets', ads: 'ads' }
    const edge = edgeMap[String(level || '').toLowerCase()]
    if (!edge) return res.status(400).json({ error: 'level 参数无效（campaigns/adsets/ads）' })

    if (edge === 'ads') {
      const result = await listStructureAdsFromDb(account_id, opts)
      logger.info('[2.2] GET /api/structure/ads from structure_ads only, no FB request', {
        account_id,
        q: q || null,
        limit,
        count: result.items.length,
        has_next: !!result.paging.after
      })
      return res.json({
        items: result.items,
        paging: result.paging,
        meta: { level: 'ads', limit, q: q ? String(q).trim() : null, source: 'structure_ads' }
      })
    }

    if (edge === 'campaigns') {
      const result = await listStructureCampaignsFromDb(account_id, opts)
      logger.info('[2.2] GET /api/structure/campaigns from structure_campaigns only, no FB request', {
        account_id,
        q: q || null,
        limit,
        count: result.items.length,
        has_next: !!result.paging.after
      })
      return res.json({
        items: result.items,
        paging: result.paging,
        meta: { level: 'campaigns', limit, q: q ? String(q).trim() : null, source: 'structure_campaigns' }
      })
    }

    if (edge === 'adsets') {
      const result = await listStructureAdsetsFromDb(account_id, opts)
      logger.info('[2.2] GET /api/structure/adsets from structure_adsets only, no FB request', {
        account_id,
        q: q || null,
        limit,
        count: result.items.length,
        has_next: !!result.paging.after
      })
      return res.json({
        items: result.items,
        paging: result.paging,
        meta: { level: 'adsets', limit, q: q ? String(q).trim() : null, source: 'structure_adsets' }
      })
    }
  } catch (e) {
    logger.error('获取结构化对象列表失败:', e)
    res.status(500).json({ error: e.message })
  }
})

// 获取广告列表 - 从数据库快照表读取（高性能，不消耗 API 配额）
// 【重要修改】：原来直接调用 Facebook API，现在改为从 ad_snapshots 表读取
// 好处：毫秒级响应、不触发限流、多人同时使用无压力
app.get('/api/ads', requireAuth, requireActive, async (req, res) => {
  const startTime = Date.now()
  try {
    const { account_id } = req.query
    if (!account_id) {
      return res.status(400).json({ error: '缺少account_id参数' })
    }
    if (!(await assertAccountAccess(req, res, account_id))) return

    // 从 ad_snapshots 表读取广告列表（毫秒级响应）
    const [rows] = await pool.execute(`
      SELECT 
        ad_id as id,
        ad_name as name,
        status,
        status as effective_status,
        ad_set_id as adset_id,
        synced_at
      FROM ad_snapshots
      WHERE account_id = ?
      ORDER BY ad_name
    `, [account_id])

    // 转换为前端期望的格式
    const ads = rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      effective_status: row.effective_status,
      adset_id: row.adset_id
    }))

    const duration = Date.now() - startTime
    logger.info(`✅ /api/ads 从数据库读取 ${ads.length} 个广告 (耗时: ${duration}ms)`)

    res.json({ 
      ads, 
      meta: { 
        source: 'database',
        synced_at: rows[0]?.synced_at || null,
        count: ads.length,
        duration_ms: duration
      }
    })
  } catch (error) {
    logger.error('获取广告列表失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取广告洞察数据 - 从数据库快照表读取（高性能，不消耗 API 配额）
// 【重要修改】：原来直接调用 Facebook API，现在改为从数据库读取
// - today/默认：从 ad_snapshots 表读取
// - 历史日期范围：从 daily_stats 表聚合
app.get('/api/insights', requireAuth, requireActive, async (req, res) => {
  const startTime = Date.now()
  try {
    const { account_id, since, until, preset } = req.query
    if (!account_id) {
      return res.status(400).json({ error: '缺少account_id参数' })
    }
    if (!(await assertAccountAccess(req, res, account_id))) return

    // 解析时间范围；preset 需转成 since/until（用账户时区），否则 yesterday 等会误走 today
    const timezoneName = await getAccountTimezone(account_id)
    const presetVal = preset || 'today'
    const presetMap = { last_7d: 'last_7_days', last_30d: 'last_30_days' }
    const timeWindowForCalc = presetMap[presetVal] || presetVal

    let timeRange = {}
    if (since && until) {
      timeRange = { since, until }
    } else if (presetVal === 'today') {
      timeRange = { preset: 'today' }
    } else {
      // preset 非 today：用 calculateTimeWindow 算出 since/until（账户时区自然日）
      try {
        const { start, end } = calculateTimeWindow(
          presetVal === 'this_month' ? 'today' : timeWindowForCalc,
          timezoneName
        )
        if (presetVal === 'this_month') {
          const now = start  // start 已是 today 的 start
          const firstOfMonth = now.startOf('month')
          timeRange = { since: firstOfMonth.toFormat('yyyy-MM-dd'), until: now.toFormat('yyyy-MM-dd') }
        } else {
          timeRange = { since: start.toFormat('yyyy-MM-dd'), until: end.toFormat('yyyy-MM-dd') }
        }
      } catch (e) {
        return res.status(400).json({ error: `时间范围解析失败: ${e.message}` })
      }
    }

    const isToday = presetVal === 'today' || (timeRange.preset === 'today')
    const todayDateStr = isToday ? calculateTimeWindow('today', timezoneName).start.toFormat('yyyy-MM-dd') : null

    let insights = []
    let dataSource = 'ad_snapshots'

    if (isToday) {
      // 今日数据：从 ad_snapshots 表读取；按 data_date 过滤（避免多天快照混入）
      const [rows] = await pool.execute(`
        SELECT 
          ad_id,
          ad_name,
          spend,
          purchases,
          link_clicks,
          unique_link_clicks,
          purchase_value,
          add_to_cart_count,
          initiate_checkout_count,
          add_payment_info_count,
          actions,
          synced_at
        FROM ad_snapshots
        WHERE account_id = ? AND data_date = ?
      `, [account_id, todayDateStr])
      
      insights = rows.map(row => {
        const spend = parseFloat(row.spend || 0)
        const linkClicks = parseInt(row.link_clicks || 0)
        const uniqueLinkClicks = parseInt(row.unique_link_clicks || 0)
        const purchases = parseInt(row.purchases || 0)
        const purchaseValue = parseFloat(row.purchase_value || 0)
        const addToCart = parseInt(row.add_to_cart_count || 0)
        const initCheckout = parseInt(row.initiate_checkout_count || 0)
        const addPayment = parseInt(row.add_payment_info_count || 0)
        return {
          ad_id: row.ad_id,
          ad_name: row.ad_name,
          spend,
          cpc: linkClicks > 0 ? spend / linkClicks : 0,
          ucpc: uniqueLinkClicks > 0 ? spend / uniqueLinkClicks : 0,
          purchase_roas: spend > 0 ? purchaseValue / spend : 0,
          cpa: purchases > 0 ? spend / purchases : 0,
          purchases,
          inline_link_clicks: linkClicks,
          unique_link_clicks: uniqueLinkClicks,
          cp_atc: addToCart > 0 ? spend / addToCart : 0,
          cp_ic: initCheckout > 0 ? spend / initCheckout : 0,
          cp_api: addPayment > 0 ? spend / addPayment : 0,
          add_to_cart: addToCart,
          initiate_checkout: initCheckout,
          add_payment_info: addPayment,
          actions: row.actions
        }
      })
    } else {
      // 历史数据：从 daily_stats 表聚合；按 SUM 分子/分母 计算（避免 AVG 口径飘）
      dataSource = 'daily_stats'
      const [rows] = await pool.execute(`
        SELECT 
          ad_id,
          MAX(ad_name) as ad_name,
          SUM(spend) as spend,
          SUM(purchase_value) as purchase_value,
          SUM(purchases) as purchases,
          SUM(link_clicks) as link_clicks,
          SUM(unique_link_clicks) as unique_link_clicks,
          MAX(updated_at) as synced_at
        FROM daily_stats
        WHERE account_id = ?
          AND date BETWEEN ? AND ?
        GROUP BY ad_id
      `, [account_id, timeRange.since, timeRange.until])
      
      insights = rows.map(row => {
        const spend = parseFloat(row.spend || 0)
        const linkClicks = parseInt(row.link_clicks || 0)
        const uniqueLinkClicks = parseInt(row.unique_link_clicks || 0)
        const purchases = parseInt(row.purchases || 0)
        const purchaseValue = parseFloat(row.purchase_value || 0)
        return {
          ad_id: row.ad_id,
          ad_name: row.ad_name,
          spend,
          cpc: linkClicks > 0 ? spend / linkClicks : 0,
          ucpc: uniqueLinkClicks > 0 ? spend / uniqueLinkClicks : 0,
          purchase_roas: spend > 0 ? purchaseValue / spend : 0,
          cpa: purchases > 0 ? spend / purchases : 0,
          purchases,
          inline_link_clicks: linkClicks,
          unique_link_clicks: uniqueLinkClicks
        }
      })
    }

    const duration = Date.now() - startTime
    logger.info(`✅ /api/insights 从 ${dataSource} 读取 ${insights.length} 条数据 (耗时: ${duration}ms)`)

    res.json({ 
      insights, 
      meta: { 
        source: dataSource,
        timeRange: timeRange,
        count: insights.length,
        duration_ms: duration
      }
    })
  } catch (error) {
    logger.error('获取洞察数据失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// ROI 深度指标接口（购买/加购/结账/支付/独立点击）- 从数据库读取
// 【重要修改】：改为从 ad_snapshots / daily_stats 读取，不消耗 API 额度
// 好处：毫秒级响应、不触发限流、多人同时使用无压力
const ROI_JOB_TTL_MS = 5 * 60 * 1000
const roiJobCache = new Map() // key -> { createdAt, resultByAdId?, reportRunId? }

app.get('/api/roi', requireAuth, requireActive, async (req, res) => {
  const startTime = Date.now()
  try {
    const { account_id, preset, since, until, level } = req.query
    if (!account_id) return res.status(400).json({ error: '缺少 account_id 参数', code: 'MISSING_PARAM' })
    if (!(await assertAccountAccess(req, res, account_id))) return

    // 解析时间范围（与 /api/insights 一致，preset 转 since/until）
    const timezoneName = await getAccountTimezone(account_id)
    const presetVal = preset || 'today'
    const presetMap = { last_7d: 'last_7_days', last_30d: 'last_30_days' }
    const timeWindowForCalc = presetMap[presetVal] || presetVal

    let timeRange = {}
    if (since && until) {
      timeRange = { since, until }
    } else if (presetVal === 'today') {
      timeRange = { preset: 'today' }
    } else {
      try {
        const { start, end } = calculateTimeWindow(
          presetVal === 'this_month' ? 'today' : timeWindowForCalc,
          timezoneName
        )
        if (presetVal === 'this_month') {
          const now = start
          timeRange = { since: now.startOf('month').toFormat('yyyy-MM-dd'), until: now.toFormat('yyyy-MM-dd') }
        } else {
          timeRange = { since: start.toFormat('yyyy-MM-dd'), until: end.toFormat('yyyy-MM-dd') }
        }
      } catch (e) {
        return res.status(400).json({ error: `时间范围解析失败: ${e.message}` })
      }
    }

    const isToday = presetVal === 'today' || timeRange.preset === 'today'
    const todayDateStr = isToday ? calculateTimeWindow('today', timezoneName).start.toFormat('yyyy-MM-dd') : null

    const validLevels = ['ad', 'adset', 'campaign']
    const requestLevel = validLevels.includes(level) ? level : 'ad'
    let rows = []
    let dataSource = 'ad_snapshots'

    const computeMetrics = (r) => {
      const spend = parseFloat(r.spend || 0)
      const linkClicks = parseInt(r.link_clicks || r.inline_link_clicks || 0)
      const uniqueLinkClicks = parseInt(r.unique_link_clicks || r.unique_inline_link_clicks || 0)
      const purchases = parseInt(r.purchases || 0)
      const purchaseValue = parseFloat(r.purchase_value || 0)
      const addToCart = parseInt(r.add_to_cart_count || r.add_to_cart || 0)
      const initCheckout = parseInt(r.initiate_checkout_count || r.initiate_checkout || 0)
      const addPayment = parseInt(r.add_payment_info_count || r.add_payment_info || 0)
      return {
        ...r,
        cpa: purchases > 0 ? spend / purchases : 0,
        ucpc: uniqueLinkClicks > 0 ? spend / uniqueLinkClicks : 0,
        cp_atc: addToCart > 0 ? spend / addToCart : 0,
        cp_ic: initCheckout > 0 ? spend / initCheckout : 0,
        cp_api: addPayment > 0 ? spend / addPayment : 0,
        purchase_roas: spend > 0 ? purchaseValue / spend : 0,
        inline_link_clicks: linkClicks,
        unique_inline_link_clicks: uniqueLinkClicks,
        unique_link_clicks: uniqueLinkClicks,
        add_to_cart: addToCart,
        initiate_checkout: initCheckout,
        add_payment_info: addPayment
      }
    }

    if (isToday) {
      if (requestLevel === 'ad') {
        const [result] = await pool.execute(`
          SELECT ad_id, ad_name, ad_set_id as adset_id, spend, purchases,
            link_clicks, unique_link_clicks, purchase_value,
            add_to_cart_count, initiate_checkout_count, add_payment_info_count,
            synced_at
          FROM ad_snapshots
          WHERE account_id = ? AND data_date = ?
        `, [account_id, todayDateStr])
        rows = result.map(computeMetrics)
      } else {
        const groupField = requestLevel === 'adset' ? 'ad_set_id' : 'account_id'
        const idField = requestLevel === 'adset' ? 'adset_id' : 'campaign_id'
        const [result] = await pool.execute(`
          SELECT ${groupField} as ${idField},
            SUM(spend) as spend, SUM(purchases) as purchases,
            SUM(link_clicks) as link_clicks, SUM(unique_link_clicks) as unique_link_clicks,
            SUM(purchase_value) as purchase_value,
            SUM(add_to_cart_count) as add_to_cart_count,
            SUM(initiate_checkout_count) as initiate_checkout_count,
            SUM(add_payment_info_count) as add_payment_info_count,
            MAX(synced_at) as synced_at
          FROM ad_snapshots
          WHERE account_id = ? AND data_date = ?
          GROUP BY ${groupField}
        `, [account_id, todayDateStr])
        rows = result.map(computeMetrics)
      }
    } else {
      dataSource = 'daily_stats'
      if (requestLevel === 'ad') {
        const [result] = await pool.execute(`
          SELECT ad_id, MAX(ad_name) as ad_name, ad_set_id as adset_id,
            SUM(spend) as spend, SUM(purchases) as purchases,
            SUM(link_clicks) as link_clicks, SUM(unique_link_clicks) as unique_link_clicks,
            SUM(purchase_value) as purchase_value,
            SUM(add_to_cart_count) as add_to_cart_count,
            SUM(initiate_checkout_count) as initiate_checkout_count,
            SUM(add_payment_info_count) as add_payment_info_count,
            MAX(updated_at) as synced_at
          FROM daily_stats
          WHERE account_id = ? AND date BETWEEN ? AND ?
          GROUP BY ad_id, ad_set_id
        `, [account_id, timeRange.since, timeRange.until])
        rows = result.map(computeMetrics)
      } else {
        const groupField = requestLevel === 'adset' ? 'ad_set_id' : 'account_id'
        const idField = requestLevel === 'adset' ? 'adset_id' : 'campaign_id'
        const [result] = await pool.execute(`
          SELECT ${groupField} as ${idField},
            SUM(spend) as spend, SUM(purchases) as purchases,
            SUM(link_clicks) as link_clicks, SUM(unique_link_clicks) as unique_link_clicks,
            SUM(purchase_value) as purchase_value,
            SUM(add_to_cart_count) as add_to_cart_count,
            SUM(initiate_checkout_count) as initiate_checkout_count,
            SUM(add_payment_info_count) as add_payment_info_count,
            MAX(updated_at) as synced_at
          FROM daily_stats
          WHERE account_id = ? AND date BETWEEN ? AND ?
          GROUP BY ${groupField}
        `, [account_id, timeRange.since, timeRange.until])
        rows = result.map(computeMetrics)
      }
    }

    // 转换为前端期望的格式（roiByAdId）
    const roiById = {}
    const idKey = requestLevel === 'adset' ? 'adset_id' : (requestLevel === 'campaign' ? 'campaign_id' : 'ad_id')
    for (const r of rows) {
      const id = String(r[idKey] || '')
      if (id) roiById[id] = r
    }

    const duration = Date.now() - startTime
    logger.info(`✅ /api/roi 从 ${dataSource} 读取 ${rows.length} 条数据 (耗时: ${duration}ms)`)

    return res.json({ 
      roiByAdId: roiById, 
      mode: 'database',
      meta: {
        source: dataSource,
        level: requestLevel,
        count: rows.length,
        duration_ms: duration
      }
    })
  } catch (e) {
    logger.error('获取 ROI 数据失败:', e)
    res.status(500).json({ error: e.message, code: 'ROI_ERROR' })
  }
})

// /api/roi/result - 【已废弃】
// 原因：/api/roi 已改为从数据库读取，不再使用异步报告模式
// 保留此接口仅为兼容性
app.get('/api/roi/result', requireAuth, requireActive, async (req, res) => {
  logger.warn('⚠️ 废弃接口被调用: GET /api/roi/result')
  logger.warn('   /api/roi 已改为从数据库读取，不再需要异步轮询')
  
  return res.status(410).json({ 
    error: '此接口已废弃，/api/roi 已改为从数据库直接读取数据',
    code: 'DEPRECATED_ENDPOINT',
    migration: {
      reason: '/api/roi 现在从数据库读取数据，响应时间为毫秒级，不再需要异步轮询',
      new_behavior: '直接调用 /api/roi 即可获取数据，无需等待 report_run_id'
    }
  })
})

// 优先级2任务：查询离线数据（从数据库查询，返回 meta 字段）
// GET /api/rule-data?account_id=act_xxx&ad_ids=ad1,ad2&time_window=today&custom_range={"since":"2026-01-14","until":"2026-01-20"}
app.get('/api/rule-data', requireAuth, requireActive, async (req, res) => {
  try {
    const { account_id, ad_ids, time_window, custom_range } = req.query
    
    if (!account_id) {
      return res.status(400).json({ error: '缺少 account_id 参数' })
    }
    if (!(await assertAccountAccess(req, res, account_id))) return
    
    // 解析 ad_ids（支持逗号分隔的字符串或单个字符串）
    let adIds = null
    if (ad_ids) {
      if (typeof ad_ids === 'string' && ad_ids.includes(',')) {
        adIds = ad_ids.split(',').map(id => id.trim()).filter(Boolean)
      } else {
        adIds = ad_ids
      }
    }
    
    // 解析 time_window（默认 'today'）
    const timeWindow = time_window || 'today'
    
    // 解析 custom_range（如果提供）
    let customRange = null
    if (custom_range) {
      try {
        customRange = typeof custom_range === 'string' ? JSON.parse(custom_range) : custom_range
      } catch (error) {
        return res.status(400).json({ error: 'custom_range 格式无效，必须是有效的 JSON 对象' })
      }
    }
    
    // 获取账户时区（自动从数据库获取）
    const accountTimezone = await getAccountTimezone(account_id)
    
    // 数据时区优先（混合方案C）：如果是 today 查询，优先使用快照时区
    let dataTimezoneUsed = accountTimezone
    if (timeWindow === 'today' && adIds) {
      const { getDataTimezone } = await import('./services/ruleDataService.js')
      try {
        dataTimezoneUsed = await getDataTimezone(account_id, adIds, accountTimezone)
      } catch (error) {
        logger.warn(`⚠️  获取数据时区失败，使用账户时区 ${accountTimezone}:`, error.message)
        dataTimezoneUsed = accountTimezone
      }
    }
    
    // 计算时间窗口（用于生成 meta 字段）
    const { calculateTimeWindow } = await import('./utils/timeWindow.js')
    const timeWindowResult = calculateTimeWindow(timeWindow, dataTimezoneUsed, customRange)
    
    // 查询数据
    // 阶段A修复：queryRuleData 现在返回 { data, warnings }，需要解构
    const result = await queryRuleData(account_id, adIds, timeWindow, null, customRange)
    const data = result.data || result  // 兼容旧格式（如果返回的是数组）
    const serviceWarnings = result.warnings || []  // 从 queryRuleData 获取 warnings
    
    // 构建 meta 字段
    // 合并 timeWindowResult.warnings 和 serviceWarnings（降级策略产生的 warnings）
    const allWarnings = [...(timeWindowResult.warnings || []), ...serviceWarnings]
    
    const meta = {
      account_timezone: accountTimezone,
      display_timezone: dataTimezoneUsed,
      data_timezone_used: dataTimezoneUsed,
      range: {
        start: {
          local: timeWindowResult.start.toFormat('yyyy-MM-dd HH:mm:ss'),
          utc: timeWindowResult.start.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
          iso: timeWindowResult.start.toISO()
        },
        end: {
          local: timeWindowResult.end.toFormat('yyyy-MM-dd HH:mm:ss'),
          utc: timeWindowResult.end.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
          iso: timeWindowResult.end.toISO()
        },
        days: Math.ceil(timeWindowResult.end.diff(timeWindowResult.start, 'days').days)
      },
      warnings: allWarnings
    }
    
    res.json({ data, meta })
  } catch (error) {
    logger.error('查询规则数据失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// 执行自动规则 - 【已废弃】
// 「立即运行所有规则」已移除，规则由每分钟 Cron 自动执行（文档：执行频率与执行时间 — 适配方案 §7）
// 单条规则请使用 POST /api/rules/:id/execute
app.post('/api/execute-rules', async (req, res) => {
  logger.warn('⚠️ 废弃接口被调用: POST /api/execute-rules')
  return res.status(410).json({
    error: '此接口已废弃；规则由每分钟 Cron 自动执行，单条规则请使用 POST /api/rules/:id/execute',
    code: 'DEPRECATED_ENDPOINT',
    new_endpoint: 'POST /api/rules/:id/execute'
  })
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '服务器运行正常',
    timestamp: new Date().toISOString(),
    token_configured: !!process.env.FACEBOOK_ACCESS_TOKEN
  })
})

// 诊断端点 - 测试Token和API连接
// 代理连接测试端点
app.get('/api/test-proxy', async (req, res) => {
  try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    
    if (!proxyUrl) {
      return res.json({ 
        success: false, 
        message: '未配置代理',
        proxy: null
      })
    }
    
    // 使用统一解析工具（与 makeRequest / socks5 一致）
    const info = parseProxyUrl(proxyUrl)
    if (!info) {
      return res.json({ success: false, message: '代理解析失败，跳过代理', proxy: null })
    }
    const proxyHost = info.host
    const proxyPort = info.port
    const scheme = info.scheme
    const raw = info.raw
    // socks5Url 仅在 SOCKS 代理时返回，HTTP 代理不伪装
    const socks5Url = isSocksProxy(proxyUrl) ? raw : null
    const proxyPayload = { scheme, raw, host: proxyHost, port: proxyPort }
    if (socks5Url != null) proxyPayload.socks5Url = socks5Url
    
    // 测试TCP连接
    return new Promise((resolve) => {
      const socket = net.createConnection(proxyPort, proxyHost, () => {
        logger.info(`✅ 成功连接到代理服务器 ${proxyHost}:${proxyPort}`)
        socket.destroy()
        resolve(res.json({
          success: true,
          message: '代理服务器连接成功',
          proxy: proxyPayload
        }))
      })
      
      socket.on('error', (error) => {
        logger.error(`❌ 代理服务器连接失败: ${error.message}`)
        resolve(res.json({
          success: false,
          message: `代理服务器连接失败: ${error.message}`,
          error: error.code,
          proxy: proxyPayload
        }))
      })
      
      socket.setTimeout(5000, () => {
        socket.destroy()
        resolve(res.json({
          success: false,
          message: '代理服务器连接超时（5秒）',
          proxy: proxyPayload
        }))
      })
    })
  } catch (error) {
    res.json({
      success: false,
      message: error.message,
      error: error.stack
    })
  }
})

app.get('/api/debug', async (req, res) => {
  try {
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    const debugInfo = {
      server: {
        status: 'running',
        port: Number(process.env.PORT || 3001),
        timestamp: new Date().toISOString()
      },
      token: {
        configured: !!token
      },
      test: null
    }

    if (token) {
      try {
        // 测试Token是否有效（复用 makeRequest，支持 SOCKS 代理，避免 protocol mismatch）
        const api = new FacebookMarketingAPI(token)
        const testUrl = `${FACEBOOK_API_BASE}/me`
        const data = await api.makeRequest(testUrl, { access_token: token }, 'GET', null, { timeout: 30000 })
        
        if (data.error) {
          debugInfo.test = {
            success: false,
            error: data.error
          }
        } else {
          debugInfo.test = {
            success: true,
            user_id: data.id,
            name: data.name
          }
        }
      } catch (error) {
        debugInfo.test = {
          success: false,
          error: error.message
        }
      }
    }

    res.json(debugInfo)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

} // 结束 if (app) 条件块

// 注意：服务器启动逻辑已移到 server.js
// 这个文件现在只包含业务逻辑类（FacebookMarketingAPI, RuleEngine）和 API 路由

// 导出类，供其他模块使用（如 cronService.js）
export { FacebookMarketingAPI, RuleEngine }

