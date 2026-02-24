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
          <h3 class="rule-name">
            {{ r.name }}
            <span v-if="r.conditionsVersion === 2" class="badge-dnf">DNF/多组</span>
          </h3>
          <div class="switch-wrapper">
            <label class="switch">
              <input type="checkbox" :checked="r.enabled" @change="toggleRule(r, $event.target.checked)">
              <span class="slider round"></span>
            </label>
          </div>
        </div>

        <div class="card-body">
          <!-- 显示规则作用的账户 -->
          <div v-if="r.accountId" class="section account-info">
            <span class="label">📊 账户:</span>
            <span class="account-id">{{ r.accountId }}</span>
          </div>
          <div class="section">
            <span class="label">IF (当满足以下条件时):</span>
            <div class="conditions-list">
              <div v-for="(c, idx) in r.conditions" :key="idx" class="pill condition">
                <span v-if="r.conditionsVersion === 2 && c._groupIndex" class="muted">组{{ c._groupIndex }}: </span>
                {{ metricLabel(c.metric) }} {{ opLabel(c.operator) }} {{ c.value }}
                <span v-if="c.time_window" class="muted">({{ timeWindowLabel(c.time_window, c) }})</span>
              </div>
            </div>
          </div>

          <div class="arrow">↓</div>

          <div class="section">
            <span class="label">THEN (执行操作):</span>
            <div class="actions-list">
              <div v-for="(a, idx) in r.actions" :key="idx" class="pill action" :class="getActionClass(a.type)">
                {{ actionLabel(a.type) }}
                <span v-if="a.value != null && (a.type === 'increase_budget' || a.type === 'decrease_budget' || a.type === 'set_budget')" class="val">{{ formatBudgetValue(a) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn-text" @click="runThisRule(r)" :disabled="runningRuleId === r.id">
            {{ runningRuleId === r.id ? '执行中...' : '运行此规则' }}
          </button>
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
              <label>广告账户（可多选）</label>
              <div class="form-row">
                <select v-model="accountToAdd" class="select account-add-select" :disabled="accountLoading" @change="onAddAccount">
                  <option value="">添加账户</option>
                  <option v-for="a in accountsFilteredForAdd" :key="a.id" :value="a.id">
                    {{ a.name }} ({{ a.id }})
                  </option>
                </select>
                <button class="btn secondary" @click="loadAccounts" :disabled="accountLoading">
                  {{ accountLoading ? '加载中...' : '刷新账户' }}
                </button>
                <button class="btn secondary" @click="selectAllAccounts" :disabled="accountLoading || !accounts.length">
                  全选账户
                </button>
                <button class="btn secondary" @click="clearAllAccounts" :disabled="!selectedAccountIds.length">
                  清空账户
                </button>
                <button class="btn secondary" @click="refreshScopeItemsWithSync" :disabled="!selectedAccountIds.length || scopeLoading">
                  {{ scopeLoading ? '加载中...' : '刷新列表' }}
                </button>
              </div>
              <div v-if="selectedAccountIds.length" class="selected-accounts-tags">
                <span v-for="aid in selectedAccountIds" :key="aid" class="tag account-tag">
                  {{ accountLabel(aid) }}
                  <button type="button" class="tag-remove" aria-label="移除" @click="removeAccount(aid)">×</button>
                </span>
              </div>
              <div class="hint">仅展示你有权限的账户；多选后下方列表为多账户合并结果</div>
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
              <div class="scope-filters">
                <input
                  v-model="scopeSearch"
                  class="input-text"
                  placeholder="搜索名称或ID"
                />
                <label class="scope-status-filter">
                  <span class="scope-status-label">状态</span>
                  <select v-model="scopeIncludePaused" class="select scope-status-select" @change="onScopeStatusChange">
                    <option :value="false">仅启用</option>
                    <option :value="true">包含暂停</option>
                  </select>
                </label>
              </div>
              <div v-if="!selectedAccountIds.length" class="empty-hint">请先选择至少一个广告账户</div>
              <div v-else class="scope-list">
                <div class="scope-actions">
                  <span>已选 {{ ruleForm.targetIds.length }} 个</span>
                  <div class="scope-buttons">
                    <button class="btn-tiny" @click="selectAllScope" :disabled="!canSelectAll">全选</button>
                    <button class="btn-tiny" @click="clearScopeSelection" :disabled="!ruleForm.targetIds.length">清空</button>
                  </div>
                </div>
                <div v-if="ruleForm.targetIds.length" class="selected-preview">
                  <span v-for="id in selectedTargetPreview" :key="id" class="tag" :class="{ 'tag-missing': resolvedSelectedMap.get(String(id))?.missing }">
                    <span v-if="resolvedSelectedMap.get(String(id))?.name">
                      {{ resolvedSelectedMap.get(String(id)).name }}
                    </span>
                    <span v-else-if="resolvedSelectedMap.get(String(id))?.missing">{{ id }} (未同步)</span>
                    <span v-else>{{ id }}</span>
                  </span>
                  <span v-if="ruleForm.targetIds.length > selectedTargetPreview.length" class="muted">
                    还有 {{ ruleForm.targetIds.length - selectedTargetPreview.length }} 个
                  </span>
                </div>
                <div v-if="missingSelectedCount > 0" class="hint">
                  注意：有 {{ missingSelectedCount }} 个已选对象未出现在当前列表中（可能未加载到当前页或已被删除），但仍会保留在规则里。
                </div>
                <div v-if="scopeLoading" class="loading">正在加载列表...</div>
                <div v-else-if="!filteredScopeItems.length" class="empty-hint">暂无可选对象</div>
                <div v-else class="scope-items">
                  <label v-for="item in filteredScopeItems" :key="scopeItemKey(item)" class="scope-item">
                    <input type="checkbox" :value="scopeItemValue(item)" v-model="ruleForm.targetIds">
                    <span class="name">{{ item.name || '-' }}</span>
                    <span class="id">{{ item.id }}</span>
                    <span v-if="selectedAccountIds.length > 1" class="account-badge">{{ item.account_id || '' }}</span>
                  </label>
                </div>
                <div v-if="scopePagingAfter && selectedAccountIds.length <= 1" class="scope-more">
                  <button class="btn-tiny" @click="loadMoreScopeItems" :disabled="scopeLoading">
                    {{ scopeLoading ? '加载中...' : '加载更多' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块3：触发条件（2.3.1 方案B：线性列表 + 全局时间窗口） -->
          <div class="section-block">
            <div class="section-header">
              <h4 class="section-title">3. 触发条件 (When)</h4>
              <div class="template-actions">
                <button
                  v-for="t in templates"
                  :key="t.id"
                  class="btn-tiny"
                  @click="applyTemplate(t)"
                >
                  {{ t.name }}
                </button>
              </div>
            </div>
            <div class="hint" style="margin-bottom: 12px;">本规则所有条件共用同一时间窗口</div>

            <!-- 比值类指标口径提示（TASKS 2.3 前端口径防呆） -->
            <div v-if="ratioMetricTip" class="ratio-tip">
              <span class="icon">💡</span>
              <span v-html="ratioMetricTip"></span>
              <button
                v-if="zeroClickTemplate"
                type="button"
                class="btn-tiny"
                @click="applyTemplate(zeroClickTemplate)"
              >
                改用空耗模板
              </button>
            </div>

            <!-- 全局时间窗口 -->
            <div class="form-group">
              <label>时间窗口</label>
              <div class="when-time-row">
                <select v-model="whenTimeWindow" class="select window-select" @change="onWhenTimeWindowChange">
                  <option value="today">今天</option>
                  <option value="yesterday">昨天</option>
                  <option value="last_3_days">近3天</option>
                  <option value="lifetime">累计</option>
                  <option value="custom_range">自定义范围</option>
                </select>
                <template v-if="whenTimeWindow === 'custom_range'">
                  <input
                    type="date"
                    v-model="(whenCustomRange ||= getDefaultWhenCustomRange()).since"
                    class="input-date"
                    title="起始日期"
                  />
                  <span class="date-sep">至</span>
                  <input
                    type="date"
                    v-model="(whenCustomRange ||= getDefaultWhenCustomRange()).until"
                    class="input-date"
                    title="截止日期"
                  />
                </template>
              </div>
            </div>

            <!-- 线性条件列表：第2行起显示 AND/OR -->
            <div class="conditions-container">
              <div v-for="(line, idx) in whenLines" :key="idx" class="condition-row when-line-row">
                <select
                  v-if="idx > 0"
                  v-model="line.join"
                  class="select join-select"
                  title="与上一条件的逻辑关系"
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
                <span v-else class="join-placeholder"></span>
                <select v-model="line.metric" class="select metric-select">
                  <option value="spend">花费</option>
                  <option value="roas">ROAS</option>
                  <option value="cpa">单次购买花费（CPA）</option>
                  <option value="cpc">CPC（花费/链接点击）</option>
                  <option value="add_to_cart_cost">单次加购花费</option>
                  <option value="checkout_cost">单次结账花费</option>
                  <option value="payment_cost">单次添加支付信息花费</option>
                  <option value="purchases">购买次数</option>
                  <option value="link_clicks">链接点击</option>
                  <option value="add_to_cart_count">加购次数</option>
                  <option value="initiate_checkout_count">结账次数</option>
                  <option value="add_payment_info_count">添加支付信息次数</option>
                </select>
                <select v-model="line.operator" class="select operator-select">
                  <option value="gt">大于 (>)</option>
                  <option value="lt">小于 (<)</option>
                  <option value="gte">大于等于 (≥)</option>
                  <option value="lte">小于等于 (≤)</option>
                  <option value="eq">等于 (=)</option>
                </select>
                <input type="number" v-model.number="line.value" class="input-number" step="0.01" />
                <button class="btn-icon danger" @click="removeWhenLine(idx)" title="删除">×</button>
              </div>
              <button class="btn-add" @click="addWhenLine">+ 添加条件</button>
            </div>
          </div>

          <!-- 区块4：执行动作 -->
          <div class="section-block">
            <h4 class="section-title">4. 执行动作 (Then)</h4>
            <p v-if="hasBudgetAction" class="cbo-hint">
              💡 若规则作用对象属于 <strong>CBO（优势+系列预算）</strong>，执行增减预算时将调整整个广告系列预算，影响该系列下所有广告组。
            </p>
            <div v-for="(a, idx) in ruleForm.actions" :key="idx" class="action-row">
              <select v-model="a.type" class="select action-select" @change="onActionTypeChange(a)">
                <option value="pause_ad">⏸ 暂停广告</option>
                <option value="activate_ad">▶️ 启用广告</option>
                <option value="increase_budget">💰 增加预算</option>
                <option value="decrease_budget">💸 减少预算</option>
                <option value="set_budget">📌 设置预算为固定值</option>
              </select>
              <template v-if="a.type.includes('budget')">
                <select v-if="a.type !== 'set_budget'" v-model="a.value_unit" class="select action-unit-select" title="调整单位">
                  <option value="percent">百分比</option>
                  <option value="usd">固定金额</option>
                </select>
                <input
                  v-if="a.type === 'set_budget'"
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="30"
                  min="0.01"
                  max="9999"
                  step="0.01"
                />
                <input
                  v-else-if="(a.value_unit || 'percent') === 'percent'"
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="10"
                  min="1"
                  max="100"
                  step="1"
                />
                <input
                  v-else
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="5"
                  min="0.01"
                  max="9999"
                  step="0.01"
                />
                <span class="action-unit">{{ a.type === 'set_budget' || (a.value_unit || 'percent') === 'usd' ? '$' : '%' }}</span>
                <span class="action-hint">{{ a.type === 'set_budget' ? '（设置为固定美元）' : ((a.value_unit || 'percent') === 'usd' ? '（按美元增减）' : '（按百分比增减）') }}</span>
                <label class="budget-cap-label">预算上限（美元，可选）</label>
                <input
                  type="number"
                  :value="a.max_daily_budget != null ? (a.max_daily_budget / 100) : ''"
                  @input="onMaxBudgetInput($event, a)"
                  class="input-number budget-cap-input"
                  placeholder="不填则不限制"
                  min="1"
                  step="0.01"
                />
              </template>
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
import { authFetch } from '../utils/authFetch.js'
import facebookApi from '../services/facebookApi'
import {
  linesToV2Groups,
  v2ToLines,
  v1ToLines,
  createDefaultWhenLine,
  getDefaultWhenCustomRange
} from '../utils/conditionsTransform'

export default {
  name: 'RuleManager',
  setup() {
    const rules = ref([])
    const templates = ref([])
    const showRuleModal = ref(false)
    const editingRuleId = ref(null)
    const running = ref(false)
    const runningRuleId = ref(null)
    
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
    const selectedAccountIds = ref([])
    const accountToAdd = ref('') // 用于「添加账户」下拉，选完后加入 selectedAccountIds 并清空
    const scopeItems = ref([])
    const scopeSearch = ref('')
    const scopeIncludePaused = ref(false)  // 状态筛选：false=仅启用，true=包含暂停
    const scopeLoading = ref(false)
    const scopeReady = ref(false)
    const scopeRequestId = ref(0)
    const scopePagingAfter = ref(null)
    const resolvedSelectedMap = ref(new Map()) // id -> {id,name,...}
    // 2.3.1 方案B：线性条件列表状态（全局时间窗口 + whenLines）
    const whenLines = ref([])            // [{ join, metric, operator, value }]，首行 join=null
    const whenTimeWindow = ref('today')  // 全局 time_window
    const whenCustomRange = ref(null)    // { since, until } | null

    const isEditing = computed(() => !!editingRuleId.value)
    const hasBudgetAction = computed(() =>
      (ruleForm.actions || []).some(a => a.type === 'increase_budget' || a.type === 'decrease_budget'))
    const zeroClickTemplate = computed(() => templates.value.find(t => t.slug === 'zero_click') || null)

    // v2 DNF 工具函数
    const parseJson = (val) => {
      if (typeof val === 'string') {
        try { return JSON.parse(val) } catch { return null }
      }
      return val
    }
    const isV2Conditions = (x) =>
      x && typeof x === 'object' && x.version === 2 && Array.isArray(x.groups)
    const flattenV2Conditions = (v2) => {
      if (!v2?.groups) return []
      const list = []
      for (let i = 0; i < v2.groups.length; i++) {
        for (const c of v2.groups[i]?.conditions || []) {
          list.push({ ...c, _groupIndex: i + 1 })
        }
      }
      return list
    }

    const ensureWhenLinesNonEmpty = () => {
      if (!whenLines.value.length) {
        whenLines.value = [createDefaultWhenLine(null)]
      }
    }

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

    const normalizeRule = (r) => {
      const raw = parseJson(r.conditions)
      const isV2 = isV2Conditions(raw)
      return {
        id: r.id,
        name: r.ruleName || r.name || '',
        enabled: r.enabled !== false,
        conditionsRaw: raw,
        conditionsVersion: isV2 ? 2 : 1,
        conditions: isV2 ? flattenV2Conditions(raw) : normalizeJsonArray(r.conditions),
        actions: normalizeJsonArray(r.actions),
        targetLevel: r.targetLevel || r.target_level || 'ad',
        targetIds: normalizeJsonArray(r.targetIds || r.target_ids),
        targetAccountIds: Array.isArray(r.targetAccountIds) ? r.targetAccountIds : (Array.isArray(r.target_account_ids) ? r.target_account_ids : null),
        targetByAccount: r.targetByAccount != null && typeof r.targetByAccount === 'object' ? r.targetByAccount : (r.target_by_account != null && typeof r.target_by_account === 'object' ? r.target_by_account : null),
        logicOperator: r.logicOperator || r.logic_operator || 'AND',
        timezoneName: r.timezoneName || r.timezone_name || 'UTC',
        isSimulation: r.isSimulation ?? r.is_simulation ?? false,
        accountId: r.accountId || r.account_id || ''
      }
    }

    const loadTemplates = async () => {
      try {
        const resp = await authFetch('/api/templates')
        const data = await resp.json()
        templates.value = data.templates || []
      } catch {
        templates.value = []
      }
    }

    const loadRules = async () => {
      try {
        const resp = await authFetch('/api/rules')
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
        selectedAccountIds.value = []
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
        cpa: '单次购买花费（CPA）',
        cpc: 'CPC（花费/链接点击）',
        add_to_cart_cost: '单次加购花费',
        checkout_cost: '单次结账花费',
        payment_cost: '单次添加支付信息花费',
        purchases: '购买次数',
        link_clicks: '链接点击',
        add_to_cart_count: '加购次数',
        initiate_checkout_count: '结账次数',
        add_payment_info_count: '添加支付信息次数'
      }
      return map[m] || m
    }
    const opLabel = (op) => {
      const map = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=' }
      return map[op] || op
    }
    const actionLabel = (t) => {
      const map = { pause_ad: '暂停广告', activate_ad: '启用广告', increase_budget: '增加预算', decrease_budget: '减少预算', set_budget: '设置预算' }
      return map[t] || t
    }
    const getActionClass = (type) => {
      if (type === 'pause_ad') return 'danger'
      if (type === 'activate_ad') return 'success'
      return 'primary'
    }

    const timeWindowLabel = (w, c) => {
      const map = {
        today: '今天',
        yesterday: '昨天',
        last_3_days: '近3天',
        lifetime: '累计',
        custom_range: '自定义'
      }
      const base = map[w] || w
      if (w === 'custom_range' && c?.custom_range?.since) {
        const { since, until } = c.custom_range
        return until && since !== until ? `${base}(${since}~${until})` : `${base}(${since})`
      }
      return base
    }

    const filteredScopeItems = computed(() => {
      const key = String(scopeSearch.value || '').trim().toLowerCase()
      if (!key) return scopeItems.value
      return scopeItems.value.filter(item =>
        String(item.name || '').toLowerCase().includes(key) ||
        String(item.id || '').toLowerCase().includes(key)
      )
    })

    /** 多选时用 account_id:id 作为唯一键与表单值；单选时用 id（兼容旧逻辑） */
    const scopeItemKey = (item) => selectedAccountIds.value.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id
    const scopeItemValue = (item) => selectedAccountIds.value.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id

    /** 未选中的账户（供「添加账户」下拉用） */
    const accountsFilteredForAdd = computed(() => {
      const set = new Set(selectedAccountIds.value)
      return accounts.value.filter(a => !set.has(a.id))
    })

    const canSelectAll = computed(() => {
      return scopeReady.value && !scopeLoading.value && filteredScopeItems.value.length > 0
    })

    const selectedTargetPreview = computed(() => {
      return ruleForm.value.targetIds.slice(0, 6)
    })

    const missingSelectedCount = computed(() => {
      const set = new Set(scopeItems.value.map(x => scopeItemValue(x)))
      return ruleForm.value.targetIds.filter(id => !set.has(String(id))).length
    })

    /** 比值类指标口径提示：cpc/ucpc/cpa/roas 需搭配分母条件，否则为 null（TASKS 2.3 前端口径防呆） */
    const ratioMetricTip = computed(() => {
      const lines = whenLines.value || []
      const hasPositiveDenominator = (denomMetric) =>
        lines.some(l => {
          const m = String(l.metric || '').trim()
          const op = String(l.operator || '').trim()
          const v = Number(l.value)
          if (m !== denomMetric) return false
          // “> 0 / >= 1 / = 1+” 都算正分母约束
          if (op === 'gt') return !Number.isNaN(v) && v >= 0
          if (op === 'gte') return !Number.isNaN(v) && v >= 1
          if (op === 'eq') return !Number.isNaN(v) && v >= 1
          return false
        })
      const missing = []
      const hasMetric = (key) => lines.some(l => String(l.metric || '').trim() === key)
      if (lines.some(l => ['cpc', 'ucpc'].includes(String(l.metric || '').trim())) && !hasPositiveDenominator('link_clicks')) {
        missing.push('CPC/独立CPC 需要有点击才有意义，建议加条件：<strong>链接点击 &gt; 0</strong>（<strong>link_clicks &gt; 0</strong>）')
      }
      if (hasMetric('cpa') && !hasPositiveDenominator('purchases')) {
        missing.push('单次购买花费（CPA）需要有购买才有意义，建议加条件：<strong>购买次数 &gt; 0</strong>（<strong>purchases &gt; 0</strong>）')
      }
      if (hasMetric('roas') && !hasPositiveDenominator('spend')) {
        missing.push('ROAS 需要有花费才有意义，建议加条件：<strong>花费 &gt; 0</strong>（<strong>spend &gt; 0</strong>）')
      }
      if (hasMetric('add_to_cart_cost') && !hasPositiveDenominator('add_to_cart_count')) {
        missing.push('单次加购花费需要有加购才有意义，建议加条件：<strong>加购次数 &gt; 0</strong>（<strong>add_to_cart_count &gt; 0</strong>）')
      }
      if (hasMetric('checkout_cost') && !hasPositiveDenominator('initiate_checkout_count')) {
        missing.push('单次结账花费需要有结账才有意义，建议加条件：<strong>结账次数 &gt; 0</strong>（<strong>initiate_checkout_count &gt; 0</strong>）')
      }
      if (hasMetric('payment_cost') && !hasPositiveDenominator('add_payment_info_count')) {
        missing.push('单次添加支付信息花费需要有“添加支付信息”才有意义，建议加条件：<strong>添加支付信息次数 &gt; 0</strong>（<strong>add_payment_info_count &gt; 0</strong>）')
      }
      if (missing.length === 0) return null
      return `当分母为 0 时，上述比值/单次成本指标会为空，规则不会触发。${missing.join('；')}。`
    })

    // CRUD 操作
    const openCreateRule = () => {
      editingRuleId.value = null
      selectedAccountIds.value = []
      accountToAdd.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      scopePagingAfter.value = null
      resolvedSelectedMap.value = new Map()
      ruleForm.value = {
        ...createEmptyRule(),
        actions: [{ type: 'pause_ad', value: null }]
      }
      whenLines.value = [createDefaultWhenLine(null)]
      whenTimeWindow.value = 'today'
      whenCustomRange.value = null
      loadTemplates()
      showRuleModal.value = true
    }

    /** 兜底归一化：加载时若 max_daily_budget < 100 分则清空（旧数据/手工改库/脚本导入） */
    const normalizeInvalidMaxBudget = (actions) => {
      let n = 0
      for (const a of actions || []) {
        if (a?.max_daily_budget != null && Number(a.max_daily_budget) < 100) {
          a.max_daily_budget = undefined
          n++
        }
      }
      return n
    }

    /** 从 targetIds 中解析出所有出现过的账户 ID（支持 "act_xxx:id" 格式），用于编辑时回填多账户 */
    const parseAccountIdsFromTargetIds = (targetIds, fallbackAccountId) => {
      const set = new Set()
      if (fallbackAccountId) set.add(fallbackAccountId)
      for (const id of targetIds || []) {
        const s = String(id).trim()
        if (s.includes(':')) {
          const acc = s.split(':')[0].trim()
          if (acc) set.add(acc)
        }
      }
      return [...set]
    }

    const openEditRule = (r) => {
      editingRuleId.value = r.id
      // 多账户：优先用后端返回的 target_account_ids；否则从 targetIds（act_xxx:id）解析
      const accountIds = (r.targetAccountIds && r.targetAccountIds.length) ? r.targetAccountIds : parseAccountIdsFromTargetIds(r.targetIds || [], r.accountId || '')
      selectedAccountIds.value = accountIds
      accountToAdd.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      scopePagingAfter.value = null

      ruleForm.value = JSON.parse(JSON.stringify({
        name: r.name || '',
        enabled: r.enabled,
        isSimulation: r.isSimulation || false,
        targetLevel: r.targetLevel || 'ad',
        targetIds: r.targetIds || [],
        logicOperator: r.logicOperator || 'AND',
        timezoneName: r.timezoneName || 'UTC',
        actions: r.actions || []
      }))
      const normalizedCount = normalizeInvalidMaxBudget(ruleForm.value.actions)
      if (normalizedCount > 0) {
        console.info(`[规则编辑] 已自动清空 ${normalizedCount} 个无效的预算上限（<1美元）`)
      }

      if (r.conditionsVersion === 2) {
        const { lines, timeWindow, customRange } = v2ToLines(r.conditionsRaw || { version: 2, groups: [] })
        whenLines.value = lines.length ? lines : [createDefaultWhenLine(null)]
        whenTimeWindow.value = timeWindow
        whenCustomRange.value = customRange
      } else {
        const { lines, timeWindow, customRange } = v1ToLines(r.conditions || [], r.logicOperator || 'AND')
        whenLines.value = lines.length ? lines : [createDefaultWhenLine(null)]
        whenTimeWindow.value = timeWindow
        whenCustomRange.value = customRange
      }
      // 回显：已选对象解析成可读标签。targetIds 可能为 "act_xxx:id"，后端 resolve 只认纯 id，故只传 id 部分
      resolvedSelectedMap.value = new Map()
      if (ruleForm.value.targetIds?.length) {
        const rawIds = ruleForm.value.targetIds
        const idParts = rawIds.map(id => {
          const s = String(id)
          const idx = s.indexOf(':')
          return idx >= 0 ? s.slice(idx + 1) : s
        })
        const uniqueIdParts = [...new Set(idParts)]
        facebookApi.resolveObjectsByIds(uniqueIdParts)
          .then((items) => {
            const idToItem = new Map()
            for (const it of items || []) idToItem.set(String(it.id), it)
            const m = new Map()
            for (const targetId of rawIds) {
              const key = String(targetId)
              const idPart = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
              const item = idToItem.get(idPart)
              m.set(key, item ? { ...item, id: idPart } : { id: idPart, missing: true })
            }
            resolvedSelectedMap.value = m
          })
          .catch(() => {})
      }
      loadTemplates()
      showRuleModal.value = true
    }

    /** 动作类型切换：预算类时设置默认 value_unit、value */
    const onActionTypeChange = (a) => {
      if (a.type === 'set_budget') {
        a.value_unit = 'usd'
        if (a.value == null || a.value === '' || a.value < 0.01) a.value = 30
      } else if (a.type?.includes('budget')) {
        a.value_unit = a.value_unit || 'percent'
        if (a.value_unit === 'percent' && (a.value == null || a.value === '')) a.value = 10
      }
    }

    const saveRule = () => {
      if (!ruleForm.value.name.trim()) return alert('请输入规则名称')
      if (!selectedAccountIds.value?.length) return alert('请至少选择一个广告账户')
      if (!ruleForm.value.actions.length) return alert('请至少添加一个动作')
      for (const a of ruleForm.value.actions) {
        if (a.type === 'set_budget') {
          const v = Number(a.value)
          if (a.value == null || a.value === '' || !Number.isFinite(v) || v < 0.01 || v > 9999) {
            return alert('设置预算请填写 0.01–9999 的数值（美元）')
          }
          if (Math.abs(v * 100 - Math.round(v * 100)) >= 1e-6) {
            return alert('设置预算金额最多两位小数')
          }
        } else if (a.type?.includes('budget')) {
          const unit = a.value_unit || 'percent'
          if (unit === 'usd') {
            const v = Number(a.value)
            if (a.value == null || a.value === '' || !Number.isFinite(v) || v < 0.01 || v > 9999) {
              return alert('固定金额模式下请填写 0.01–9999 的数值')
            }
            if (Math.abs(v * 100 - Math.round(v * 100)) >= 1e-6) {
              return alert('固定金额最多两位小数')
            }
          } else {
            const v = Number(a.value)
            if (a.value == null || a.value === '' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 100) {
              return alert('百分比模式下 value 须为 1–100 的整数')
            }
          }
        }
      }
      ensureWhenLinesNonEmpty()
      if (!whenLines.value.length) return alert('请至少添加一个条件')

      if (whenTimeWindow.value === 'custom_range') {
        const cr = whenCustomRange.value
        if (!cr?.since || !cr?.until) return alert('自定义范围请填写起始和截止日期')
        if (cr.since > cr.until) return alert('起始日期不能晚于截止日期')
      }

      const conditionsPayload = linesToV2Groups(
        whenLines.value,
        whenTimeWindow.value,
        whenTimeWindow.value === 'custom_range' ? whenCustomRange.value : null
      )

      const actionsPayload = (ruleForm.value.actions || []).map(a => {
        const out = { type: a.type, value: a.value }
        if (a.type === 'set_budget') {
          out.value_unit = 'usd'
          if (a.max_daily_budget != null) out.max_daily_budget = a.max_daily_budget
        } else if (a.type?.includes('budget')) {
          out.value_unit = a.value_unit || 'percent'
          if (a.max_daily_budget != null) out.max_daily_budget = a.max_daily_budget
        }
        return out
      })
      // 方案 B：按账户分组目标 ID，供后端 target_by_account 落库与执行按账户取
      const ids = ruleForm.value.targetIds || []
      const byAccount = {}
      const accountSet = new Set(selectedAccountIds.value)
      for (const id of ids) {
        const s = String(id).trim()
        if (s.includes(':')) {
          const acc = s.split(':')[0].trim()
          const idPart = s.slice(s.indexOf(':') + 1)
          if (acc && idPart) {
            if (!byAccount[acc]) byAccount[acc] = []
            byAccount[acc].push(idPart)
          }
        } else if (accountSet.size > 0) {
          const acc = selectedAccountIds.value[0]
          if (!byAccount[acc]) byAccount[acc] = []
          byAccount[acc].push(s)
        }
      }
      const payload = {
        ruleName: ruleForm.value.name.trim(),
        accountId: selectedAccountIds.value[0],
        conditions: conditionsPayload,
        actions: actionsPayload,
        enabled: ruleForm.value.enabled,
        targetLevel: ruleForm.value.targetLevel,
        targetIds: ruleForm.value.targetIds,
        targetAccounts: selectedAccountIds.value,
        target_by_account: Object.keys(byAccount).length ? byAccount : null,
        logicOperator: ruleForm.value.logicOperator,
        timezoneName: ruleForm.value.timezoneName,
        isSimulation: ruleForm.value.isSimulation
      }

      const submit = editingRuleId.value
        ? authFetch(`/api/rules/${editingRuleId.value}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
        : authFetch('/api/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
      authFetch(`/api/rules/${r.id}`, { method: 'DELETE' })
        .then(async (resp) => {
          const data = await resp.json()
          if (!resp.ok) throw new Error(data.error || '删除失败')
          await loadRules()
        })
        .catch((e) => alert(`删除失败：${e.message}`))
    }

    const toggleRule = (r, checked) => {
      authFetch(`/api/rules/${r.id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
      // 使用离线查询模式执行规则（从数据库查询，不调用 Facebook API）
      if (!confirm('即将执行所有启用的规则（离线查询模式），确定吗？')) return

      running.value = true
      try {
        const res = await facebookApi.executeAllRulesOffline()
        alert(res?.message || '已触发规则执行，请查看执行日志页面查看结果')
      } catch (e) {
        if (e.response?.data?.code === 'ALREADY_RUNNING') {
          alert('规则正在执行中，请稍后再试')
        } else {
          alert('执行失败: ' + (e.response?.data?.error || e.message))
        }
      } finally {
        running.value = false
      }
    }

    const runThisRule = async (r) => {
      if (!confirm(`确定立即执行规则「${r.name}」吗？`)) return
      runningRuleId.value = r.id
      try {
        const res = await facebookApi.executeRuleById(r.id)
        const msg = res.success
          ? `已执行。匹配 ${res.matched_count ?? 0} 个，执行成功 ${res.executed_count ?? 0}，失败 ${res.failed_count ?? 0}。`
          : (res.message || '执行完成')
        alert(msg)
      } catch (e) {
        const code = e.response?.data?.code
        const err = e.response?.data?.error || e.message
        if (code === 'ALREADY_RUNNING' || code === 'ACCOUNT_LOCKED') {
          alert('该账户规则正在执行中，请稍后再试')
        } else if (e.response?.status === 403) {
          alert('无权执行该规则')
        } else if (e.response?.status === 404) {
          alert('规则不存在或无权访问')
        } else {
          alert('执行失败: ' + err)
        }
      } finally {
        runningRuleId.value = null
      }
    }

    const refreshScopeItemsWithSync = async () => {
      if (!selectedAccountIds.value?.length) return
      scopeLoading.value = true
      try {
        if (selectedAccountIds.value.length === 1) {
          await facebookApi.syncStructure(selectedAccountIds.value[0])
        }
        await refreshScopeItems()
        // 刷新列表后重新解析已选对象，补齐 missing（验证5）
        if (ruleForm.value.targetIds?.length) {
          const items = await facebookApi.resolveObjectsByIds(ruleForm.value.targetIds).catch(() => [])
          const m = new Map()
          for (const it of items || []) m.set(String(it.id), it)
          resolvedSelectedMap.value = m
        }
      } catch (e) {
        const status = e.response?.status
        const data = e.response?.data
        if (status === 429 && data?.reason === 'cooldown') {
          const sec = data?.retry_after_sec ?? 120
          alert(`冷却中，请 ${sec} 秒后再试`)
        } else if (status === 429 && (data?.reason === 'quota_high' || data?.reason === 'fb_rate_limited')) {
          const sec = data?.retry_after_sec ?? 3600
          alert(`API 调用已达上限/使用率过高，请 ${sec} 秒后再试`)
        } else if (status === 409 && data?.reason === 'lock_busy') {
          alert('同步进行中，请稍后重试')
        } else {
          alert(`同步失败：${data?.error || e.message}`)
        }
      } finally {
        scopeLoading.value = false
      }
    }

    const refreshScopeItems = async () => {
      if (!selectedAccountIds.value?.length) return
      scopeLoading.value = true
      scopeReady.value = false
      const requestId = ++scopeRequestId.value
      const ids = selectedAccountIds.value
      const level = ruleForm.value.targetLevel
      const type = level
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      const keyword = String(scopeSearch.value || '').trim()
      const isIdSearch = /^\d{10,}$/.test(keyword)
      try {
        if (ids.length === 1) {
          const promises = [
            facebookApi.getStructureObjects(levelKey, ids[0], {
              q: keyword,
              limit: 50,
              after: null,
              include_paused: scopeIncludePaused.value
            })
          ]
          if (isIdSearch) promises.push(facebookApi.resolveObjectsByIds(keyword).catch(() => []))
          const results = await Promise.all(promises)
          if (requestId !== scopeRequestId.value) return
          let items = results[0]?.items || []
          if (isIdSearch && results[1]?.length > 0) {
            const existingIds = new Set(items.map(it => String(it.id)))
            for (const resolved of results[1]) {
              if (!existingIds.has(String(resolved.id))) items = [resolved, ...items]
            }
          }
          scopeItems.value = items
          scopePagingAfter.value = results[0]?.paging?.after ?? null
        } else {
          const result = await facebookApi.getStructureObjectsMulti(type, ids, {
            q: keyword,
            limit: 50,
            after: null,
            include_paused: scopeIncludePaused.value
          })
          if (requestId !== scopeRequestId.value) return
          scopeItems.value = result.items || []
          scopePagingAfter.value = result.paging?.after ?? null
        }
        // 「仅启用」时：已选目标中只保留当前列表中的项（当前列表=仅 ACTIVE），避免保留之前「包含暂停」时选的已关闭广告
        if (!scopeIncludePaused.value && scopeItems.value.length > 0) {
          const multi = selectedAccountIds.value.length > 1
          const allowedSet = new Set(scopeItems.value.map(it => multi ? `${it.account_id || ''}:${it.id}` : String(it.id)))
          ruleForm.value.targetIds = ruleForm.value.targetIds.filter(id => allowedSet.has(String(id)))
        }
        scopeReady.value = true
      } catch (e) {
        if (requestId !== scopeRequestId.value) return
        alert(`加载列表失败：${e.message}`)
        scopeItems.value = []
        scopePagingAfter.value = null
      } finally {
        if (requestId === scopeRequestId.value) scopeLoading.value = false
      }
    }

    const loadMoreScopeItems = async () => {
      const ids = selectedAccountIds.value
      if (!ids?.length || !scopePagingAfter.value) return
      if (ids.length > 1) return // 多账户时后端暂未实现 after，不展示加载更多
      scopeLoading.value = true
      const requestId = ++scopeRequestId.value
      try {
        const level = ruleForm.value.targetLevel
        const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
        const resp = await facebookApi.getStructureObjects(levelKey, ids[0], {
          q: String(scopeSearch.value || '').trim(),
          limit: 50,
          after: scopePagingAfter.value,
          include_paused: scopeIncludePaused.value
        })
        if (requestId !== scopeRequestId.value) return
        scopeItems.value = [...scopeItems.value, ...(resp.items || [])]
        scopePagingAfter.value = resp?.paging?.after || null
        scopeReady.value = true
      } catch (e) {
        if (requestId !== scopeRequestId.value) return
        alert(`加载更多失败：${e.message}`)
      } finally {
        if (requestId === scopeRequestId.value) scopeLoading.value = false
      }
    }

    const selectAllScope = () => {
      ruleForm.value.targetIds = filteredScopeItems.value.map(item => scopeItemValue(item))
    }

    const clearScopeSelection = () => {
      ruleForm.value.targetIds = []
    }

    const onScopeStatusChange = () => {
      refreshScopeItems()
    }

    const onAddAccount = (e) => {
      const v = e?.target?.value
      if (!v) return
      if (!selectedAccountIds.value.includes(v)) selectedAccountIds.value = [...selectedAccountIds.value, v]
      accountToAdd.value = ''
    }
    const removeAccount = (aid) => {
      selectedAccountIds.value = selectedAccountIds.value.filter(id => id !== aid)
    }
    const selectAllAccounts = () => {
      selectedAccountIds.value = accounts.value.map(a => a.id)
    }
    const clearAllAccounts = () => {
      selectedAccountIds.value = []
    }
    const accountLabel = (aid) => {
      const a = accounts.value.find(x => x.id === aid)
      return a ? `${a.name} (${aid})` : aid
    }

    watch(selectedAccountIds, (val) => {
      if (!val?.length) {
        scopeItems.value = []
        scopeReady.value = false
        scopePagingAfter.value = null
        if (!isEditing.value) ruleForm.value.targetIds = []
        return
      }
      scopeItems.value = []
      scopeReady.value = false
      scopePagingAfter.value = null
      if (!isEditing.value) ruleForm.value.targetIds = []
      refreshScopeItems()
    }, { deep: true })

    watch(() => ruleForm.value.targetLevel, () => {
      if (!selectedAccountIds.value?.length) return
      scopeItems.value = []
      scopeReady.value = false
      scopePagingAfter.value = null
      // 切换层级：新建规则清空；编辑规则保留并提示“可能有失效对象”
      if (!isEditing.value) ruleForm.value.targetIds = []
      refreshScopeItems()
    })

    // 输入搜索词时改为“服务端搜索”（避免只在当前页过滤）
    let searchTimer = null
    watch(scopeSearch, () => {
      if (!selectedAccountIds.value?.length) return
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        scopeItems.value = []
        scopeReady.value = false
        scopePagingAfter.value = null
        refreshScopeItems()
      }, 300)
    })

    const todayYMD = () => {
      const d = new Date()
      return d.toISOString().slice(0, 10)
    }

    const onWhenTimeWindowChange = () => {
      if (whenTimeWindow.value === 'custom_range' && !whenCustomRange.value) {
        whenCustomRange.value = getDefaultWhenCustomRange()
      }
    }

    const addWhenLine = () => {
      const join = whenLines.value.length === 0 ? null : 'AND'
      whenLines.value.push(createDefaultWhenLine(join))
    }

    const removeWhenLine = (idx) => {
      whenLines.value.splice(idx, 1)
      ensureWhenLinesNonEmpty()
    }

    const addAction = () => {
      ruleForm.value.actions.push({ type: 'pause_ad', value: null })
    }

    /** 预算动作展示：$5 或 10% 或 设置为$30 */
    const formatBudgetValue = (a) => {
      if (a.value == null) return ''
      if (a.type === 'set_budget') return `=$${Number(a.value)}`
      return (a.value_unit === 'usd') ? `$${Number(a.value)}` : `${a.value}%`
    }

    /** 预算上限输入（美元 → 分）：展示用美元，后端存分；输入 0 视为未设置 */
    const onMaxBudgetInput = (e, a) => {
      const raw = e.target.value
      if (raw === '' || raw == null) {
        a.max_daily_budget = undefined
        return
      }
      const yuan = parseFloat(raw)
      if (Number.isNaN(yuan) || yuan < 0) {
        a.max_daily_budget = undefined
        return
      }
      if (yuan === 0) {
        a.max_daily_budget = undefined
        return
      }
      a.max_daily_budget = Math.round(yuan * 100)
    }

    const applyTemplate = (template) => {
      if (!template || !confirm('这将覆盖当前条件设置，确定吗？')) return
      const lines = Array.isArray(template.when_lines) ? template.when_lines : []
      whenLines.value = lines.length ? lines.map(l => ({ ...l })) : [createDefaultWhenLine(null)]
      whenTimeWindow.value = template.when_time_window || 'today'
      whenCustomRange.value = template.when_custom_range ? { ...template.when_custom_range } : null
      const acts = Array.isArray(template.actions) ? template.actions : []
      ruleForm.value.actions = acts.length ? acts.map(a => ({ ...a })) : [{ type: 'pause_ad', value: null }]
    }

    onMounted(async () => {
      await loadAccounts()
      await loadRules()
    })

    // 仅开发环境：挂到 window 供控制台验证阶段 1 转换函数（生产构建不会包含）
    if (import.meta.env?.DEV) {
      window.__ruleManagerVerify = {
        linesToV2Groups,
        v2ToLines,
        v1ToLines
      }
    }

    return {
      rules, showRuleModal, editingRuleId, ruleForm, running, runningRuleId,
      whenLines, whenTimeWindow, whenCustomRange,
      linesToV2Groups, v2ToLines, v1ToLines,
      createDefaultWhenLine, ensureWhenLinesNonEmpty, getDefaultWhenCustomRange,
      accounts, selectedAccountIds, accountToAdd, accountsFilteredForAdd, accountLabel, onAddAccount, removeAccount, selectAllAccounts, clearAllAccounts,
      scopeItems, scopeSearch, scopeIncludePaused, onScopeStatusChange, scopeLoading, scopeReady, filteredScopeItems, scopeItemKey, scopeItemValue,
      accountLoading, accountError, loadAccounts,
      canSelectAll, selectedTargetPreview,
      scopePagingAfter, loadMoreScopeItems, missingSelectedCount, resolvedSelectedMap,
      levelOptions, hasBudgetAction,
      loadRules, loadTemplates, templates, zeroClickTemplate, metricLabel, opLabel, actionLabel, getActionClass, timeWindowLabel,
      ratioMetricTip,
      openCreateRule, openEditRule, saveRule, deleteRule, toggleRule, runRulesNow, runThisRule,
      refreshScopeItems, refreshScopeItemsWithSync, selectAllScope, clearScopeSelection,
      addWhenLine, removeWhenLine, onWhenTimeWindowChange, addAction, onMaxBudgetInput, applyTemplate, formatBudgetValue, onActionTypeChange
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

/* 比值类指标口径提示 */
.ratio-tip {
  background: #eff6ff;
  border: 1px solid #93c5fd;
  color: #1e40af;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
  line-height: 1.5;
}
.ratio-tip .icon { font-size: 16px; flex-shrink: 0; }
.ratio-tip .btn-tiny { margin-left: auto; flex-shrink: 0; }

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

.rule-name { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge-dnf { font-size: 10px; font-weight: 500; padding: 2px 6px; border-radius: 4px; background: #dbeafe; color: #1d4ed8; }

.card-body {
  padding: 16px;
  flex: 1;
}

.section { margin-bottom: 8px; }
.label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; font-weight: 600; }
.account-info { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px dashed var(--border); }
.account-info .label { display: inline; margin-bottom: 0; }
.account-id { font-size: 12px; color: var(--primary); font-family: monospace; background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; }
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
.input-textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; resize: vertical; }
.alert.info { background: #eff6ff; border: 1px solid #93c5fd; color: #1e40af; padding: 10px 12px; border-radius: 6px; font-size: 13px; }

.condition-row, .action-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
.select { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; flex: 1; }
.input-date { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; width: 140px; font-size: 13px; }
.date-sep { font-size: 12px; color: var(--text-secondary); padding: 0 4px; }
.select.short { flex: 0 0 80px; }
.input-number { width: 80px; padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; }
.action-unit { font-weight: 600; color: var(--text-secondary); margin-left: 2px; }
.action-hint { font-size: 12px; color: var(--text-secondary); margin-left: 4px; }
.cbo-hint { font-size: 12px; color: var(--text-secondary); background: #f0f9ff; border-left: 3px solid #0ea5e9; padding: 8px 12px; margin: 0 0 12px 0; border-radius: 0 4px 4px 0; }
.budget-cap-label { font-size: 13px; color: var(--text-secondary); margin-left: 12px; white-space: nowrap; }
.budget-cap-input { width: 120px; }
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
.when-time-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.when-line-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.join-select { flex: 0 0 60px; }
.join-placeholder { flex: 0 0 60px; display: inline-block; }

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
.tag-missing {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.selected-accounts-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.account-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}
.account-tag .tag-remove {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--text-secondary);
}
.account-tag .tag-remove:hover { color: #dc2626; }
.account-add-select { min-width: 180px; }
.scope-item .account-badge {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: ui-monospace, monospace;
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
  grid-template-columns: 18px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
}
.scope-item:hover { background: #f9fafb; }
.scope-item .name { font-size: 13px; color: var(--text-primary); }
.scope-item .id { font-size: 12px; color: var(--text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>


