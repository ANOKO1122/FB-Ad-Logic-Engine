<template>
  <div class="system-page">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>系统状态</h2>
      <button class="btn secondary" @click="loadAll" :disabled="loading">
        {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <!-- 状态指示卡片 -->
    <div class="status-cards">
      <div class="status-card" :class="getSystemStatusClass()">
        <div class="status-indicator">
          <span class="dot" :class="getSystemStatusClass()"></span>
          {{ getSystemStatusText() }}
        </div>
        <div class="status-label">系统状态</div>
      </div>
      
      <div class="status-card">
        <div class="status-value">
          {{ healthData.cron?.last_run_time ? formatTimeAgo(healthData.cron.last_run_time) : '-' }}
        </div>
        <div class="status-label">上次同步</div>
      </div>
      
      <div class="status-card">
        <div class="status-value">
          {{ healthData.cron?.last_run_duration_ms != null 
            ? (healthData.cron.last_run_duration_ms / 1000).toFixed(1) + 's' 
            : '-' }}
        </div>
        <div class="status-label">规则扫描耗时</div>
      </div>
      
      <div class="status-card" :class="{ warning: healthData.queue?.pending_count > 0 }">
        <div class="status-value">{{ healthData.queue?.pending_count || 0 }}</div>
        <div class="status-label">待处理异常</div>
      </div>
    </div>

    <!-- Token 锁定警告 -->
    <div v-if="healthData.is_system_locked" class="alert-banner error">
      <span class="icon">🔒</span>
      <div class="alert-content">
        <strong>系统已锁定</strong>
        <p>Token 连续失败已触发熔断，所有同步任务暂停。请检查 Facebook Access Token 是否有效。</p>
      </div>
    </div>

    <!-- 账户同步状态 -->
    <div class="card">
      <div class="card-header">
        <h3>账户同步状态</h3>
      </div>
      <div class="card-body">
        <div v-if="healthData.accounts?.length === 0" class="empty-state">
          <p>暂无账户数据</p>
        </div>
        <div v-else class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>账户名称</th>
                <th>账户 ID</th>
                <th>时区</th>
                <th>最近尝试</th>
                <th>最近成功</th>
                <th>最近数据更新</th>
                <th>最近结果</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="account in healthData.accounts" :key="account.account_id">
                <td>{{ account.account_name }}</td>
                <td class="mono">{{ account.account_id }}</td>
                <td>{{ account.timezone }}</td>
                <td>
                  <span v-if="account.last_heartbeat_attempt_at">
                    {{ formatDateTime(account.last_heartbeat_attempt_at) }}
                    <span class="muted">({{ formatTimeAgo(account.last_heartbeat_attempt_at) }})</span>
                  </span>
                  <span v-else class="muted">从未尝试</span>
                </td>
                <td>
                  <span v-if="account.last_heartbeat_success_at">
                    {{ formatDateTime(account.last_heartbeat_success_at) }}
                    <span class="muted">({{ formatTimeAgo(account.last_heartbeat_success_at) }})</span>
                  </span>
                  <span v-else class="muted">暂无成功记录</span>
                </td>
                <td>
                  <span v-if="account.last_heartbeat_data_update_at">
                    {{ formatDateTime(account.last_heartbeat_data_update_at) }}
                    <span class="muted">({{ formatTimeAgo(account.last_heartbeat_data_update_at) }})</span>
                  </span>
                  <span v-else class="muted">暂无数据更新</span>
                </td>
                <td>
                  <div class="result-summary">
                    <div>{{ getHeartbeatResultText(account.last_heartbeat_result_code) }}</div>
                    <div
                      v-if="account.last_heartbeat_error_message"
                      class="muted result-detail"
                      :title="account.last_heartbeat_error_message"
                    >
                      {{ truncateText(account.last_heartbeat_error_message, 120) }}
                    </div>
                    <div
                      v-else-if="account.last_heartbeat_duration_ms != null"
                      class="muted result-detail"
                    >
                      耗时 {{ formatDurationMs(account.last_heartbeat_duration_ms) }}
                    </div>
                  </div>
                </td>
                <td>
                  <span class="sync-status" :class="account.status">
                    <span class="dot"></span>
                    {{ getSyncStatusText(account.status) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 定时任务（与 server/services/cronService.js 一致；单条规则请在「自动化规则」页使用「运行此规则」） -->
    <div class="card">
      <div class="card-header">
        <h3>定时任务</h3>
      </div>
      <div class="card-body">
        <div class="cron-info">
          <div class="cron-item">
            <div class="cron-name">规则引擎扫描</div>
            <div class="cron-desc">每分钟调度，对每账户做规则评估与执行；同一规则对同一广告有执行间隔（默认 15 分钟）与执行时间段限制。<br/>联动：依赖「统一心跳」拉取的数据；冷却与心跳周期一致。</div>
            <div class="cron-status">
              <span v-if="cronStatus.is_running" class="running">
                <span class="pulse"></span> 运行中
              </span>
              <span v-else class="idle">空闲</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">统一心跳（数据同步 + 归档）</div>
            <div class="cron-desc">每 15 分钟拉取最新广告数据（Today / 近 3 天等），并按账户时区做冷数据双窗口归档（≥02:00 初步归档，≥12:00 深度对账）。<br/>联动：为规则引擎提供数据；与 Track2/Track1 共用熔断与使用率。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">Track2 Fast Sync（可选）</div>
            <div class="cron-desc">每小时 :07/:27/:52 执行，近 3 天增量结构/数据快速同步；使用率高或熔断时跳过。<br/>联动：与 Track1 结构轮转错峰；与统一心跳共用熔断与 API 使用率。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">账户列表同步</div>
            <div class="cron-desc">每小时整点从 Facebook API 同步账户列表到 DB。<br/>联动：独立任务，为其它任务提供活跃账户列表。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">Track1 结构轮转（近 3 天）</div>
            <div class="cron-desc">每小时 :12 执行，全量结构轮转，每次最多 6 个账户；账户级 2 分钟冷却，使用率≥85% 时整轮跳过。<br/>联动：与 Track2 错开时间；与统一心跳共用熔断与使用率。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">热表清理</div>
            <div class="cron-desc">每日 04:00 删除 ad_snapshots 超过 2 天的快照，控制热表体积。<br/>联动：在历史表清理前执行，减轻后续清理压力。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>

          <div class="cron-item">
            <div class="cron-name">历史表清理</div>
            <div class="cron-desc">每日 04:30 按保留天数清理 rule_matched_objects_history（30 天）、structure_ads_history / rule_history（60 天）。<br/>联动：在热表清理之后执行，避免与热表清理同时抢锁。</div>
            <div class="cron-status">
              <span class="idle">按计划</span>
            </div>
          </div>
        </div>

        <!-- 上次执行统计 -->
        <div v-if="cronStatus.lastStats" class="last-stats">
          <h4>上次执行统计</h4>
          <div class="stats-grid">
            <div class="stat-item">
              <label>同步账户数</label>
              <span>{{ cronStatus.lastStats.accounts || 0 }}</span>
            </div>
            <div class="stat-item">
              <label>同步广告数</label>
              <span>{{ cronStatus.lastStats.ads || 0 }}</span>
            </div>
            <div class="stat-item">
              <label>规则触发数</label>
              <span>{{ cronStatus.lastStats.triggered || 0 }}</span>
            </div>
            <div class="stat-item">
              <label>执行成功数</label>
              <span>{{ cronStatus.lastStats.success || 0 }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近告警（如果有） -->
    <div v-if="recentAlerts.length > 0" class="card">
      <div class="card-header">
        <h3>最近告警</h3>
      </div>
      <div class="card-body">
        <div class="alerts-list">
          <div v-for="alert in recentAlerts" :key="alert.id" class="alert-item" :class="alert.level">
            <span class="alert-time">{{ formatDateTime(alert.time) }}</span>
            <span class="alert-message">{{ alert.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { formatDateTimeBeijing, parseUTC } from '../utils/dateTime'
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'SystemStatus',
  setup() {
    const loading = ref(false)
    
    const healthData = reactive({
      system_status: 'unknown',
      is_system_locked: false,
      cron: {},
      accounts: [],
      queue: { pending_count: 0 }
    })
    
    const cronStatus = reactive({
      is_running: false,
      lastStats: null
    })
    
    const recentAlerts = ref([])
    
    let refreshTimer = null

    // 加载健康数据
    const loadHealth = async () => {
      try {
        const resp = await authFetch('/api/system/health')
        const data = await resp.json()
        
        if (data.success) {
          Object.assign(healthData, {
            system_status: data.system_status,
            is_system_locked: data.is_system_locked,
            cron: data.cron || {},
            accounts: data.accounts || [],
            queue: data.queue || { pending_count: 0 }
          })
          
          cronStatus.is_running = data.cron?.is_running || false
          cronStatus.lastStats = data.cron?.last_stats || null
        }
      } catch (e) {
        console.error('加载健康状态失败:', e)
      }
    }

    // 加载 cron 状态
    const loadCronStatus = async () => {
      try {
        const resp = await authFetch('/api/admin/cron/status')
        const data = await resp.json()
        
        if (data.success) {
          cronStatus.is_running = data.isRunning || false
          cronStatus.lastStats = data.lastStats || null
        }
      } catch (e) {
        // 非管理员可能没有权限，静默失败
        console.debug('加载 cron 状态失败（可能无权限）:', e)
      }
    }

    // 加载所有数据
    const loadAll = async () => {
      loading.value = true
      try {
        await Promise.all([loadHealth(), loadCronStatus()])
      } finally {
        loading.value = false
      }
    }

    // 前端统一北京时区（UTC+8）显示
    const formatDateTime = (dateStr) => formatDateTimeBeijing(dateStr)

    const formatTimeAgo = (dateStr) => {
      if (!dateStr) return '-'
      const dt = parseUTC(dateStr)
      if (!dt || !dt.isValid) return '-'
      const diffMs = Date.now() - dt.toMillis()
      const diffMins = Math.floor(diffMs / (1000 * 60))
      
      if (diffMins < 1) return '刚刚'
      if (diffMins < 60) return `${diffMins} 分钟前`
      
      const diffHours = Math.floor(diffMins / 60)
      if (diffHours < 24) return `${diffHours} 小时前`
      
      const diffDays = Math.floor(diffHours / 24)
      return `${diffDays} 天前`
    }

    const getSystemStatusClass = () => {
      if (healthData.is_system_locked) return 'error'
      return healthData.system_status || 'unknown'
    }

    const getSystemStatusText = () => {
      if (healthData.is_system_locked) return '已锁定'
      const map = {
        healthy: '正常',
        warning: '警告',
        error: '异常',
        unknown: '未知'
      }
      return map[healthData.system_status] || '未知'
    }

    const getSyncStatusText = (status) => {
      const map = {
        healthy: '正常',
        healthy_no_data: '正常（无数据）',
        stale: '滞后',
        error: '异常',
        unknown: '未知'
      }
      return map[status] || '未知'
    }

    const getHeartbeatResultText = (resultCode) => {
      const map = {
        SUCCESS_WITH_DATA: '成功（有数据）',
        SUCCESS_NO_DATA: '成功（无数据）',
        FAILED: '同步失败',
        SKIPPED_INVALID_ACCOUNT: '已跳过（账户配置无效）'
      }
      return map[resultCode] || '暂无结果'
    }

    const formatDurationMs = (durationMs) => {
      if (durationMs == null || Number.isNaN(Number(durationMs))) return '-'
      const value = Number(durationMs)
      if (value < 1000) return `${value}ms`
      return `${(value / 1000).toFixed(1)}s`
    }

    const truncateText = (text, maxLength = 120) => {
      const content = String(text || '').trim()
      if (!content) return ''
      return content.length <= maxLength ? content : `${content.slice(0, maxLength)}...`
    }

    onMounted(() => {
      loadAll()
      // 每 30 秒自动刷新
      refreshTimer = setInterval(loadAll, 30000)
    })

    onUnmounted(() => {
      if (refreshTimer) {
        clearInterval(refreshTimer)
      }
    })

    return {
      loading,
      healthData, cronStatus, recentAlerts,
      loadAll,
      formatDateTime, formatTimeAgo,
      getSystemStatusClass, getSystemStatusText, getSyncStatusText,
      getHeartbeatResultText, formatDurationMs, truncateText
    }
  }
}
</script>

<style scoped>
.system-page {
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

/* 状态卡片 */
.status-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.status-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  text-align: center;
}

.status-card .status-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.status-card .status-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
}

.status-card .status-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
}

.status-card.warning .status-value { color: var(--warning-color); }

/* 状态点 */
.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ccc;
}

.dot.healthy, .status-indicator.healthy .dot { background: var(--secondary-color); }
.dot.warning, .status-indicator.warning .dot { background: var(--warning-color); }
.dot.error, .status-indicator.error .dot { background: var(--danger-color); }

.status-indicator.healthy { color: var(--secondary-color); }
.status-indicator.warning { color: var(--warning-color); }
.status-indicator.error { color: var(--danger-color); }

/* 告警 Banner */
.alert-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border-radius: 8px;
}

.alert-banner.error {
  background: #fff5f5;
  border: 1px solid #fed7d7;
  color: var(--danger-color);
}

.alert-banner .icon {
  font-size: 20px;
}

.alert-banner .alert-content strong {
  display: block;
  margin-bottom: 4px;
}

.alert-banner .alert-content p {
  margin: 0;
  font-size: 13px;
  opacity: 0.9;
}

/* 卡片 */
.card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.card-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--bg-body);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 12px;
}

