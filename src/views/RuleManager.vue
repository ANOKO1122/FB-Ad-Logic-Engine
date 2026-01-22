<template>
  <div class="rule-page">
    <!-- 免责提示 Banner -->
    <div class="disclaimer-banner">
      <span class="icon">⚠️</span>
      <div class="text">
        <strong>安全提示：</strong>
        在 Facebook 后台手动开启被系统关闭的广告前，请先在本系统<strong>暂停相关规则</strong>，避免被再次自动关闭。
      </div>
    </div>

    <!-- 顶部操作栏 -->
    <div class="header-actions">
      <h2>自动化规则</h2>
      <div class="actions">
        <button class="btn" @click="openCreateRule">
          <span class="icon">+</span> 新建规则
        </button>
        <button class="btn secondary" @click="runRulesNow" :disabled="running">
          {{ running ? '执行中...' : '立即运行所有规则' }}
        </button>
      </div>
    </div>

    <!-- 规则列表 (Grid 布局) -->
    <div v-if="rules.length === 0" class="empty-rules">
      <div class="empty-icon">⚡</div>
      <h3>暂无自动化规则</h3>
      <p>规则可以帮你 24 小时监控广告，自动止损或扩量。</p>
      <button class="btn" @click="openCreateRule">创建第一条规则</button>
    </div>

    <div v-else class="rules-grid">
      <div 
        v-for="r in rules" 
        :key="r.id" 
        class="rule-card"
        :class="{ disabled: !r.enabled }"
      >
        <div class="card-header">
          <h3 class="rule-name">{{ r.name }}</h3>
          <div class="switch-wrapper">
            <label class="switch">
              <input type="checkbox" :checked="r.enabled" @change="toggleRule(r, $event.target.checked)">
              <span class="slider round"></span>
            </label>
          </div>
        </div>

        <div class="card-body">
          <div class="section">
            <span class="label">IF (当满足以下条件时):</span>
            <div class="conditions-list">
              <div v-for="(c, idx) in r.conditions" :key="idx" class="pill condition">
                {{ metricLabel(c.metric) }} {{ opLabel(c.operator) }} {{ c.value }}
                <span v-if="c.time_window" class="muted">({{ timeWindowLabel(c.time_window) }})</span>
              </div>
            </div>
          </div>

          <div class="arrow">↓</div>

          <div class="section">
            <span class="label">THEN (执行操作):</span>
            <div class="actions-list">
              <div v-for="(a, idx) in r.actions" :key="idx" class="pill action" :class="getActionClass(a.type)">
                {{ actionLabel(a.type) }}
                <span v-if="a.value != null" class="val">{{ a.value }}%</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn-text" @click="openEditRule(r)">编辑</button>
          <button class="btn-text danger" @click="deleteRule(r)">删除</button>
        </div>
      </div>
    </div>

    <!-- 规则编辑模态框 -->
    <div v-if="showRuleModal" class="modal-overlay" @click="showRuleModal = false">
      <div class="modal-content wide" @click.stop>
        <div class="modal-header">
          <h3>{{ editingRuleId ? '编辑规则' : '新建规则' }}</h3>
          <button class="close-btn" @click="showRuleModal = false">×</button>
        </div>

        <div class="modal-body">
          <!-- 区块1：基本信息 -->
          <div class="section-block">
            <h4 class="section-title">1. 基本信息</h4>
            <div class="form-row">
              <div class="form-group flex-2">
                <label>规则名称</label>
                <input v-model="ruleForm.name" placeholder="例如：亏损严重自动关停" class="input-text" />
              </div>
              <div class="form-group flex-1">
                <label>模拟运行 (Dry Run)</label>
                <div class="switch-wrapper">
                  <label class="switch">
                    <input type="checkbox" v-model="ruleForm.isSimulation">
                    <span class="slider round"></span>
                  </label>
                  <span class="switch-label">{{ ruleForm.isSimulation ? '🧪 仅模拟日志' : '⚡ 真实执行' }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块2：作用对象 -->
          <div class="section-block">
            <h4 class="section-title">2. 作用对象 (Where)</h4>
            <div class="form-group">
              <label>广告账户</label>
              <div class="form-row">
                <select v-model="selectedAccountId" class="select" :disabled="accountLoading">
                  <option value="">请选择账户</option>
                  <option v-for="a in accounts" :key="a.id" :value="a.id">
                    {{ a.name }} ({{ a.id }})
                  </option>
                </select>
                <button class="btn secondary" @click="loadAccounts" :disabled="accountLoading">
                  {{ accountLoading ? '加载中...' : '刷新账户' }}
                </button>
                <button class="btn secondary" @click="refreshScopeItems" :disabled="!selectedAccountId || scopeLoading">
                  {{ scopeLoading ? '加载中...' : '刷新列表' }}
                </button>
              </div>
              <div class="hint">仅展示你有权限的账户</div>
              <div v-if="accountError" class="alert error">{{ accountError }}</div>
            </div>
            <div class="form-group">
              <label>目标层级</label>
              <div class="radio-group">
                <label v-for="opt in levelOptions" :key="opt.value" class="radio-label">
                  <input type="radio" v-model="ruleForm.targetLevel" :value="opt.value">
                  {{ opt.label }}
                </label>
              </div>
            </div>
            <div class="form-group">
              <label>选择目标对象（可多选）</label>
              <input
                v-model="scopeSearch"
                class="input-text"
                placeholder="搜索名称或ID"
              />
              <div v-if="!selectedAccountId" class="empty-hint">请先选择账户</div>
              <div v-else class="scope-list">
                <div class="scope-actions">
                  <span>已选 {{ ruleForm.targetIds.length }} 个</span>
                  <div class="scope-buttons">
                    <button class="btn-tiny" @click="selectAllScope" :disabled="!canSelectAll">全选</button>
                    <button class="btn-tiny" @click="clearScopeSelection" :disabled="!ruleForm.targetIds.length">清空</button>
                  </div>
                </div>
                <div v-if="ruleForm.targetIds.length" class="selected-preview">
                  <span v-for="id in selectedTargetPreview" :key="id" class="tag">{{ id }}</span>
                  <span v-if="ruleForm.targetIds.length > selectedTargetPreview.length" class="muted">
                    还有 {{ ruleForm.targetIds.length - selectedTargetPreview.length }} 个
                  </span>
                </div>
                <div v-if="scopeLoading" class="loading">正在加载列表...</div>
                <div v-else-if="!filteredScopeItems.length" class="empty-hint">暂无可选对象</div>
                <div v-else class="scope-items">
                  <label v-for="item in filteredScopeItems" :key="item.id" class="scope-item">
                    <input type="checkbox" :value="item.id" v-model="ruleForm.targetIds">
                    <span class="name">{{ item.name || '-' }}</span>
                    <span class="id">{{ item.id }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块3：触发条件 -->
          <div class="section-block">
            <div class="section-header">
              <h4 class="section-title">3. 触发条件 (When)</h4>
              <div class="template-actions">
                <button class="btn-tiny" @click="applyTemplate('stop_loss')">⚡ 止损模板</button>
                <button class="btn-tiny" @click="applyTemplate('scale_up')">🚀 扩量模板</button>
              </div>
            </div>

            <div class="form-group">
              <label>逻辑关系</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" v-model="ruleForm.logicOperator" value="AND"> 满足所有条件 (AND)
                </label>
                <label class="radio-label">
                  <input type="radio" v-model="ruleForm.logicOperator" value="OR"> 满足任一条件 (OR)
                </label>
              </div>
            </div>

            <div class="conditions-container">
              <div v-for="(c, idx) in ruleForm.conditions" :key="idx" class="condition-row">
                <select v-model="c.metric" class="select metric-select">
                  <option value="spend">花费</option>
                  <option value="roas">ROAS</option>
                  <option value="cpa">CPA</option>
                  <option value="cpc">CPC</option>
                  <option value="purchases">购买次数</option>
                  <option value="link_clicks">链接点击</option>
                </select>
                <select v-model="c.time_window" class="select window-select">
                  <option value="today">今天</option>
                  <option value="yesterday">昨天</option>
                  <option value="last_3_days">近3天</option>
                  <option value="lifetime">累计</option>
                </select>
                <select v-model="c.operator" class="select operator-select">
                  <option value="gt">大于 (>)</option>
                  <option value="lt">小于 (<)</option>
                  <option value="gte">大于等于 (≥)</option>
                  <option value="lte">小于等于 (≤)</option>
                  <option value="eq">等于 (=)</option>
                </select>
                <input type="number" v-model.number="c.value" class="input-number" step="0.01" />
                <button class="btn-icon danger" @click="ruleForm.conditions.splice(idx, 1)">×</button>
              </div>
              <button class="btn-add" @click="addCondition">+ 添加条件</button>
            </div>
          </div>

          <!-- 区块4：执行动作 -->
          <div class="section-block">
            <h4 class="section-title">4. 执行动作 (Then)</h4>
            <div v-for="(a, idx) in ruleForm.actions" :key="idx" class="action-row">
              <select v-model="a.type" class="select action-select">
                <option value="pause_ad">⏸ 暂停广告</option>
                <option value="activate_ad">▶️ 启用广告</option>
                <option value="increase_budget">💰 增加预算</option>
                <option value="decrease_budget">💸 减少预算</option>
              </select>
              <input
                v-if="a.type.includes('budget')"
                type="number"
                v-model.number="a.value"
                class="input-number"
                placeholder="%"
              />
              <span v-else class="placeholder">-</span>
              <button class="btn-icon danger" @click="ruleForm.actions.splice(idx, 1)">×</button>
            </div>
            <button class="btn-add" @click="addAction">+ 添加操作</button>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn secondary" @click="showRuleModal = false">取消</button>
          <button class="btn" @click="saveRule">保存规则</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, computed, watch } from 'vue'
import facebookApi from '../services/facebookApi'

export default {
  name: 'RuleManager',
  setup() {
    const rules = ref([])
    const showRuleModal = ref(false)
    const editingRuleId = ref(null)
    const running = ref(false)
    
    const levelOptions = [
      { label: '广告 (Ad)', value: 'ad' },
      { label: '广告组 (AdSet)', value: 'adset' },
      { label: '广告系列 (Campaign)', value: 'campaign' }
    ]

    const createEmptyRule = () => ({
      name: '',
      enabled: true,
      isSimulation: false,
      targetLevel: 'ad',
      targetIds: [],
      logicOperator: 'AND',
      timezoneName: 'UTC',
      conditions: [],
      actions: []
    })

    // 表单数据
    const ruleForm = ref(createEmptyRule())
    const accounts = ref([])
    const accountLoading = ref(false)
    const accountError = ref('')
    const selectedAccountId = ref('')
    const scopeItems = ref([])
    const scopeSearch = ref('')
    const scopeLoading = ref(false)
    const scopeReady = ref(false)
    const scopeRequestId = ref(0)

    const normalizeJsonArray = (val) => {
      if (Array.isArray(val)) return val
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }
      return []
    }

    const normalizeRule = (r) => ({
      id: r.id,
      name: r.ruleName || r.name || '',
      enabled: r.enabled !== false,
      conditions: normalizeJsonArray(r.conditions),
      actions: normalizeJsonArray(r.actions),
      targetLevel: r.targetLevel || r.target_level || 'ad',
      targetIds: normalizeJsonArray(r.targetIds || r.target_ids),
      logicOperator: r.logicOperator || r.logic_operator || 'AND',
      timezoneName: r.timezoneName || r.timezone_name || 'UTC',
      isSimulation: r.isSimulation ?? r.is_simulation ?? false
    })

    const loadRules = async () => {
      try {
        const resp = await fetch('/api/rules', { credentials: 'include' })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '获取规则失败')
        rules.value = (data.rules || []).map(normalizeRule)
      } catch (e) {
        alert(`加载规则失败：${e.message}`)
      }
    }

    const loadAccounts = async () => {
      accountLoading.value = true
      accountError.value = ''
      try {
        accounts.value = await facebookApi.getAdAccounts()
      } catch (e) {
        accountError.value = `加载账户失败：${e.message}`
        accounts.value = []
        selectedAccountId.value = ''
        scopeItems.value = []
        ruleForm.value.targetIds = []
      } finally {
        accountLoading.value = false
      }
    }

    // 辅助显示
    const metricLabel = (m) => {
      const map = {
        spend: '花费',
        roas: 'ROAS',
        cpa: 'CPA',
        cpc: 'CPC',
        purchases: '购买次数',
        link_clicks: '链接点击'
      }
      return map[m] || m
    }
    const opLabel = (op) => {
      const map = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=' }
      return map[op] || op
    }
    const actionLabel = (t) => {
      const map = { pause_ad: '暂停广告', activate_ad: '启用广告', increase_budget: '增加预算', decrease_budget: '减少预算' }
      return map[t] || t
    }
    const getActionClass = (type) => {
      if (type === 'pause_ad') return 'danger'
      if (type === 'activate_ad') return 'success'
      return 'primary'
    }

    const timeWindowLabel = (w) => {
      const map = {
        today: '今天',
        yesterday: '昨天',
        last_3_days: '近3天',
        lifetime: '累计'
      }
      return map[w] || w
    }

    const filteredScopeItems = computed(() => {
      const key = String(scopeSearch.value || '').trim().toLowerCase()
      if (!key) return scopeItems.value
      return scopeItems.value.filter(item =>
        String(item.name || '').toLowerCase().includes(key) ||
        String(item.id || '').toLowerCase().includes(key)
      )
    })

    const canSelectAll = computed(() => {
      return scopeReady.value && !scopeLoading.value && filteredScopeItems.value.length > 0
    })

    const selectedTargetPreview = computed(() => {
      return ruleForm.value.targetIds.slice(0, 6)
    })

    // CRUD 操作
    const openCreateRule = () => {
      editingRuleId.value = null
      selectedAccountId.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      ruleForm.value = {
        ...createEmptyRule(),
        conditions: [{ metric: 'spend', operator: 'gt', value: 20, time_window: 'today' }],
        actions: [{ type: 'pause_ad', value: null }]
      }
      showRuleModal.value = true
    }

    const openEditRule = (r) => {
      editingRuleId.value = r.id
      selectedAccountId.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      ruleForm.value = JSON.parse(JSON.stringify({
        name: r.name || '',
        enabled: r.enabled,
        isSimulation: r.isSimulation || false,
        targetLevel: r.targetLevel || 'ad',
        targetIds: r.targetIds || [],
        logicOperator: r.logicOperator || 'AND',
        timezoneName: r.timezoneName || 'UTC',
        conditions: (r.conditions || []).map(c => ({ ...c, time_window: c.time_window || 'today' })),
        actions: r.actions || []
      }))
      showRuleModal.value = true
    }

    const saveRule = () => {
      if (!ruleForm.value.name.trim()) return alert('请输入规则名称')
      if (!ruleForm.value.conditions.length) return alert('请至少添加一个条件')
      if (!ruleForm.value.actions.length) return alert('请至少添加一个动作')

      const payload = {
        ruleName: ruleForm.value.name.trim(),
        conditions: ruleForm.value.conditions,
        actions: ruleForm.value.actions,
        enabled: ruleForm.value.enabled,
        targetLevel: ruleForm.value.targetLevel,
        targetIds: ruleForm.value.targetIds,
        logicOperator: ruleForm.value.logicOperator,
        timezoneName: ruleForm.value.timezoneName,
        isSimulation: ruleForm.value.isSimulation
      }

      const submit = editingRuleId.value
        ? fetch(`/api/rules/${editingRuleId.value}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
          })
        : fetch('/api/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
          })

      submit.then(async (resp) => {
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '保存失败')
        showRuleModal.value = false
        await loadRules()
      }).catch((e) => {
        alert(`保存失败：${e.message}`)
      })
    }

    const deleteRule = (r) => {
      if (!confirm(`确定删除「${r.name}」吗？`)) return
      fetch(`/api/rules/${r.id}`, { method: 'DELETE', credentials: 'include' })
        .then(async (resp) => {
          const data = await resp.json()
          if (!resp.ok) throw new Error(data.error || '删除失败')
          await loadRules()
        })
        .catch((e) => alert(`删除失败：${e.message}`))
    }

    const toggleRule = (r, checked) => {
      fetch(`/api/rules/${r.id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: checked })
      })
        .then(async (resp) => {
          const data = await resp.json()
          if (!resp.ok) throw new Error(data.error || '操作失败')
          await loadRules()
        })
        .catch((e) => alert(`操作失败：${e.message}`))
    }

    const runRulesNow = async () => {
      // 获取当前用户选中的账户ID (需要从 url 或 store 获取，这里简单处理先取第一个)
      // 实际生产中应该让用户选择对哪个账户执行
      const accounts = await facebookApi.getAdAccounts()
      if (!accounts.length) return alert('没有可用的广告账户')
      
      const accountId = accounts[0].id // 暂时逻辑，后续优化
      
      if (!confirm(`即将对账户 ${accounts[0].name} 执行规则，确定吗？`)) return

      running.value = true
      try {
        const res = await facebookApi.executeRules(accountId, rules.value)
        const count = (res?.results || []).filter(x => x.executed).length
        alert(`执行完毕：触发了 ${count} 条规则`)
      } catch (e) {
        alert('执行失败: ' + e.message)
      } finally {
        running.value = false
      }
    }

    const refreshScopeItems = async () => {
      if (!selectedAccountId.value) return
      scopeLoading.value = true
      scopeReady.value = false
      const requestId = ++scopeRequestId.value
      try {
        const level = ruleForm.value.targetLevel
        if (level === 'ad') {
          const ads = await facebookApi.getAds(selectedAccountId.value)
          const list = (ads || []).map(ad => ({
            id: String(ad.id || ''),
            name: ad.name || ad.id || '-'
          })).filter(x => x.id)
          if (requestId !== scopeRequestId.value) return
          scopeItems.value = list
        } else {
          const rows = await facebookApi.getAdInsights(
            selectedAccountId.value,
            { preset: 'last_30d' },
            { level }
          )
          const map = new Map()
          for (const r of rows || []) {
            const id = level === 'adset' ? r.adset_id : r.campaign_id
            const name = level === 'adset' ? r.adset_name : r.campaign_name
            if (!id) continue
            map.set(String(id), { id: String(id), name: name || id })
          }
          if (requestId !== scopeRequestId.value) return
          scopeItems.value = Array.from(map.values())
        }
        scopeReady.value = true
      } catch (e) {
        if (requestId !== scopeRequestId.value) return
        alert(`加载列表失败：${e.message}`)
        scopeItems.value = []
      } finally {
        if (requestId === scopeRequestId.value) {
          scopeLoading.value = false
        }
      }
    }

    const selectAllScope = () => {
      ruleForm.value.targetIds = filteredScopeItems.value.map(item => item.id)
    }

    const clearScopeSelection = () => {
      ruleForm.value.targetIds = []
    }

    watch(selectedAccountId, (val) => {
      if (!val) {
        scopeItems.value = []
        scopeReady.value = false
        ruleForm.value.targetIds = []
        return
      }
      scopeItems.value = []
      scopeReady.value = false
      ruleForm.value.targetIds = []
      refreshScopeItems()
    })

    watch(() => ruleForm.value.targetLevel, () => {
      if (!selectedAccountId.value) return
      scopeItems.value = []
      scopeReady.value = false
      ruleForm.value.targetIds = []
      refreshScopeItems()
    })

    const addCondition = () => {
      ruleForm.value.conditions.push({
        metric: 'spend',
        operator: 'gt',
        value: 0,
        time_window: 'today'
      })
    }

    const addAction = () => {
      ruleForm.value.actions.push({ type: 'pause_ad', value: null })
    }

    const applyTemplate = (type) => {
      if (!confirm('这将覆盖当前条件设置，确定吗？')) return
      if (type === 'stop_loss') {
        ruleForm.value.conditions = [
          { metric: 'spend', operator: 'gt', value: 20, time_window: 'today' },
          { metric: 'roas', operator: 'lt', value: 0.5, time_window: 'today' }
        ]
        ruleForm.value.logicOperator = 'AND'
        ruleForm.value.actions = [{ type: 'pause_ad', value: null }]
      } else if (type === 'scale_up') {
        ruleForm.value.conditions = [
          { metric: 'roas', operator: 'gt', value: 2, time_window: 'last_3_days' }
        ]
        ruleForm.value.logicOperator = 'AND'
        ruleForm.value.actions = [{ type: 'increase_budget', value: 20 }]
      }
    }

    onMounted(async () => {
      await loadAccounts()
      await loadRules()
    })

    return {
      rules, showRuleModal, editingRuleId, ruleForm, running,
      accounts, selectedAccountId, scopeItems, scopeSearch, scopeLoading, scopeReady, filteredScopeItems,
      accountLoading, accountError, loadAccounts,
      canSelectAll, selectedTargetPreview,
      levelOptions,
      loadRules, metricLabel, opLabel, actionLabel, getActionClass, timeWindowLabel,
      openCreateRule, openEditRule, saveRule, deleteRule, toggleRule, runRulesNow,
      refreshScopeItems, selectAllScope, clearScopeSelection,
      addCondition, addAction, applyTemplate
    }
  }
}
</script>

