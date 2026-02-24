<template>
  <div class="admin-page">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-text">
        <h1 class="page-title">规则模板管理</h1>
        <p class="page-desc">自定义自动化规则模板，快速应用于不同的广告账户。</p>
      </div>
      <div class="controls">
        <label class="checkbox-label">
          <input type="checkbox" v-model="includeInactive" @change="loadTemplates" />
          显示已删除
        </label>
        <button class="btn secondary" @click="loadTemplates">
          <svg class="icon-refresh" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          刷新
        </button>
        <button class="btn btn-primary" @click="openCreate">
          <span class="icon-plus">+</span> 新建模板
        </button>
      </div>
    </div>

    <!-- 模板卡片网格 -->
    <div class="templates-grid">
      <!-- 创建新模板卡片 -->
      <div class="template-card card-create" @click="openCreate">
        <div class="card-create-inner">
          <span class="icon-plus-large">+</span>
          <span class="card-create-text">创建新模板</span>
        </div>
      </div>

      <!-- 已有模板卡片 -->
      <div
        v-for="t in templates"
        :key="t.id"
        class="template-card"
        :class="{ inactive: !t.is_active }"
      >
        <div class="card-top">
          <div class="card-title-wrap">
            <h3 class="card-name">{{ t.name }}</h3>
            <span class="card-slug">{{ t.slug }}</span>
          </div>
          <span class="card-sort">排序 {{ t.sort_order }}</span>
        </div>

        <p v-if="t.description" class="card-desc">{{ t.description }}</p>
        <p v-else class="card-desc auto-desc">{{ autoDesc(t) }}</p>

        <!-- 条件区（浅蓝） -->
        <div class="card-block conditions-block">
          <div class="block-title">条件（范围: {{ timeWindowLabel(t.when_time_window) }}）</div>
          <div class="block-content">
            <span
              v-for="(l, i) in (t.when_lines || [])"
              :key="i"
              class="condition-chip"
            >
              <span v-if="i > 0" class="join-tag">{{ l.join === 'OR' ? '或' : '且' }}</span>
              <span class="metric-name">{{ metricLabel(l.metric) }}</span>
              <span class="op">{{ opLabel(l.operator) }}</span>
              <span class="val">{{ l.value }}</span>
            </span>
            <span v-if="!t.when_lines?.length" class="muted">-</span>
          </div>
        </div>

        <!-- 执行动作区（浅绿） -->
        <div class="card-block actions-block">
          <div class="block-title">执行动作</div>
          <div class="block-content">
            <span
              v-for="(a, i) in (t.actions || [])"
              :key="i"
              class="action-chip"
            >
              <span class="arrow">→</span>
              {{ actionLabel(a) }}
            </span>
            <span v-if="!t.actions?.length" class="muted">-</span>
          </div>
        </div>

        <div class="card-footer">
          <button v-if="t.is_active" class="btn-icon-text" @click="openEdit(t)">
            <svg class="icon-inline" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            编辑
          </button>
          <button v-if="t.is_active" class="btn-icon-text danger" @click="doDelete(t)">
            <svg class="icon-inline" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            删除
          </button>
          <button v-if="!t.is_active" class="btn-icon-text success" @click="doRestore(t)">
            恢复
          </button>
        </div>
      </div>
    </div>

    <div v-if="templates.length === 0 && !includeInactive" class="empty">
      <span class="empty-icon">📋</span>
      <p>暂无模板</p>
      <button class="btn" @click="openCreate">创建第一个模板</button>
    </div>

    <!-- 新建/编辑弹窗 -->
    <div v-if="showModal" class="modal-overlay" @click="showModal = false">
      <div class="modal-content modal-wide" @click.stop>
        <div class="modal-header">
          <div class="modal-header-text">
            <h3 class="modal-title">{{ editingId ? '编辑规则模板' : '新建规则模板' }}</h3>
            <p class="modal-subtitle">配置自动化策略的触发条件与执行动作</p>
          </div>
          <button class="modal-close" @click="showModal = false" aria-label="关闭">×</button>
        </div>
        <div class="modal-body">
          <!-- 基本信息 -->
          <div class="form-section">
            <h4 class="section-label">基本信息</h4>
            <div class="form-row">
              <div class="form-group">
                <label>规则名称 / 标识符</label>
                <input v-model="form.name" type="text" class="input-clean" placeholder="如：止损" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group flex-2">
                <label>描述说明</label>
                <input
                  :value="formDescPreview"
                  type="text"
                  class="input-clean input-readonly"
                  readonly
                  placeholder="将根据条件与动作自动生成"
                />
              </div>
              <div class="form-group">
                <label>优先级</label>
                <input v-model.number="form.sort_order" type="number" class="input-clean input-narrow" />
              </div>
              <div class="form-group">
                <label>时间窗口</label>
                <select v-model="form.when_time_window" class="select-clean">
                  <option value="today">今天</option>
                  <option value="yesterday">昨天</option>
                  <option value="last_3_days">近3天</option>
                  <option value="lifetime">累计</option>
                  <option value="custom_range">自定义范围</option>
                </select>
                <template v-if="form.when_time_window === 'custom_range'">
                  <input type="date" v-model="customRange.since" class="input-date" />
                  <span class="date-sep">至</span>
                  <input type="date" v-model="customRange.until" class="input-date" />
                </template>
              </div>
            </div>
          </div>

          <!-- 触发条件（可视化构建器风格） -->
          <div class="form-section">
            <h4 class="section-label">
              <span class="section-icon">◎</span> 触发条件
            </h4>
            <div class="conditions-builder">
              <div v-for="(line, idx) in form.when_lines" :key="idx" class="condition-row-builder">
                <select v-if="idx > 0" v-model="line.join" class="select-clean select-join">
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
                <span v-else class="join-placeholder">IF</span>
                <select v-model="line.metric" class="select-clean select-metric">
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
                <select v-model="line.operator" class="select-clean select-op">
                  <option value="gt">></option>
                  <option value="lt">&lt;</option>
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                  <option value="eq">=</option>
                </select>
                <input type="number" v-model.number="line.value" class="input-clean input-num" step="0.01" />
                <button class="btn-icon danger" @click="removeWhenLine(idx)" title="删除" aria-label="删除条件">×</button>
              </div>
              <button class="btn-add" @click="addWhenLine">+ 添加条件</button>
            </div>
          </div>

          <!-- 执行动作 -->
          <div class="form-section">
            <h4 class="section-label">
              <span class="section-icon">◎</span> 执行动作
            </h4>
            <div class="actions-builder">
              <div v-for="(a, idx) in form.actions" :key="idx" class="action-row-builder">
                <span class="then-tag">THEN</span>
                <select v-model="a.type" class="select-clean select-action" @change="onActionTypeChange(a)">
                  <option value="pause_ad">暂停广告</option>
                  <option value="activate_ad">启用广告</option>
                  <option value="increase_budget">增加预算</option>
                  <option value="decrease_budget">减少预算</option>
                  <option value="set_budget">设置预算为固定值</option>
                </select>
                <template v-if="a.type.includes('budget')">
                  <select v-if="a.type !== 'set_budget'" v-model="a.value_unit" class="select-clean select-unit" title="调整单位">
                    <option value="percent">百分比</option>
                    <option value="usd">固定金额</option>
                  </select>
                  <input
                    v-if="a.type === 'set_budget'"
                    type="number"
                    v-model.number="a.value"
                    class="input-clean input-num"
                    placeholder="30"
                    min="0.01"
                    max="9999"
                    step="0.01"
                  />
                  <input
                    v-else-if="(a.value_unit || 'percent') === 'percent'"
                    type="number"
                    v-model.number="a.value"
                    class="input-clean input-num"
                    placeholder="10"
                    min="1"
                    max="100"
                    step="1"
                  />
                  <input
                    v-else
                    type="number"
                    v-model.number="a.value"
                    class="input-clean input-num"
                    placeholder="5"
                    min="0.01"
                    max="9999"
                    step="0.01"
                  />
                  <span class="unit">{{ a.type === 'set_budget' || (a.value_unit || 'percent') === 'usd' ? '$' : '%' }}</span>
                  <span class="budget-cap-wrap">
                    <span class="budget-cap-label">预算上限</span>
                    <input
                      type="number"
                      :value="a.max_daily_budget != null ? a.max_daily_budget / 100 : ''"
                      @input="onMaxBudgetInput($event, a)"
                      class="input-clean input-num"
                      placeholder="不填则不限制"
                      min="1"
                      step="0.01"
                    />
                    <span class="unit-hint">美元</span>
                  </span>
                </template>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn secondary" @click="showModal = false">取消</button>
          <button class="btn btn-primary" @click="saveTemplate" :disabled="saving">
            {{ saving ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, reactive, computed } from 'vue'
import { createDefaultWhenLine, getDefaultWhenCustomRange } from '../utils/conditionsTransform.js'
import { authFetch } from '../utils/authFetch.js'

const METRIC_LABELS = {
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
const OP_LABELS = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=' }
const TIME_WINDOW_LABELS = {
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  last_3_days: 'LAST 3 DAYS',
  lifetime: 'LIFETIME',
  custom_range: '自定义'
}
const ACTION_LABELS = {
  pause_ad: '暂停广告',
  activate_ad: '启用广告',
  increase_budget: '增加预算',
  decrease_budget: '减少预算',
  set_budget: '设置预算'
}

export default {
  name: 'AdminTemplates',
  setup() {
    const templates = ref([])
    const includeInactive = ref(true)
    const showModal = ref(false)
    const editingId = ref(null)
    const saving = ref(false)
    const customRange = reactive({ since: '', until: '' })

    const form = reactive({
      name: '',
      slug: '',
      description: '',
      sort_order: 0,
      when_lines: [createDefaultWhenLine(null)],
      when_time_window: 'today',
      when_custom_range: null,
      actions: [{ type: 'pause_ad', value: null }],
      updated_at: null
    })

    const metricLabel = (m) => METRIC_LABELS[m] || m
    const opLabel = (o) => OP_LABELS[o] || o
    const timeWindowLabel = (tw) => TIME_WINDOW_LABELS[tw] || tw
    const actionLabel = (a) => {
      const label = ACTION_LABELS[a.type] || a.type
      if (a.value == null) return label
      if (a.type === 'set_budget') return `${label} $${Number(a.value)}`
      const unit = a.value_unit === 'usd' ? 'usd' : 'percent'
      return unit === 'usd' ? `${label} $${Number(a.value)}` : `${label} ${a.value}%`
    }

    const autoDesc = (t) => {
      const lines = Array.isArray(t.when_lines) ? t.when_lines : []
      const arr = lines.map((l, i) => {
        const m = metricLabel(l.metric)
        const op = opLabel(l.operator)
        const join = i > 0 ? (l.join === 'OR' ? ' 或 ' : ' 且 ') : ''
        return `${join}${m} ${op} ${l.value}`
      })
      const tw = timeWindowLabel(t.when_time_window)
      const acts = Array.isArray(t.actions) ? t.actions : []
      const actStr = acts.map(a => actionLabel(a)).join('、') || '-'
      return (arr.join('') || '-') + ` (${tw}) → ${actStr}`
    }

    const formDescPreview = computed(() => {
      const lines = form.when_lines || []
      const arr = lines.map((l, i) => {
        const m = metricLabel(l.metric)
        const op = opLabel(l.operator)
        const join = i > 0 ? (l.join === 'OR' ? ' 或 ' : ' 且 ') : ''
        return `${join}${m} ${op} ${l.value}`
      })
      const tw = timeWindowLabel(form.when_time_window)
      const acts = (form.actions || []).map(a => actionLabel(a)).join('、') || '-'
      return (arr.join('') || '-') + ` (${tw}) → ${acts}`
    })

    const loadTemplates = async () => {
      try {
        const url = `/api/admin/templates?include_inactive=${includeInactive.value ? '1' : '0'}`
        const resp = await authFetch(url)
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '获取失败')
        templates.value = data.templates || []
      } catch (e) {
        alert('加载模板失败：' + e.message)
      }
    }

    const resetForm = () => {
      form.name = ''
      form.slug = ''
      form.description = ''
      form.sort_order = 0
      form.when_lines = [createDefaultWhenLine(null)]
      form.when_time_window = 'today'
      form.when_custom_range = null
      form.actions = [{ type: 'pause_ad', value: null }]
      form.updated_at = null
      const def = getDefaultWhenCustomRange()
      customRange.since = def.since
      customRange.until = def.until
    }

    const openCreate = () => {
      editingId.value = null
      resetForm()
      const def = getDefaultWhenCustomRange()
      customRange.since = def.since
      customRange.until = def.until
      showModal.value = true
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

    const openEdit = (t) => {
      editingId.value = t.id
      form.name = t.name || ''
      form.slug = t.slug || ''
      form.description = t.description || ''
      form.sort_order = t.sort_order ?? 0
      form.updated_at = t.updated_at || null
      form.when_lines = Array.isArray(t.when_lines) && t.when_lines.length
        ? t.when_lines.map(l => ({ ...l }))
        : [createDefaultWhenLine(null)]
      form.when_time_window = t.when_time_window || 'today'
      form.when_custom_range = t.when_custom_range ? { ...t.when_custom_range } : null
      form.actions = Array.isArray(t.actions) && t.actions.length
        ? t.actions.map(a => ({ ...a }))
        : [{ type: 'pause_ad', value: null }]
      const normalizedCount = normalizeInvalidMaxBudget(form.actions)
      if (normalizedCount > 0) {
        console.info(`[模板编辑] 已自动清空 ${normalizedCount} 个无效的预算上限（<1美元）`)
      }
      if (t.when_time_window === 'custom_range' && t.when_custom_range) {
        customRange.since = t.when_custom_range.since || ''
        customRange.until = t.when_custom_range.until || ''
      } else {
        const def = getDefaultWhenCustomRange()
        customRange.since = def.since
        customRange.until = def.until
      }
      showModal.value = true
    }

    const addWhenLine = () => {
      form.when_lines.push({ join: 'AND', metric: 'spend', operator: 'gt', value: 0 })
    }
    const removeWhenLine = (idx) => {
      form.when_lines.splice(idx, 1)
      if (form.when_lines.length === 0) {
        form.when_lines = [createDefaultWhenLine(null)]
      }
      if (idx === 0 && form.when_lines.length) {
        form.when_lines[0].join = null
      }
    }

    const addAction = () => {
      // 模板仅支持单动作，保留空函数避免引用错误
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
    /** 预算上限输入（美元 → 分）：展示用美元，后端存分；输入 0 视为未设置 */
    const onMaxBudgetInput = (e, a) => {
      const raw = e.target.value
      if (raw === '' || raw == null) {
        a.max_daily_budget = undefined
        return
      }
      const v = parseFloat(raw)
      if (Number.isNaN(v) || v < 0 || v === 0) {
        a.max_daily_budget = undefined
        return
      }
      a.max_daily_budget = Math.round(v * 100)
    }

    const doRestore = async (t) => {
      if (!confirm(`确定恢复模板「${t.name}」吗？`)) return
      try {
        const resp = await authFetch(`/api/admin/templates/${t.id}/restore`, { method: 'POST' })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '恢复失败')
        await loadTemplates()
      } catch (e) {
        alert('恢复失败：' + e.message)
      }
    }

    const saveTemplate = async () => {
      if (!form.name?.trim()) return alert('请输入模板名称')
      if (form.when_lines.length === 0) return alert('请至少添加一个条件')
      if (form.actions.length === 0) return alert('请至少添加一个动作')
      for (const a of form.actions) {
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
      if (form.when_time_window === 'custom_range') {
        if (!customRange.since || !customRange.until) return alert('自定义范围请填写起始和截止日期')
        if (customRange.since > customRange.until) return alert('起始日期不能晚于截止日期')
      }

      const slug = (editingId.value ? form.slug?.trim() : null) || `custom_${Date.now()}`
      const payload = {
        name: form.name.trim(),
        slug,
        description: form.description?.trim() || null,
        sort_order: form.sort_order,
        when_lines: form.when_lines,
        when_time_window: form.when_time_window,
        when_custom_range: form.when_time_window === 'custom_range' ? { since: customRange.since, until: customRange.until } : null,
        actions: form.actions.map(a => {
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
      }
      if (editingId.value && form.updated_at) {
        payload.updated_at = form.updated_at
      }

      saving.value = true
      try {
        const url = editingId.value ? `/api/admin/templates/${editingId.value}` : '/api/admin/templates'
        const method = editingId.value ? 'PUT' : 'POST'
        const resp = await authFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '保存失败')
        showModal.value = false
        await loadTemplates()
      } catch (e) {
        alert('保存失败：' + e.message)
      } finally {
        saving.value = false
      }
    }

    const doDelete = async (t) => {
      if (!confirm(`确定删除模板「${t.name}」吗？（软删除，可恢复）`)) return
      try {
        const resp = await authFetch(`/api/admin/templates/${t.id}`, { method: 'DELETE' })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '删除失败')
        await loadTemplates()
      } catch (e) {
        alert('删除失败：' + e.message)
      }
    }

    onMounted(loadTemplates)

    return {
      templates,
      includeInactive,
      showModal,
      editingId,
      form,
      customRange,
      saving,
      formDescPreview,
      loadTemplates,
      metricLabel,
      opLabel,
      timeWindowLabel,
      actionLabel,
      autoDesc,
      openCreate,
      openEdit,
      addWhenLine,
      removeWhenLine,
      addAction,
      onActionTypeChange,
      onMaxBudgetInput,
      saveTemplate,
      doDelete,
      doRestore
    }
  }
}
</script>

<style scoped>
.admin-page { padding-bottom: 40px; }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
  gap: 20px;
}
.header-text { flex: 1; }
.page-title {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}
.page-desc {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.controls {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}
.btn-primary { background: var(--primary-color); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); }
.icon-refresh {
  flex-shrink: 0;
  margin-right: 6px;
  vertical-align: middle;
}
.icon-plus { margin-right: 4px; font-weight: 600; }

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.template-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 20px;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.template-card:hover { border-color: #b0b4b8; box-shadow: var(--shadow-hover); }
.template-card.inactive { opacity: 0.65; }

.card-create {
  border: 2px dashed var(--border-color);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
.card-create:hover {
  border-color: var(--primary-color);
  background: #fafbff;
}
.card-create-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
}
.icon-plus-large {
  font-size: 48px;
  font-weight: 300;
  color: var(--primary-color);
  line-height: 1;
}
.card-create-text { font-size: 14px; }

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}
.card-title-wrap { display: flex; flex-direction: column; gap: 4px; }
.card-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}
.card-slug {
  font-size: 12px;
  color: var(--text-secondary);
}
.card-sort {
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.card-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 14px;
  line-height: 1.5;
}
.card-desc.auto-desc { color: #555; }

.card-block {
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.card-block:last-of-type { margin-bottom: 16px; }
.block-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.block-content {
  font-size: 13px;
  line-height: 1.6;
}
.conditions-block {
  background: #e3f2fd;
  border: 1px solid #bbdefb;
}
.actions-block {
  background: #e8f5e9;
  border: 1px solid #c8e6c9;
}
.condition-chip,
.action-chip {
  display: inline;
}
.condition-chip { margin-right: 4px; }
.metric-name { color: var(--primary-color); font-weight: 500; }
.join-tag {
  color: var(--text-secondary);
  font-size: 12px;
  margin-right: 4px;
}
.action-chip .arrow { margin-right: 4px; color: var(--text-secondary); }
.muted { color: var(--text-secondary); }

.card-footer {
  display: flex;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
}
.btn-icon-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 13px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-primary);
}
.btn-icon-text:hover { background: #f5f5f5; color: var(--primary-color); }
.btn-icon-text.danger { color: var(--danger-color); border-color: #fed7d7; }
.btn-icon-text.danger:hover { background: #fff5f5; }
.btn-icon-text.success { color: #2e7d32; border-color: #c8e6c9; }
.btn-icon-text.success:hover { background: #e8f5e9; }
.icon-inline { flex-shrink: 0; margin-right: 4px; vertical-align: middle; }

.empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}
.empty-icon { font-size: 48px; display: block; margin-bottom: 12px; }
.empty p { margin: 0 0 16px; font-size: 15px; }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-content {
  background: #fff;
  border-radius: var(--radius-lg);
  max-width: 600px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.modal-wide { max-width: 700px; }
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}
.modal-header-text { flex: 1; }
.modal-title { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
.modal-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0;
  line-height: 1;
}
.modal-close:hover { color: var(--text-primary); }
.modal-body { padding: 24px; }
.modal-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.form-section { margin-bottom: 24px; }
.form-section:last-child { margin-bottom: 0; }
.section-label {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.section-icon { color: var(--primary-color); }
.form-row { display: flex; gap: 16px; flex-wrap: wrap; }
.form-row .form-group { flex: 1; min-width: 140px; }
.form-group.flex-2 { flex: 2; min-width: 200px; }
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 13px;
  color: var(--text-primary);
}
.form-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

.input-clean {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: #fff;
  font-size: 14px;
}
.input-clean:focus {
  outline: none;
  border-color: var(--primary-color);
}
.input-readonly { background: #f5f5f5; color: var(--text-secondary); cursor: default; }
.input-narrow { width: 80px; }
.input-num { width: 90px; }
.select-clean {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: #fff;
  font-size: 14px;
}
.select-join { width: 70px; }
.select-metric { min-width: 130px; }
.select-op { width: 60px; }
.select-action { min-width: 130px; }
.input-date {
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  margin: 0 4px;
  font-size: 13px;
}
.date-sep { margin: 0 8px; color: var(--text-secondary); font-size: 13px; }
.unit { margin-left: 4px; font-weight: 500; }
.budget-cap-wrap { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; }
.budget-cap-label { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.unit-hint { font-size: 12px; color: var(--text-secondary); }

.conditions-builder,
.actions-builder { margin-top: 12px; }
.condition-row-builder,
.action-row-builder {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.join-placeholder {
  width: 36px;
  font-weight: 600;
  font-size: 13px;
  color: var(--primary-color);
}
.then-tag {
  font-weight: 600;
  font-size: 13px;
  color: var(--primary-color);
  width: 44px;
  flex-shrink: 0;
}
.btn-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid var(--border-color);
  background: #fff;
  font-size: 18px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.btn-icon:hover { background: #f5f5f5; }
.btn-icon.danger { color: var(--danger-color); border-color: #fed7d7; background: #fff5f5; }
.btn-icon.danger:hover { background: #ffebee; }
.btn-add {
  width: 100%;
  padding: 10px;
  font-size: 13px;
  border: 1px dashed var(--border-color);
  background: #fafafa;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--primary-color);
}
.btn-add:hover { background: #f0f7ff; border-color: var(--primary-color); }
</style>
