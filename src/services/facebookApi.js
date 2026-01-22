import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 90000,
  withCredentials: true
})

class FacebookMarketingService {
  async getAdAccounts() {
    const resp = await apiClient.get('/accounts')
    return resp.data.accounts || []
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
}

export default new FacebookMarketingService()


