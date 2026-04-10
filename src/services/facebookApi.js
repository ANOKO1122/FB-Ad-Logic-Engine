import axios from 'axios'
import { getStoredToken } from '../utils/authFetch.js'

// 默认 /api 走 Vite 代理到本机后端；勿在 .env.local 中把 VITE_API_URL 指到线上，否则会串云
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 90000,
  withCredentials: true
})

apiClient.interceptors.request.use((config) => {
  const token = getStoredToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

class FacebookMarketingService {
  async getAdAccounts() {
    const resp = await apiClient.get('/accounts')
    return resp.data.accounts || []
  }

  async getStructureObjects(level, accountId, { q = '', limit = 50, after = null, include_paused = false, scope_status = null, scope_status_exclude = null, name_exclude = null, scope_created_within_hours = null } = {}) {
    const resp = await apiClient.get(`/structure/${level}`, {
      params: {
        account_id: accountId,
        q: q || undefined,
        limit,
        after: after || undefined,
        include_paused: include_paused ? 1 : undefined,
        scope_status: scope_status || undefined,
        scope_status_exclude: scope_status_exclude || undefined,
        name_exclude: name_exclude || undefined,
        scope_created_within_hours: scope_created_within_hours != null && Number.isFinite(scope_created_within_hours) && scope_created_within_hours > 0 ? scope_created_within_hours : undefined
      }
    })
    return resp.data || { items: [], paging: null }
  }

  /**
   * 统一结构列表（方案 B）：请求 /api/structure/objects，type=campaign|adset|ad，返回统一字段 id/type/name/campaign_id/adset_id/effective_status/account_id
   */
  async getStructureObjectsUnified(type, accountId, { q = '', limit = 50, after = null, include_paused = false, scope_status = null, scope_status_exclude = null, name_exclude = null, scope_created_within_hours = null } = {}) {
    const resp = await apiClient.get('/structure/objects', {
      params: {
        account_id: accountId,
        type,
        q: q || undefined,
        limit,
        after: after || undefined,
        include_paused: include_paused ? 1 : undefined,
        scope_status: scope_status || undefined,
        scope_status_exclude: scope_status_exclude || undefined,
        name_exclude: name_exclude || undefined,
        scope_created_within_hours: scope_created_within_hours != null && Number.isFinite(scope_created_within_hours) && scope_created_within_hours > 0 ? scope_created_within_hours : undefined
      }
    })
    return resp.data || { items: [], paging: {} }
  }

  /**
   * 多账户结构列表（规则页多选账户）：请求 /api/structure/objects/multi，合并多个账户的对象列表
   * @param {string} type - campaign | adset | ad
   * @param {string[]} accountIds - 账户 ID 数组（有权限的）
   * @param {Object} opts - q, limit, after, include_paused, scope_status, scope_status_exclude, name_exclude, scope_created_within_hours
   * @returns {Promise<{ items, paging, meta }>} 每条 item 含 account_id
   */
  async getStructureObjectsMulti(type, accountIds, { q = '', limit = 50, after = null, include_paused = false, scope_status = null, scope_status_exclude = null, name_exclude = null, scope_created_within_hours = null } = {}) {
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return { items: [], paging: {}, meta: {} }
    }
    const resp = await apiClient.get('/structure/objects/multi', {
      params: {
        account_ids: accountIds.join(','),
        type,
        q: q || undefined,
        limit,
        after: after || undefined,
        include_paused: include_paused ? 1 : undefined,
        scope_status: scope_status || undefined,
        scope_status_exclude: scope_status_exclude || undefined,
        name_exclude: name_exclude || undefined,
        scope_created_within_hours: scope_created_within_hours != null && Number.isFinite(scope_created_within_hours) && scope_created_within_hours > 0 ? scope_created_within_hours : undefined
      }
    })
    return resp.data || { items: [], paging: {}, meta: {} }
  }

  async resolveObjectsByIds(ids) {
    const resp = await apiClient.get('/structure/resolve', {
      params: { ids: Array.isArray(ids) ? ids.join(',') : ids }
    })
    return resp.data.items || []
  }

  /**
   * 强制同步该账户广告结构到 structure_ads（顺序2 2.4）
   * 成功后本地 structure_ads 更新，选择器列表可刷新到最新
   * @param {string} accountId - act_xxx
   * @returns {Promise<{ ok, account_id, synced_count?, duration_ms? }>}
   * @throws 429 冷却中 / 409 锁占用 / 500 其他错误
   */
  async syncStructure(accountId) {
    const resp = await apiClient.post('/sync/structure', { account_id: accountId })
    return resp.data
  }

  async getAds(accountId) {
    const resp = await apiClient.get('/ads', { params: { account_id: accountId } })
    return resp.data.ads || []
  }

  async getAdInsights(accountId, timeRange = null, options = {}) {
    const params = { account_id: accountId }
    if (timeRange?.preset) params.preset = timeRange.preset
    if (timeRange?.since && timeRange?.until) { params.since = timeRange.since; params.until = timeRange.until }

    // 层级参数：ad / adset / campaign
    if (options?.level) params.level = options.level

    // 对齐 Ads Manager
    if (options?.alignAdsManager) params.use_account_attribution_setting = true
    if (options?.actionAttributionWindows) params.action_attribution_windows = options.actionAttributionWindows

    const resp = await apiClient.get('/insights', { params })
    return resp.data.insights || []
  }

  async getRoiMetrics(accountId, timeRange = null, options = {}) {
    const params = { account_id: accountId }
    if (timeRange?.preset) params.preset = timeRange.preset
    if (timeRange?.since && timeRange?.until) { params.since = timeRange.since; params.until = timeRange.until }

    // 层级参数：ad / adset / campaign
    if (options?.level) params.level = options.level

    if (options?.force) params.force = 1
    if (options?.alignAdsManager) params.use_account_attribution_setting = true
    if (options?.actionAttributionWindows) params.action_attribution_windows = options.actionAttributionWindows

    const resp = await apiClient.get('/roi', { params })
    return resp.data || {}
  }

  async getRoiMetricsResult(reportRunId, level = 'ad') {
    const resp = await apiClient.get('/roi/result', { params: { report_run_id: reportRunId, level } })
    return resp.data || {}
  }

  async executeRules(accountId, rules) {
    const resp = await apiClient.post('/execute-rules', { account_id: accountId, rules })
    return resp.data || {}
  }

  /**
   * 单条规则手动执行（仅执行这一条规则）
   * @param {number} ruleId - 规则 ID
   * @returns {Promise<{ success, message, rule_id, account_id, matched_count, executed_count, failed_count, status, run_id }>}
   */
  async executeRuleById(ruleId) {
    const resp = await apiClient.post(`/rules/${ruleId}/execute`)
    return resp.data || {}
  }

  async refreshDynamicScopeByAccount({ accountId, ruleId } = {}) {
    const payload = {}
    if (accountId) payload.accountId = accountId
    if (ruleId != null) payload.ruleId = ruleId
    const resp = await apiClient.post('/rules/dynamic-scope/refresh-account', payload)
    return resp.data || {}
  }

  /**
   * 预览动态范围全量 ID（与规则执行共用后端逻辑，消除 91 vs 101）
   * @param {Object} params - account_ids, target_level, scope_filters, exclude_ids, max_dynamic_matches
   * @returns {Promise<{ object_ids: string[], count: number, per_account?: Object }>}
   */
  async previewDynamicScope({ account_ids, target_level, scope_filters, exclude_ids, max_dynamic_matches }) {
    const resp = await apiClient.post('/rules/preview-dynamic-scope', {
      account_ids,
      target_level: target_level || 'ad',
      scope_filters,
      exclude_ids: exclude_ids || null,
      max_dynamic_matches
    })
    return resp.data || { object_ids: [], count: 0 }
  }
}

export default new FacebookMarketingService()


