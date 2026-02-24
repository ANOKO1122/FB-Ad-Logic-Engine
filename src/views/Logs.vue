<template>
  <div class="logs-page">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>执行日志</h2>
      <button class="btn secondary" @click="loadLogs" :disabled="loading">
        {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-value">{{ stats.today?.total || 0 }}</div>
        <div class="stat-label">今日执行</div>
      </div>
      <div class="stat-card success">
        <div class="stat-value">{{ stats.today?.success_count || 0 }}</div>
        <div class="stat-label">成功</div>
      </div>
      <div class="stat-card danger">
        <div class="stat-value">{{ stats.today?.fail_count || 0 }}</div>
        <div class="stat-label">失败</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-value">{{ stats.today?.skipped_count || 0 }}</div>
        <div class="stat-label">跳过</div>
      </div>
    </div>

    <!-- 筛选器 -->
    <div class="card filter-panel">
      <div class="filter-row">
        <div class="filter-item">
          <label>账户</label>
          <select v-model="filters.account_id" @change="resetAndLoad" class="select">
            <option value="">全部账户</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">
              {{ a.name || a.id }}
            </option>
          </select>
        </div>
        <div class="filter-item">
          <label>规则</label>
          <select v-model="filters.rule_id" @change="resetAndLoad" class="select">
            <option value="">全部规则</option>
            <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </div>
        <div class="filter-item">
          <label>状态</label>
          <select v-model="filters.status" @change="resetAndLoad" class="select">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="fail">失败</option>
            <option value="skipped">跳过</option>
          </select>
        </div>
        <div class="filter-item">
          <label>开始日期</label>
          <input type="date" v-model="filters.start_date" @change="resetAndLoad" class="input-date" />
        </div>
        <div class="filter-item">
          <label>结束日期</label>
          <input type="date" v-model="filters.end_date" @change="resetAndLoad" class="input-date" />
        </div>
        <div class="filter-item">
          <button class="btn-text" @click="clearFilters">清除筛选</button>
        </div>
      </div>
    </div>

    <!-- 日志列表 -->
    <div class="card table-card">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <p>正在加载日志...</p>
      </div>

      <div v-else-if="logs.length === 0" class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>暂无执行日志</h3>
        <p>当规则被触发执行后，日志会显示在这里</p>
      </div>

      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th class="col-time">执行时间</th>
              <th class="col-rule">规则名称</th>
              <th class="col-ad">广告名称</th>
              <th class="col-action">执行动作</th>
              <th class="col-status">状态</th>
              <th class="col-mode">模式</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id" :class="{ 'row-error': log.status === 'fail' }">
              <td class="col-time">
                <!-- 主显示：统一北京时区（UTC+8） -->
                <div class="time-primary">
                  <span class="account-time">{{ formatAccountTime(log.triggered_at) }}</span>
                  <span class="tz-label">北京</span>
                </div>
                <div class="date-text">{{ formatAccountDate(log.triggered_at) }}</div>
              </td>
              <td class="col-rule">
                <div class="rule-name">{{ log.rule_name || '-' }}</div>
                <div class="account-text">{{ log.account_name || log.account_id }}</div>
              </td>
              <td class="col-ad" :title="log.ad_name">
                <div class="ad-name">{{ log.ad_name || '-' }}</div>
                <div class="ad-id">{{ log.ad_id }}</div>
              </td>
              <td class="col-action">
                <span class="action-badge" :class="getActionClass(log.action_type)">
                  {{ getActionLabel(log.action_type) }}
                </span>
              </td>
              <td class="col-status">
                <span class="status-badge" :class="log.status">
                  {{ getStatusLabel(log.status) }}
                </span>
              </td>
              <td class="col-mode">
                <span v-if="log.is_simulation" class="mode-badge simulation">🧪 模拟</span>
                <span v-else class="mode-badge real">⚡ 真实</span>
              </td>
              <td class="col-ops">
                <button class="btn-text" @click="openDetail(log)">详情</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div v-if="pagination.totalPages > 1" class="pagination">
        <button 
          class="btn-page" 
          :disabled="pagination.page <= 1"
          @click="goToPage(pagination.page - 1)"
        >
          上一页
        </button>
        <span class="page-info">
          第 {{ pagination.page }} / {{ pagination.totalPages }} 页
          （共 {{ pagination.total }} 条）
        </span>
        <button 
          class="btn-page" 
          :disabled="pagination.page >= pagination.totalPages"
          @click="goToPage(pagination.page + 1)"
        >
          下一页
        </button>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <div v-if="showDetail" class="modal-overlay" @click="showDetail = false">
      <div class="modal-content wide" @click.stop>
        <div class="modal-header">
          <h3>日志详情</h3>
          <button class="close-btn" @click="showDetail = false">×</button>
        </div>
        <div class="modal-body" v-if="detailLog">
          <!-- 基本信息 -->
          <div class="detail-section">
            <h4>基本信息</h4>
            <div class="detail-grid">
              <div class="detail-item">
                <label>执行时间</label>
                <div class="detail-time">
                  <span class="account-time">{{ formatDateTimeBeijingLocale(detailLog.triggered_at) }}</span>
                  <span class="tz-label">北京时区（UTC+8）</span>
                </div>
              </div>
              <div class="detail-item">
                <label>规则名称</label>
                <span>{{ detailLog.rule_name || '-' }}</span>
              </div>
              <div class="detail-item">
                <label>广告账户</label>
                <span>{{ detailLog.account_name || detailLog.account_id }}</span>
              </div>
              <div class="detail-item">
                <label>广告名称</label>
                <span>{{ detailLog.ad_name || '-' }}</span>
              </div>
              <div class="detail-item">
                <label>广告 ID</label>
                <span class="mono">{{ detailLog.ad_id }}</span>
              </div>
              <div class="detail-item">
                <label>执行状态</label>
                <span class="status-badge" :class="detailLog.status">
                  {{ getStatusLabel(detailLog.status) }}
                </span>
              </div>
              <div class="detail-item">
                <label>执行模式</label>
                <span v-if="detailLog.is_simulation" class="mode-badge simulation">🧪 模拟运行</span>
                <span v-else class="mode-badge real">⚡ 真实执行</span>
              </div>
              <div class="detail-item">
                <label>执行动作</label>
                <span class="action-badge" :class="getActionClass(detailLog.action_type)">
                  {{ getActionLabel(detailLog.action_type) }}
                </span>
              </div>
            </div>
          </div>

          <!-- 错误信息 -->
          <div v-if="detailLog.error_message" class="detail-section error-section">
            <h4>错误信息</h4>
            <div class="error-box">{{ detailLog.error_message }}</div>
          </div>

          <!-- 指标快照 -->
          <div v-if="detailLog.metrics_snapshot && Object.keys(detailLog.metrics_snapshot).length" class="detail-section">
            <h4>触发时指标快照</h4>
            <div class="metrics-grid">
              <div v-for="(value, key) in detailLog.metrics_snapshot" :key="key" class="metric-item">
                <label>{{ getMetricLabel(key) }}</label>
                <span>{{ formatMetricValue(key, value) }}</span>
              </div>
            </div>
          </div>

          <!-- 动作参数 -->
          <div v-if="detailLog.action_payload && Object.keys(detailLog.action_payload).length" class="detail-section">
            <h4>动作参数</h4>
            <pre class="json-box">{{ formatActionPayloadDisplay(detailLog.action_payload) }}</pre>
          </div>

          <!-- API 请求/响应 -->
          <div v-if="detailLog.api_request || detailLog.api_response" class="detail-section">
            <h4>API 交互记录</h4>
            <div v-if="detailLog.api_request" class="api-block">
              <label>请求</label>
              <pre class="json-box">{{ detailLog.api_request }}</pre>
            </div>
            <div v-if="detailLog.api_response" class="api-block">
              <label>响应</label>
              <pre class="json-box">{{ detailLog.api_response }}</pre>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn secondary" @click="showDetail = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue'
import facebookApi from '../services/facebookApi'
import { authFetch } from '../utils/authFetch.js'
import {
  formatTimeBeijing,
  formatDateBeijing,
  formatDateTimeBeijing,
  formatDateTimeBeijingLocale
} from '../utils/dateTime'

export default {
  name: 'Logs',
  setup() {
    const logs = ref([])
    const loading = ref(false)
    const showDetail = ref(false)
    const detailLog = ref(null)
    const accounts = ref([])
    const rules = ref([])
    const stats = ref({ today: null, week: [] })
    
    const filters = reactive({
      account_id: '',
      rule_id: '',
      status: '',
      start_date: '',
      end_date: ''
    })
    
    const pagination = reactive({
      page: 1,
      limit: 50,
      total: 0,
      totalPages: 0
    })

    // 加载日志
    const loadLogs = async () => {
      loading.value = true
      try {
        const params = new URLSearchParams()
        if (filters.account_id) params.append('account_id', filters.account_id)
        if (filters.rule_id) params.append('rule_id', filters.rule_id)
        if (filters.status) params.append('status', filters.status)
        if (filters.start_date) params.append('start_date', filters.start_date)
        if (filters.end_date) params.append('end_date', filters.end_date)
        params.append('page', pagination.page)
        params.append('limit', pagination.limit)
        
        const resp = await authFetch(`/api/automation-logs?${params.toString()}`)
        const data = await resp.json()
        
        if (data.success) {
          logs.value = data.logs
          pagination.total = data.pagination.total
          pagination.totalPages = data.pagination.totalPages
        }
      } catch (e) {
        console.error('加载日志失败:', e)
      } finally {
        loading.value = false
      }
    }

    // 加载统计
    const loadStats = async () => {
      try {
        const resp = await authFetch('/api/automation-logs/stats/summary')
        const data = await resp.json()
        if (data.success) {
          stats.value = { today: data.today, week: data.week }
        }
      } catch (e) {
        console.error('加载统计失败:', e)
      }
    }

    // 加载账户列表
    const loadAccounts = async () => {
      try {
        accounts.value = await facebookApi.getAdAccounts()
      } catch (e) {
        console.error('加载账户失败:', e)
      }
    }

    // 加载规则列表
    const loadRules = async () => {
      try {
        const resp = await authFetch('/api/rules')
        const data = await resp.json()
        if (data.rules) {
          rules.value = data.rules.map(r => ({
            id: r.id,
            name: r.ruleName || r.rule_name || r.name || `规则 ${r.id}`
          }))
        }
      } catch (e) {
        console.error('加载规则失败:', e)
      }
    }

    // 重置分页并加载
    const resetAndLoad = () => {
      pagination.page = 1
      loadLogs()
    }

    // 清除筛选
    const clearFilters = () => {
      filters.account_id = ''
      filters.rule_id = ''
      filters.status = ''
      filters.start_date = ''
      filters.end_date = ''
      resetAndLoad()
    }

    // 分页
    const goToPage = (page) => {
      pagination.page = page
      loadLogs()
    }

    // 打开详情
    const openDetail = async (log) => {
      try {
        const resp = await authFetch(`/api/automation-logs/${log.id}`)
        const data = await resp.json()
        if (data.success) {
          detailLog.value = data.log
          showDetail.value = true
        }
      } catch (e) {
        console.error('加载详情失败:', e)
      }
    }

    // ============================================
    // 时区格式化函数（主次分明设计）- 使用 Luxon
    // 主显示：广告账户当地时间（业务核心）
    // 副显示：我的本地时间（参考用）
    // ============================================
    
    /**
     * 获取时区的友好标签
     */
    // 前端统一北京时区（UTC+8）显示，使用 utils/dateTime.js
    const formatAccountTime = (dateStr) => formatTimeBeijing(dateStr)
    const formatAccountDate = (dateStr) => formatDateBeijing(dateStr)
    const formatTime = (dateStr) => formatTimeBeijing(dateStr)
    const formatDate = (dateStr) => formatDateBeijing(dateStr)
    const formatDateTime = (dateStr) => formatDateTimeBeijing(dateStr)

    const getStatusLabel = (status) => {
      const map = { success: '成功', fail: '失败', skipped: '跳过' }
      return map[status] || status
    }

    const getActionLabel = (type) => {
      const map = {
        pause_ad: '暂停广告',
        PAUSE: '暂停广告',
        activate_ad: '启用广告',
        ACTIVATE: '启用广告',
        increase_budget: '增加预算',
        INCREASE_BUDGET: '增加预算',
        decrease_budget: '减少预算',
        DECREASE_BUDGET: '减少预算'
      }
      return map[type] || type
    }

    const getActionClass = (type) => {
      if (['pause_ad', 'PAUSE'].includes(type)) return 'danger'
      if (['activate_ad', 'ACTIVATE'].includes(type)) return 'success'
      return 'primary'
    }

    /** 动作参数展示：预算类把 value 显示为百分比，max_daily_budget 显示为美元 */
    const formatActionPayloadDisplay = (payload) => {
      if (!payload || typeof payload !== 'object') return JSON.stringify(payload, null, 2)
      const type = payload.type || payload.action_type || ''
      const isBudget = String(type).includes('budget') || String(type).includes('BUDGET')
      const copy = { ...payload }
      if (isBudget && copy.value != null) copy.value = `${copy.value}%`
      if (isBudget && copy.max_daily_budget != null) copy.max_daily_budget_display_usd = '$' + (copy.max_daily_budget / 100).toFixed(2)
      return JSON.stringify(copy, null, 2)
    }

    const getMetricLabel = (key) => {
      const map = {
        spend: '花费',
        roas: 'ROAS',
        cpa: 'CPA',
        cpc: 'CPC',
        purchases: '购买次数',
        link_clicks: '链接点击',
        impressions: '展示次数',
        clicks: '点击次数'
      }
      return map[key] || key
    }

    const formatMetricValue = (key, value) => {
      if (value === null || value === undefined) return '-'
      if (['spend', 'cpa', 'cpc', 'roas'].includes(key)) {
        return Number(value).toFixed(2)
      }
      return value
    }

    onMounted(() => {
      loadAccounts()
      loadRules()
      loadStats()
      loadLogs()
    })

    return {
      logs, loading, showDetail, detailLog,
      accounts, rules, stats, filters, pagination,
      loadLogs, resetAndLoad, clearFilters, goToPage, openDetail,
      formatTime, formatDate, formatDateTime,
      formatAccountTime, formatAccountDate, formatDateTimeBeijingLocale,
      getStatusLabel, getActionLabel, getActionClass,
      getMetricLabel, formatMetricValue, formatActionPayloadDisplay
    }
  }
}
</script>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.page-header h2 {
  margin: 0;
  font-size: 24px;
  color: var(--text-primary);
}

/* 统计卡片 */
.stats-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px 20px;
  text-align: center;
}