<style scoped>
.rule-page {
  padding-bottom: 40px;
}

/* 免责提示 */
.disclaimer-banner {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 14px;
  line-height: 1.5;
}
.disclaimer-banner .icon { font-size: 18px; }
.muted { color: var(--text-secondary); margin-left: 6px; font-size: 12px; }

.header-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.header-actions h2 { margin: 0; font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 12px; }

/* 卡片网格 */
.rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.rule-card {
  background: #fff;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
}

.rule-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(0,0,0,0.08);
}

.rule-card.disabled {
  opacity: 0.7;
  background: #f9fafb;
}

.card-header {
  padding: 16px;
  border-bottom: 1px solid var(--bg-body);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.rule-name { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }

.card-body {
  padding: 16px;
  flex: 1;
}

.section { margin-bottom: 8px; }
.label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; font-weight: 600; }
.arrow { text-align: center; color: var(--text-secondary); margin: 4px 0; font-size: 12px; }

.pill {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 13px;
  margin: 0 6px 6px 0;
  border: 1px solid transparent;
}

.condition { background: #EAF3FF; color: var(--primary-color); border-color: #D6E4FF; }
.action { font-weight: 600; }
.action.danger { background: #FFF5F5; color: var(--danger-color); border-color: #FED7D7; }
.action.success { background: #F0FFF4; color: var(--secondary-color); border-color: #C6F6D5; }
.val { font-weight: 400; opacity: 0.9; }

.card-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--bg-body);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn-text { background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.btn-text:hover { color: var(--primary-color); text-decoration: underline; }
.btn-text.danger:hover { color: var(--danger-color); }

/* Switch 开关 */
.switch { position: relative; display: inline-block; width: 36px; height: 20px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 20px; }
.slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider { background-color: var(--secondary-color); }
input:checked + .slider:before { transform: translateX(16px); }

/* 空状态 */
.empty-rules { text-align: center; padding: 60px 0; color: var(--text-secondary); }
.empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }

/* 模态框 */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal-content {
  background: #fff; width: 90%; max-width: 600px; border-radius: 12px;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
  animation: slideUp 0.3s ease;
}
.modal-content.wide { max-width: 800px; }
@keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.modal-header { padding: 16px 24px; border-bottom: 1px solid var(--bg-body); display: flex; justify-content: space-between; align-items: center; }
.modal-body { padding: 24px; max-height: 70vh; overflow-y: auto; }
.modal-footer { padding: 16px 24px; border-top: 1px solid var(--bg-body); display: flex; justify-content: flex-end; gap: 12px; }

.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 8px; font-weight: 500; font-size: 14px; }
.input-text { width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; }

.condition-row, .action-row { display: flex; gap: 8px; margin-bottom: 8px; }
.select { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; flex: 1; }
.select.short { flex: 0 0 80px; }
.input-number { width: 80px; padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; }
.placeholder { width: 80px; text-align: center; color: #999; line-height: 36px; }

.btn-icon { width: 36px; height: 36px; border: 1px solid var(--border-color); background: #fff; border-radius: 6px; cursor: pointer; color: #666; }
.btn-icon:hover { background: #f5f5f5; }
.btn-icon.danger { color: var(--danger-color); border-color: #fed7d7; background: #fff5f5; }
.btn-add { width: 100%; border: 1px dashed var(--border-color); background: #fafafa; padding: 8px; border-radius: 6px; color: var(--primary-color); cursor: pointer; font-size: 13px; }
.btn-add:hover { background: #f0f7ff; border-color: var(--primary-color); }

/* 分块布局 */
.section-block {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.section-title {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.form-row { display: flex; gap: 16px; }
.flex-1 { flex: 1; }
.flex-2 { flex: 2; }

.radio-group { display: flex; gap: 16px; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }

.metric-select { width: 140px; }
.window-select { width: 120px; background-color: #f0f9ff; border-color: #bae6fd; color: #0369a1; }
.operator-select { width: 80px; }
.action-select { min-width: 160px; }
.conditions-container { display: flex; flex-direction: column; gap: 6px; }

.btn-tiny {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 8px;
}
.btn-tiny:hover { background: #f0f0f0; color: var(--primary-color); }

.switch-label { margin-left: 8px; font-size: 13px; color: var(--text-secondary); }

.hint { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }
.empty-hint { font-size: 12px; color: var(--text-secondary); margin: 8px 0; }
.loading { font-size: 12px; color: var(--text-secondary); }

.selected-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 8px;
}
.tag {
  background: #eef2ff;
  color: var(--primary-color);
  border: 1px solid #dbeafe;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
}

.scope-list {
  margin-top: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px;
  background: #fff;
}
.scope-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.scope-buttons { display: flex; gap: 8px; }
.scope-items {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.scope-item {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
}
.scope-item:hover { background: #f9fafb; }
.scope-item .name { font-size: 13px; color: var(--text-primary); }
.scope-item .id { font-size: 12px; color: var(--text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>