.card-body {
  padding: 20px;
}

/* 表格 */
.table-container {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
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
}

.data-table tbody tr:hover {
  background-color: #f9fafb;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

/* 同步状态 */
.sync-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.sync-status .dot {
  width: 8px;
  height: 8px;
}

.sync-status.healthy { color: var(--secondary-color); }
.sync-status.healthy .dot { background: var(--secondary-color); }
.sync-status.healthy_no_data { color: #2b6cb0; }
.sync-status.healthy_no_data .dot { background: #2b6cb0; }
.sync-status.stale { color: var(--warning-color); }
.sync-status.stale .dot { background: var(--warning-color); }
.sync-status.error { color: var(--danger-color); }
.sync-status.error .dot { background: var(--danger-color); }
.sync-status.unknown { color: var(--text-secondary); }

.result-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-detail {
  max-width: 280px;
  word-break: break-word;
}

/* Cron 任务列表 */
.cron-info {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

@media (max-width: 1200px) {
  .cron-info {
    grid-template-columns: repeat(2, 1fr);
  }
}

.cron-item {
  background: #f9fafb;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
}

.cron-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.cron-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.cron-status {
  font-size: 13px;
}

.cron-status .running {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--secondary-color);
  font-weight: 500;
}

.cron-status .idle {
  color: var(--text-secondary);
}

.pulse {
  width: 8px;
  height: 8px;
  background: var(--secondary-color);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}

/* 上次执行统计 */
.last-stats {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--bg-body);
}

.last-stats h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-item {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px;
  text-align: center;
}

.stat-item label {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.stat-item span {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

/* 告警列表 */
.alerts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.alert-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  border-radius: 6px;
  font-size: 13px;
}

.alert-item.error {
  background: #fff5f5;
  color: var(--danger-color);
}

.alert-item.warning {
  background: #fffbeb;
  color: #92400e;
}

.alert-time {
  flex-shrink: 0;
  font-family: monospace;
  font-size: 12px;
  opacity: 0.8;
}
</style>