.stat-card .stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-card .stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.stat-card.success .stat-value { color: var(--secondary-color); }
.stat-card.danger .stat-value { color: var(--danger-color); }
.stat-card.warning .stat-value { color: var(--warning-color); }

/* 筛选器 */
.filter-panel {
  padding: 16px 20px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.filter-item label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.select, .input-date {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: #fff;
  min-width: 140px;
  font-size: 13px;
}

/* 表格 */
.table-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.table-container {
  flex: 1;
  overflow: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 900px;
}

.data-table th, .data-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--bg-body);
  text-align: left;
  font-size: 13px;
}

.data-table th {
  background: #f7f8fa;
  color: var(--text-secondary);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
}

.data-table tbody tr:hover {
  background-color: #f0f8ff;
}

.data-table tbody tr.row-error {
  background-color: #fff5f5;
}

.col-time { width: 130px; }
.col-rule { width: 180px; }
.col-ad { max-width: 200px; }
.col-action { width: 100px; }
.col-status { width: 80px; }
.col-mode { width: 80px; }
.col-ops { width: 60px; }

/* 时间显示：主次分明设计（AdsPolar 风格） */
.time-primary {
  display: flex;
  align-items: center;
  gap: 6px;
}
.account-time {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.tz-label {
  font-size: 10px;
  color: var(--primary-color);
  background: rgba(199, 89, 89, 0.1);
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 500;
}
.date-text { 
  font-size: 11px; 
  color: var(--text-secondary); 
  margin-top: 2px;
}
.time-secondary {
  font-size: 10px;
  color: #999;
  margin-top: 3px;
}
.rule-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.account-text { font-size: 11px; color: var(--text-secondary); }
.ad-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
.ad-id { font-size: 11px; color: var(--text-secondary); font-family: monospace; }

/* 徽章样式 */
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-badge.success { background: #e6f6ec; color: var(--secondary-color); }
.status-badge.fail { background: #fff5f5; color: var(--danger-color); }
.status-badge.skipped { background: #f5f5f5; color: var(--text-secondary); }

.action-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.action-badge.danger { background: #fff5f5; color: var(--danger-color); }
.action-badge.success { background: #e6f6ec; color: var(--secondary-color); }
.action-badge.primary { background: #eef2ff; color: var(--primary-color); }

.mode-badge {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.mode-badge.simulation { background: #fffbeb; color: #92400e; }
.mode-badge.real { background: #eef2ff; color: var(--primary-color); }

/* 分页 */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border-top: 1px solid var(--bg-body);
}

.btn-page {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.btn-page:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-page:not(:disabled):hover {
  background: #f5f5f5;
}

.page-info {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 空状态和加载状态 */
.empty-state, .loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}

.empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
.empty-state h3 { margin: 0 0 8px 0; color: var(--text-primary); }
.empty-state p { margin: 0; }

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #eee;
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 模态框 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-content {
  background: #fff;
  width: 90%;
  max-width: 600px;
  border-radius: 12px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  animation: slideUp 0.3s ease;
}

.modal-content.wide {
  max-width: 800px;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--bg-body);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h3 { margin: 0; }

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-secondary);
}

.modal-body {
  padding: 24px;
  max-height: 70vh;
  overflow-y: auto;
}

.modal-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--bg-body);
  display: flex;
  justify-content: flex-end;
}

/* 详情样式 */
.detail-section {
  margin-bottom: 24px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: var(--text-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--bg-body);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-item label {
  font-size: 12px;
  color: var(--text-secondary);
}

.detail-item span {
  font-size: 14px;
  color: var(--text-primary);
}

/* 详情弹窗时间显示 */
.detail-time {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.date-inline {
  color: var(--text-secondary);
  font-size: 13px;
}
.local-hint {
  color: #999;
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.metric-item {
  background: #f9fafb;
  padding: 12px;
  border-radius: 6px;
}

.metric-item label {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.metric-item span {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.error-section h4 {
  color: var(--danger-color);
}

.error-box {
  background: #fff5f5;
  border: 1px solid #fed7d7;
  color: var(--danger-color);
  padding: 12px;
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-all;
}

.json-box {
  background: #f9fafb;
  border: 1px solid var(--border-color);
  padding: 12px;
  border-radius: 6px;
  font-size: 12px;
  font-family: monospace;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.api-block {
  margin-bottom: 12px;
}

.api-block:last-child {
  margin-bottom: 0;
}

.api-block label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

.btn-text {
  background: none;
  border: none;
  color: var(--primary-color);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 8px;
}

.btn-text:hover {
  text-decoration: underline;
}
</style>

