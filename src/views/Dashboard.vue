<template>
  <div class="dashboard-page">
    <!-- 顶部控制栏 -->
    <div class="card control-panel">
      <div class="panel-row">
        <div class="left-group">
          <label class="label">广告账户</label>
          <select v-model="selectedAccountId" class="select account-select" @change="onAccountChange">
            <option value="">请选择账户</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }} ({{ a.id }})</option>
          </select>
          <button class="btn secondary small" @click="loadAccounts" title="刷新账户列表">🔄</button>
        </div>

        <div class="right-group">
          <label class="checkbox-label">
            <input type="checkbox" v-model="monitoringEnabled" @change="toggleMonitoring" />
            <span class="status-indicator" :class="{ active: monitoringEnabled }"></span>
            自动刷新
          </label>
          <button class="btn" @click="refreshNow" :disabled="baseLoading">
            {{ baseLoading ? '加载中...' : '立即刷新' }}
          </button>
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-row filters">
        <div class="filter-item">
          <label>层级</label>
          <div class="btn-group">
            <button 
              v-for="level in ['campaign', 'adset', 'ad']" 
              :key="level"
              class="btn-toggle"
              :class="{ active: dataLevel === level }"
              @click="setLevel(level)"
            >
              {{ levelName(level) }}
            </button>
          </div>
        </div>

        <div class="filter-item">
          <label>时间范围</label>
          <select v-model="timePreset" class="select small" @change="refreshNow">
            <option value="today">今天</option>
            <option value="yesterday">昨天</option>
            <option value="last_7d">最近7天</option>
            <option value="last_30d">最近30天</option>
            <option value="this_month">本月</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="alert error">
      {{ errorMsg }}
    </div>

    <!-- 数据表格 -->
    <div class="card table-card" v-if="selectedAccountId">
      <div v-if="!adRows.length && !baseLoading" class="empty-state">
        <div class="empty-icon">📭</div>
        <p>暂无数据，请尝试切换时间范围或点击刷新</p>
      </div>

      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th class="col-name">名称</th>
              <th class="col-status">状态</th>
              <th class="col-metric">花费</th>
              <th class="col-metric">成效(购买)</th>
              <th class="col-metric">CPA</th>
              <th class="col-metric">ROAS</th>
              <th class="col-metric">CPC</th>
              <th class="col-metric">uCPC</th>
              <th class="col-metric">加购费</th>
              <th class="col-metric">结账费</th>
              <th class="col-metric">支付费</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, index) in adRows" :key="getRowKey(r, index)">
              <td class="col-name" :title="getRowName(r)">
                <div class="name-text">{{ getRowName(r) }}</div>
                <div class="id-text">{{ r.ad_id || r.adset_id || r.campaign_id }}</div>
              </td>
              <td>
                <span class="status-badge" :class="getStatusClass(r)">
                  {{ getAdStatus(r) }}
                </span>
              </td>
              <td class="col-metric font-mono">{{ formatNumber(r.spend, 2) }}</td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatNumber(r.purchases || 0) }}</span>
              </td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatMoney(r.cpa, r.spend, r.purchases) }}</span>
              </td>
              <td class="col-metric font-mono" :class="getRoasClass(r)">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ r.spend > 0 ? formatNumber((r.purchase_value / r.spend), 2) : '-' }}</span>
              </td>
              <td class="col-metric font-mono">{{ formatNumber(r.cpc, 2) }}</td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatMoney(r.ucpc, r.spend, r.unique_link_clicks) }}</span>
              </td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatMoney(r.cp_atc, r.spend, r.add_to_cart) }}</span>
              </td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatMoney(r.cp_ic, r.spend, r.initiate_checkout) }}</span>
              </td>
              <td class="col-metric font-mono">
                <span v-if="r.loadingRoi" class="spinner-sm"></span>
                <span v-else>{{ formatMoney(r.cp_api, r.spend, r.add_payment_info) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    
    <div v-else class="empty-placeholder">
      <p>👈 请先在左上角选择一个广告账户</p>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import facebookApi from '../services/facebookApi'
import monitorService from '../services/monitorService'

export default {
  name: 'Dashboard',
  setup() {
    // 状态定义
    const accounts = ref([])
    const selectedAccountId = ref('')
    const insights = ref([])
    const adRows = ref([])
    const monitoringEnabled = ref(false)
    const timePreset = ref('today')
    const dataLevel = ref('ad')
    const adStatusMap = ref({})
    const baseLoading = ref(false)
    const errorMsg = ref('')
    const currentMonitoringAccountId = ref('')
    let roiPollTimer = null

    // 工具函数
    const levelName = (l) => ({ campaign: '广告系列', adset: '广告组', ad: '广告' }[l])
    const clearRoiPoll = () => { if (roiPollTimer) clearInterval(roiPollTimer); roiPollTimer = null }

    // 加载账户
    const loadAccounts = async () => {
      accounts.value = await facebookApi.getAdAccounts()
    }

    // 切换层级
    const setLevel = async (level) => {
      if (dataLevel.value === level) return
      dataLevel.value = level
      await onLevelChange()
    }

    const onLevelChange = async () => {
      insights.value = []
      adRows.value = []
      errorMsg.value = ''
      clearRoiPoll()
      if (monitoringEnabled.value) {
        await startMonitoringForAccount(selectedAccountId.value)
      } else {
        await refreshNow()
      }
    }

    // 加载广告状态
    const loadAdStatus = async () => {
      if (dataLevel.value !== 'ad' || !selectedAccountId.value) {
        adStatusMap.value = {}
        return
      }
      try {
        const ads = await facebookApi.getAds(selectedAccountId.value)
        const statusMap = {}
        for (const ad of ads || []) {
          if (ad.id) statusMap[String(ad.id)] = { status: ad.status, effective_status: ad.effective_status }
        }
        adStatusMap.value = statusMap
      } catch (e) {
        console.warn('加载状态失败:', e)
      }
    }

    // 核心刷新逻辑
    const refreshNow = async () => {
      if (!selectedAccountId.value) return
      baseLoading.value = true
      errorMsg.value = ''
      clearRoiPoll()
      try {
        await loadAdStatus()
        const base = await facebookApi.getAdInsights(
          selectedAccountId.value, 
          { preset: timePreset.value }, 
          { level: dataLevel.value }
        )
        insights.value = base
        // 初始化行数据
        adRows.value = (base || []).map(x => ({
          ...x,
          loadingRoi: true,
          purchases: 0, purchase_value: 0, add_to_cart: 0, initiate_checkout: 0, add_payment_info: 0,
          cpa: null, ucpc: null, cp_atc: null, cp_ic: null, cp_api: null
        }))
        await loadRoiAsync({ force: true })
      } catch (e) {
        errorMsg.value = e.message
        adRows.value = []
      } finally {
        baseLoading.value = false
      }
    }

    // ROI 异步加载
    const loadRoiAsync = async ({ force = false } = {}) => {
      if (!selectedAccountId.value) return
      try {
        const startRes = await facebookApi.getRoiMetrics(
          selectedAccountId.value,
          { preset: timePreset.value },
          { force, level: dataLevel.value }
        )
        
        // 立即返回结果的情况
        if (startRes?.roiByAdId) {
          updateRowsWithRoi(startRes.roiByAdId)
          return
        }

        // 需要轮询的情况
        const runId = startRes?.report_run_id
        if (!runId) return

        let attempts = 0
        clearRoiPoll()
        const localAccountId = String(selectedAccountId.value)
        const localLevel = dataLevel.value

        roiPollTimer = setInterval(async () => {
          attempts++
          // 守卫：防止切换账户后仍在轮询旧任务
          if (String(selectedAccountId.value) !== localAccountId || dataLevel.value !== localLevel) {
            clearRoiPoll()
            return
          }
          if (attempts > 60) { clearRoiPoll(); return } // 超时停止

          try {
            const res = await facebookApi.getRoiMetricsResult(runId, localLevel)
            if (res?.roiByAdId) {
              updateRowsWithRoi(res.roiByAdId)
              clearRoiPoll()
            }
          } catch {}
        }, 2000)

      } catch (e) {
        console.warn('ROI Error:', e)
        adRows.value = adRows.value.map(r => ({ ...r, loadingRoi: false }))
      }
    }

    const updateRowsWithRoi = (roiMap) => {
      const idKey = dataLevel.value === 'adset' ? 'adset_id' : (dataLevel.value === 'campaign' ? 'campaign_id' : 'ad_id')
      adRows.value = adRows.value.map(row => {
        const roi = roiMap[String(row[idKey] || '')]
        if (!roi) return { ...row, loadingRoi: false }
        return { ...row, loadingRoi: false, ...roi }
      })
    }

    // 自动监控逻辑
    let unsubscribe = null
    const startMonitoringForAccount = async (accountId) => {
      if (!accountId) return
      currentMonitoringAccountId.value = String(accountId)
      monitorService.startMonitoring(accountId, 60000, { preset: timePreset.value, level: dataLevel.value })
      
      if (unsubscribe) unsubscribe()
      unsubscribe = monitorService.subscribe(accountId, (data, err) => {
        if (currentMonitoringAccountId.value !== String(accountId)) return
        if (err) { errorMsg.value = err.message; return }
        
        // 合并数据保留 ROI
        const idKey = dataLevel.value === 'adset' ? 'adset_id' : (dataLevel.value === 'campaign' ? 'campaign_id' : 'ad_id')
        adRows.value = (data || []).map(x => {
          const old = adRows.value.find(it => String(it[idKey]) === String(x[idKey]))
          return {
            ...x,
            loadingRoi: old?.loadingRoi ?? true,
            purchases: old?.purchases ?? 0,
            purchase_value: old?.purchase_value ?? 0,
            // ...其他 ROI 字段保留...
            cpa: old?.cpa, ucpc: old?.ucpc // 简写，实际应保留所有
          }
        })
      })
      await refreshNow()
    }

    const stopMonitoring = () => {
      if (currentMonitoringAccountId.value) {
        monitorService.stopMonitoring(currentMonitoringAccountId.value)
        currentMonitoringAccountId.value = ''
      }
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      clearRoiPoll()
    }

    const toggleMonitoring = async () => {
      if (monitoringEnabled.value) await startMonitoringForAccount(selectedAccountId.value)
      else stopMonitoring()
    }

    const onAccountChange = async () => {
      const prev = currentMonitoringAccountId.value
      if (prev) stopMonitoring()
      
      adRows.value = []
      errorMsg.value = ''
      
      if (monitoringEnabled.value) await startMonitoringForAccount(selectedAccountId.value)
      else await refreshNow()
    }

    // 显示逻辑
    const getRowKey = (row, index) => {
      const id = row.ad_id || row.adset_id || row.campaign_id
      return id ? `${dataLevel.value}_${id}` : `${dataLevel.value}_idx_${index}`
    }

    const getRowName = (row) => {
      if (dataLevel.value === 'adset') return row.adset_name
      if (dataLevel.value === 'campaign') return row.campaign_name
      return row.ad_name
    }

    const getAdStatus = (row) => {
      if (dataLevel.value !== 'ad') return '-'
      const info = adStatusMap.value[String(row.ad_id)]
      if (!info) return '-'
      const s = info.effective_status || info.status
      const map = { ACTIVE: '开启', PAUSED: '暂停', ARCHIVED: '归档', DELETED: '删除' }
      return map[s] || s
    }

    const getStatusClass = (row) => {
      const s = getAdStatus(row)
      if (s === '开启') return 'active'
      if (s === '暂停') return 'paused'
      return 'other'
    }

    const getRoasClass = (row) => {
      if (!row.spend || row.spend === 0) return ''
      const roas = row.purchase_value / row.spend
      if (roas >= 2.0) return 'text-success'
      if (roas < 1.0) return 'text-warning'
      return ''
    }

    const formatNumber = (n, d = 0) => {
      const v = Number(n)
      return isNaN(v) ? '-' : v.toFixed(d)
    }

    const formatMoney = (val, spend, count) => {
      if (val != null && val > 0) return formatNumber(val, 2)
      if (count > 0) return formatNumber(spend / count, 2)
      return '-'
    }

    onMounted(loadAccounts)
    onUnmounted(stopMonitoring)

    return {
      accounts, selectedAccountId, adRows, monitoringEnabled, timePreset, dataLevel,
      baseLoading, errorMsg,
      loadAccounts, onAccountChange, refreshNow, toggleMonitoring, setLevel, levelName,
      getRowKey, getRowName, getAdStatus, getStatusClass, getRoasClass, formatNumber, formatMoney
    }
  }
}
</script>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  height: 100%;
}

/* 控制面板 */
.control-panel {
  padding: var(--spacing-md) var(--spacing-lg);
  margin-bottom: 0;
}

.panel-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.left-group, .right-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.label {
  font-weight: 600;
  color: var(--text-secondary);
}

.select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: #fff;
  min-width: 120px;
}

.account-select {
  min-width: 280px;
}

.select.small {
  padding: 6px 10px;
  min-width: 100px;
  font-size: 13px;
}

.divider {
  height: 1px;
  background: var(--bg-body);
  margin: 16px 0;
}

/* 筛选器区域 */
.filters {
  justify-content: flex-start;
  gap: 32px;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter-item label {
  font-size: 13px;
  color: var(--text-secondary);
}

.btn-group {
  display: flex;
  background: var(--bg-body);
  padding: 2px;
  border-radius: var(--radius-md);
}

.btn-toggle {
  border: none;
  background: transparent;
  padding: 4px 12px;
  font-size: 13px;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-toggle.active {
  background: #fff;
  color: var(--primary-color);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}

/* 表格区域 */
.table-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0; /* 让表格贴边 */
  overflow: hidden; /* 必须有 */
}

.table-container {
  flex: 1;
  overflow: auto; /* 核心：让表格区域独立滚动 */
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 1000px; /* 保证最小宽度，触发横向滚动 */
}

.data-table th, .data-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--bg-body);
  text-align: left;
  font-size: 13px;
}

/* Sticky Header 核心 */
.data-table th {
  background: #f7f8fa;
  color: var(--text-secondary);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
  border-bottom: 2px solid var(--border-color);
}

.data-table tbody tr:hover {
  background-color: #f0f8ff; /* 悬停浅蓝 */
}

.col-name { max-width: 240px; }
.name-text { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.id-text { font-size: 11px; color: var(--text-secondary); font-family: monospace; }

.col-status { width: 80px; }
.col-metric { text-align: right; width: 100px; }

/* 状态徽章 */
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: #eee;
  color: #666;
}
.status-badge.active { background: #e6f6ec; color: var(--secondary-color); }
.status-badge.paused { background: #fff5f5; color: var(--text-secondary); }

/* ROAS 颜色 */
.text-success { color: var(--secondary-color); font-weight: 600; }
.text-warning { color: var(--warning-color); }

.font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

/* 状态指示灯 */
.status-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
  margin: 0 6px;
}
.status-indicator.active { background: var(--secondary-color); box-shadow: 0 0 4px var(--secondary-color); }

.checkbox-label {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}
.checkbox-label input { display: none; }

.spinner-sm {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid #ddd;
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: var(--text-secondary);
}
.empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
.empty-placeholder { text-align: center; margin-top: 100px; color: var(--text-secondary); }
.alert.error { padding: 12px; background: #fff2f2; color: #d32f2f; border-radius: 8px; font-size: 13px; }
</style>


