/**
 * 规则审计详情「变更说明」读时叙述（M1 集合 + M2 动态筛选 + M3 IF/THEN）
 * 原则：不依赖后端改 API；集合与 scope 先归一；单条失败不拖垮整窗（§10.5）
 * scope_filters：与 RuleManager `parseScopeFilters` / `buildScopeFiltersFromRows` 一致
 * conditions：v1 数组 + logic_operator；v2 `{ version:2, groups[] }`（与 conditionsValidator / conditionsTransform 一致）
 * actions：与 templateValidator VALID_ACTION_TYPES、RuleManager 展示口径一致
 */

/**
 * 字段展示顺序（与方案 §4 一致；未列出的字段 rank=1000 再按 field 字母序）
 * 导出供审计页与 sortRuleHistoryChanges 共用，禁止改为纯字母序
 */
export const DIFF_FIELD_RANK = {
  rule_name: 10,
  enabled: 20,
  target_account_ids: 30,
  use_dynamic_scope: 40,
  scope_filters: 50,
  target_level: 60,
  target_ids: 61,
  target_by_account: 62,
  exclude_ids: 70,
  max_dynamic_matches: 80,
  conditions: 90,
  logic_operator: 91,
  actions: 100,
  timezone_name: 110,
  is_simulation: 111,
  execution_interval_minutes: 112,
  execution_time_windows: 113
}

/** @param {unknown} value */
export function safeArray(value) {
  return Array.isArray(value) ? value : []
}

/** @param {unknown} value */
export function safeObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 排除名单对象：保证 ad_ids / adset_ids / campaign_ids 为数组
 * @param {unknown} value
 * @returns {{ ad_ids: string[], adset_ids: string[], campaign_ids: string[] }}
 */
export function safeExcludeIds(value) {
  const o = safeObject(value)
  return {
    ad_ids: safeArray(o.ad_ids),
    adset_ids: safeArray(o.adset_ids),
    campaign_ids: safeArray(o.campaign_ids)
  }
}

/**
 * 字符串 ID 列表：trim、去重、稳定排序
 * @param {unknown} arr
 * @returns {string[]}
 */
export function normalizeStringList(arr) {
  const seen = new Set()
  const out = []
  for (const x of safeArray(arr)) {
    const s = String(x == null ? '' : x).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

/**
 * 稳定排序后的字符串集合差分（全量列出新增/移除）
 * @param {unknown} before
 * @param {unknown} after
 * @returns {{ added: string[], removed: string[] }}
 */
export function diffStringSets(before, after) {
  const nb = normalizeStringList(before)
  const na = normalizeStringList(after)
  const setB = new Set(nb)
  const setA = new Set(na)
  const added = na.filter((id) => !setB.has(id))
  const removed = nb.filter((id) => !setA.has(id))
  return { added, removed }
}

/**
 * 集合类字段：在保留双栏全量快照的前提下，供前端单独渲染「新增 / 减少」摘要（与 diffStringSets 口径一致）
 * @param {{ field?: string, before?: unknown, after?: unknown }} c
 * @returns {null | { kind: 'flat', added: string[], removed: string[] } | { kind: 'exclude', layers: Array<{ layerKey: string, layerLabel: string, added: string[], removed: string[] }> } | { kind: 'target_by_account', newAccounts: Array<{ act: string, ids: string[] }>, removedAccounts: Array<{ act: string, ids: string[] }>, sameAccountIdDelta: Array<{ act: string, added: string[], removed: string[] }> } }
 */
export function getCollectionDeltaSummary(c) {
  if (!c || typeof c.field !== 'string') return null
  try {
    switch (c.field) {
      case 'target_account_ids':
      case 'target_ids': {
        const { added, removed } = diffStringSets(c.before, c.after)
        return { kind: 'flat', added, removed }
      }
      case 'exclude_ids': {
        const b = safeExcludeIds(c.before)
        const a = safeExcludeIds(c.after)
        /** @type {Array<{ layerKey: string, layerLabel: string, added: string[], removed: string[] }>} */
        const layers = []
        for (const key of /** @type {const} */ (['ad_ids', 'adset_ids', 'campaign_ids'])) {
          const d = diffStringSets(b[key], a[key])
          if (d.added.length || d.removed.length) {
            const layerLabel = key === 'ad_ids' ? '广告' : key === 'adset_ids' ? '广告组' : '广告系列'
            layers.push({
              layerKey: key,
              layerLabel,
              added: d.added,
              removed: d.removed
            })
          }
        }
        return { kind: 'exclude', layers }
      }
      case 'target_by_account': {
        const before = safeObject(c.before)
        const after = safeObject(c.after)
        const bk = new Set(Object.keys(before))
        const ak = new Set(Object.keys(after))
        /** @type {Array<{ act: string, ids: string[] }>} */
        const newAccounts = []
        for (const act of [...ak].filter((k) => !bk.has(k)).sort((x, y) => x.localeCompare(y))) {
          newAccounts.push({ act, ids: normalizeStringList(after[act]) })
        }
        /** @type {Array<{ act: string, ids: string[] }>} */
        const removedAccounts = []
        for (const act of [...bk].filter((k) => !ak.has(k)).sort((x, y) => x.localeCompare(y))) {
          removedAccounts.push({ act, ids: normalizeStringList(before[act]) })
        }
        /** @type {Array<{ act: string, added: string[], removed: string[] }>} */
        const sameAccountIdDelta = []
        for (const act of [...bk].filter((k) => ak.has(k)).sort((x, y) => x.localeCompare(y))) {
          const d = diffStringSets(before[act], after[act])
          if (d.added.length || d.removed.length) {
            sameAccountIdDelta.push({ act, added: d.added, removed: d.removed })
          }
        }
        return { kind: 'target_by_account', newAccounts, removedAccounts, sameAccountIdDelta }
      }
      default:
        return null
    }
  } catch (err) {
    console.error('[ruleAuditNarrative] getCollectionDeltaSummary', err, { field: c?.field })
    return null
  }
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function displayScalar(v) {
  if (v === undefined) return '（未设置）'
  if (v === null) return '（无）'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'number' || typeof v === 'string') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 非集合字段：由「…」改为「…」（M1 兜底，后续 M2/M3 可替换为专用 formatter）
 * @param {{ field: string, label: string, before: unknown, after: unknown }} c
 * @returns {string}
 */
function narrateGenericChange(c) {
  const before = displayScalar(c.before)
  const after = displayScalar(c.after)
  return `${c.label}：由「${before}」改为「${after}」。`
}

/** 布尔按「开启/关闭」表述（兼容 JSON 中的 1/0） */
function boolOnOff(v) {
  return v === true || v === 1 ? '开启' : '关闭'
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string}
 */
function narrateUseDynamicScope(c) {
  return `${c.label}：由「${boolOnOff(c.before)}」改为「${boolOnOff(c.after)}」。`
}

/** @param {unknown} val */
function safeScopeFilters(val) {
  const o = safeObject(val)
  const lv = o.level
  const level = ['ad', 'adset', 'campaign'].includes(lv) ? lv : 'ad'
  const conditions = Array.isArray(o.conditions) ? o.conditions : []
  return { level, conditions }
}

/** @param {string} level */
function scopeLevelLabel(level) {
  if (level === 'ad') return '广告'
  if (level === 'adset') return '广告组'
  if (level === 'campaign') return '广告系列'
  return String(level || 'ad')
}

/**
 * @param {Record<string, unknown>} c
 * @returns {string | null}
 */
function formatScopeConditionLine(c) {
  if (!c || typeof c !== 'object') return null
  const field = c.field
  const op = c.operator
  if (field === 'name' && (op === 'contains' || op === 'not_contains')) {
    const v = String(c.value ?? '').trim()
    return op === 'contains' ? `名称包含「${v}」` : `名称不包含「${v}」`
  }
  if (field === 'effective_status' && (op === 'in' || op === 'not_in')) {
    const arr = Array.isArray(c.value) ? c.value.map((x) => String(x).toUpperCase()) : []
    const hasA = arr.includes('ACTIVE')
    const hasP = arr.includes('PAUSED')
    if (op === 'in') {
      if (arr.length === 1 && hasA) return '有效状态仅投放中（ACTIVE）'
      if (arr.length === 1 && hasP) return '有效状态仅暂停（PAUSED）'
      if (hasA && hasP) return '有效状态含投放中与暂停'
      return `有效状态 in（${arr.join('、')}）`
    }
    if (op === 'not_in') {
      if (arr.length === 1 && hasA) return '有效状态排除投放中'
      if (arr.length === 1 && hasP) return '有效状态排除暂停'
      return `有效状态排除（${arr.join('、')}）`
    }
  }
  if (field === 'created_time' && op === 'within_hours') {
    const h = Number(c.value)
    if (!Number.isFinite(h) || h <= 0) return '创建时间条件（小时数无效）'
    return `创建于最近 ${h} 小时内`
  }
  try {
    return `其它条件：${JSON.stringify(c)}`
  } catch {
    return '（无法序列化的条件）'
  }
}

/**
 * 单份 scope_filters 快照 → 一句可读摘要（与规则页落库结构一致）
 * @param {unknown} val
 * @returns {string}
 */
export function formatScopeFiltersForHumans(val) {
  try {
    const { level, conditions } = safeScopeFilters(val)
    const lv = scopeLevelLabel(level)
    /** @type {string[]} */
    const parts = []
    for (const cond of conditions) {
      const line = formatScopeConditionLine(cond)
      if (line) parts.push(line)
    }
    if (parts.length === 0) {
      return `筛选对象：${lv}；无具体条件（conditions 为空，与动态筛选引擎要求可能不一致，以 JSON 为准）。`
    }
    return `筛选对象：${lv}；${parts.join('；')}。`
  } catch (err) {
    console.error('[ruleAuditNarrative] formatScopeFiltersForHumans', err)
    return '（动态筛选条件解析失败，请查看原始 JSON）'
  }
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string}
 */
function narrateScopeFiltersDiff(c) {
  let beforeText
  let afterText
  try {
    beforeText = formatScopeFiltersForHumans(c.before)
  } catch (err) {
    console.error('[ruleAuditNarrative] scope_filters before', err)
    beforeText = '（解析失败）'
  }
  try {
    afterText = formatScopeFiltersForHumans(c.after)
  } catch (err) {
    console.error('[ruleAuditNarrative] scope_filters after', err)
    afterText = '（解析失败）'
  }
  return `${c.label}：由「${beforeText}」改为「${afterText}」。`
}

// ---------- M3：IF 条件（v1 / v2）与 THEN 动作 ----------

/** 与 RuleManager.metricLabel 对齐 */
const METRIC_LABEL = {
  spend: '花费',
  roas: 'ROAS',
  cpa: '单次购买花费（CPA）',
  cpc: 'CPC（花费/链接点击）',
  add_to_cart_cost: '单次加购花费',
  checkout_cost: '单次结账花费',
  payment_cost: '单次添加支付信息花费',
  purchases: '购买次数',
  purchases_avg_after_create: '多天购买次数平均数',
  link_clicks: '链接点击',
  add_to_cart_count: '加购次数',
  initiate_checkout_count: '结账次数',
  add_payment_info_count: '添加支付信息次数'
}

const OP_LABEL = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=' }

const TIME_WINDOW_LABEL = {
  today: '今天',
  yesterday: '昨天',
  last_3_days: '近3天',
  last_3_days_excluding_today: '近3天（不含今天）',
  last_5_days: '近5天',
  last_5_days_excluding_today: '近5天（不含今天）',
  last_7_days: '近7天',
  last_7_days_excluding_today: '近7天（不含今天）',
  lifetime: '至今为止',
  custom_range: '自定义'
}

// M1 合同：状态动作标签不再写死「广告」，由前端按 targetLevel 渲染实际目标层级文案
const ACTION_LABEL = {
  pause_ad: '暂停目标',
  activate_ad: '启用目标',
  increase_budget: '增加预算',
  decrease_budget: '减少预算',
  set_budget: '设置预算',
  set_dynamic_budget: '设置动态预算值'
}

/**
 * 时间窗后缀；无有效 time_window 时返回空串（§10.1 不把 undefined 渲染成可见字）
 * @param {Record<string, unknown>} c
 */
function formatIfTimeWindowSuffix(c) {
  const w = c.time_window
  if (w == null || w === '') return ''
  const base = TIME_WINDOW_LABEL[w] || String(w)
  if (w === 'custom_range' && c.custom_range && typeof c.custom_range === 'object') {
    const cr = c.custom_range
    const since = cr.since != null ? String(cr.since) : ''
    const until = cr.until != null ? String(cr.until) : ''
    if (!since) return base
    return until && since !== until ? `${base} ${since}~${until}` : `${base} ${since}`
  }
  return base
}

/**
 * 单条 IF 子条件 → 短句（含指标、运算符、值、可选时间窗）
 * @param {Record<string, unknown>} c
 */
function formatIfConditionLine(c) {
  if (!c || typeof c !== 'object') return ''
  const m = METRIC_LABEL[c.metric] || c.metric
  const o = OP_LABEL[c.operator] || c.operator
  const v = c.value
  let base = `${m} ${o} ${v}`
  const tws = formatIfTimeWindowSuffix(c)
  if (tws) base += `（${tws}）`
  return base.trim()
}

/**
 * @param {unknown} arr
 * @param {unknown} logicOperator
 */
function formatV1Conditions(arr, logicOperator) {
  const list = safeArray(arr)
  if (list.length === 0) return '（条件列表为空）'
  const joinWord = String(logicOperator || 'AND').toUpperCase() === 'OR' ? '或' : '且'
  const parts = list.map((x) => formatIfConditionLine(x)).filter(Boolean)
  if (!parts.length) return '（条件无法解析）'
  return parts.join(` ${joinWord} `)
}

/**
 * @param {Record<string, unknown>} obj
 */
function formatV2Conditions(obj) {
  const groups = safeArray(obj.groups)
  if (groups.length === 0) return '（条件组为空）'
  /** @type {string[]} */
  const blocks = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const inner = safeArray(g?.conditions)
      .map((x) => formatIfConditionLine(x))
      .filter(Boolean)
    if (inner.length === 0) continue
    blocks.push(`组${gi + 1}：${inner.join(' 且 ')}`)
  }
  if (blocks.length === 0) return '（无有效条件组）'
  return `${blocks.join('。')}。组之间为「或」（DNF）。`
}

/**
 * 单份 conditions 快照 → 一句摘要（v1 需配合 logic_operator）
 * @param {unknown} conditions
 * @param {unknown} [logicOperator] — v1 用；v2 忽略
 */
export function formatConditionsForHumans(conditions, logicOperator = 'AND') {
  try {
    if (conditions == null) return '（无 IF 条件）'
    if (Array.isArray(conditions)) {
      return formatV1Conditions(conditions, logicOperator)
    }
    if (typeof conditions === 'object' && conditions.version === 2) {
      return formatV2Conditions(conditions)
    }
    return '（无法识别的 conditions 结构）'
  } catch (err) {
    console.error('[ruleAuditNarrative] formatConditionsForHumans', err)
    return '（IF 条件解析失败）'
  }
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @param {Record<string, unknown>} detail
 */
function narrateConditionsDiff(c, detail) {
  const sb = safeObject(detail.snapshot_before)
  const sa = safeObject(detail.snapshot_after)
  const lb = sb.logic_operator ?? sb.logicOperator ?? 'AND'
  const la = sa.logic_operator ?? sa.logicOperator ?? 'AND'
  const beforeText = formatConditionsForHumans(c.before, lb)
  const afterText = formatConditionsForHumans(c.after, la)
  return `${c.label}：由「${beforeText}」改为「${afterText}」。`
}

/**
 * @param {unknown} v
 */
function formatLogicOpReadable(v) {
  return String(v || 'AND').toUpperCase() === 'OR'
    ? 'OR（条件行间为「或」）'
    : 'AND（条件行间为「且」）'
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 */
function narrateLogicOperatorChange(c) {
  return `${c.label}：由「${formatLogicOpReadable(c.before)}」改为「${formatLogicOpReadable(c.after)}」。`
}

/** 预算上下限：分 → 美元展示 */
function dollarsFromCents(cents) {
  if (cents == null) return null
  const n = Number(cents)
  if (!Number.isFinite(n)) return null
  return (n / 100).toFixed(2)
}

/**
 * @param {Record<string, unknown>} a
 */
function formatOneActionHuman(a) {
  if (!a || typeof a !== 'object') return '（无效动作）'
  const type = a.type
  const base = ACTION_LABEL[type] || String(type)
  if (type === 'pause_ad' || type === 'activate_ad') {
    let s = base
    if (a.max_daily_budget != null) {
      const d = dollarsFromCents(a.max_daily_budget)
      if (d != null) s += `（日预算上限 $${d}）`
    }
    if (a.min_daily_budget != null) {
      const d = dollarsFromCents(a.min_daily_budget)
      if (d != null) s += `（日预算下限 $${d}）`
    }
    return s
  }
  if (type === 'set_budget') {
    return `${base} 为 $${Number(a.value)}`
  }
  if (type === 'set_dynamic_budget') {
    let s = `${base}：${METRIC_LABEL[a.metric] || a.metric || '购买次数'} × ${Number(a.multiplier || 0)}`
    if (a.min_daily_budget != null) {
      const d = dollarsFromCents(a.min_daily_budget)
      if (d != null) s += `（日预算下限 $${d}）`
    }
    if (a.max_daily_budget != null) {
      const d = dollarsFromCents(a.max_daily_budget)
      if (d != null) s += `（日预算上限 $${d}）`
    }
    return s
  }
  if (type === 'increase_budget' || type === 'decrease_budget') {
    const isUsd = a.value_unit === 'usd'
    const valPart = isUsd ? `$${Number(a.value)}` : `${Number(a.value)}%`
    let s = `${base} ${valPart}`
    if (type === 'increase_budget' && a.max_daily_budget != null) {
      const d = dollarsFromCents(a.max_daily_budget)
      if (d != null) s += `（日预算上限 $${d}）`
    }
    if (type === 'decrease_budget' && a.min_daily_budget != null) {
      const d = dollarsFromCents(a.min_daily_budget)
      if (d != null) s += `（日预算下限 $${d}）`
    }
    return s
  }
  try {
    return `${base} ${JSON.stringify(a)}`
  } catch {
    return base
  }
}

/**
 * @param {unknown} actions
 */
export function formatActionsForHumans(actions) {
  try {
    const arr = safeArray(actions)
    if (arr.length === 0) return '（无 THEN 动作）'
    return arr.map((x, i) => `${i + 1}. ${formatOneActionHuman(x)}`).join('；')
  } catch (err) {
    console.error('[ruleAuditNarrative] formatActionsForHumans', err)
    return '（THEN 动作解析失败）'
  }
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 */
function narrateActionsDiff(c) {
  let beforeText
  let afterText
  try {
    beforeText = formatActionsForHumans(c.before)
  } catch (err) {
    console.error('[ruleAuditNarrative] actions before', err)
    beforeText = '（解析失败）'
  }
  try {
    afterText = formatActionsForHumans(c.after)
  } catch (err) {
    console.error('[ruleAuditNarrative] actions after', err)
    afterText = '（解析失败）'
  }
  return `${c.label}：由「${beforeText}」改为「${afterText}」。`
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string}
 */
function narrateTargetAccountIds(c) {
  const { added, removed } = diffStringSets(c.before, c.after)
  const parts = []
  if (added.length) parts.push(`新增 ${added.join('、')}`)
  if (removed.length) parts.push(`移除 ${removed.join('、')}`)
  if (!parts.length) return `${c.label}：无有效变更（归一后对比为空）。`
  return `${c.label}：${parts.join('；')}。`
}

const EXCLUDE_LAYER_LABEL = {
  ad_ids: '广告',
  adset_ids: '广告组',
  campaign_ids: '广告系列'
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string[]}
 */
function linesForExcludeIds(c) {
  const before = safeExcludeIds(c.before)
  const after = safeExcludeIds(c.after)

  const hadAny =
    normalizeStringList(before.ad_ids).length > 0 ||
    normalizeStringList(before.adset_ids).length > 0 ||
    normalizeStringList(before.campaign_ids).length > 0
  const afterEmpty =
    normalizeStringList(after.ad_ids).length === 0 &&
    normalizeStringList(after.adset_ids).length === 0 &&
    normalizeStringList(after.campaign_ids).length === 0

  if (hadAny && afterEmpty) {
    return [`${c.label}：已清空排除名单。`]
  }

  /** @type {Array<'ad_ids'|'adset_ids'|'campaign_ids'>} */
  const layers = ['ad_ids', 'adset_ids', 'campaign_ids']
  /** @type {string[]} */
  const lines = []
  for (const key of layers) {
    const { added, removed } = diffStringSets(before[key], after[key])
    if (!added.length && !removed.length) continue
    const layerName = EXCLUDE_LAYER_LABEL[key]
    const segs = []
    if (added.length) segs.push(`新增 ${added.join('、')}`)
    if (removed.length) segs.push(`移除 ${removed.join('、')}`)
    lines.push(`排除名单（${layerName}）：${segs.join('；')}。`)
  }
  if (!lines.length) return [`${c.label}：无有效变更（归一后对比为空）。`]
  return lines
}

/**
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string}
 */
function narrateTargetIds(c) {
  const { added, removed } = diffStringSets(c.before, c.after)
  const parts = []
  if (added.length) parts.push(`新增 ${added.join('、')}`)
  if (removed.length) parts.push(`移除 ${removed.join('、')}`)
  if (!parts.length) return `${c.label}：无有效变更（归一后对比为空）。`
  return `${c.label}：${parts.join('；')}。`
}

/**
 * 账户键级增删 + 交集键内 ID 差分（§10.4）
 * @param {{ label: string, before: unknown, after: unknown }} c
 * @returns {string[]}
 */
function linesForTargetByAccount(c) {
  const before = safeObject(c.before)
  const after = safeObject(c.after)
  const beforeKeys = new Set(Object.keys(before))
  const afterKeys = new Set(Object.keys(after))
  const addedKeys = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort((a, b) => a.localeCompare(b))
  const removedKeys = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort((a, b) => a.localeCompare(b))
  /** @type {string[]} */
  const lines = []

  for (const act of addedKeys) {
    const ids = normalizeStringList(after[act])
    lines.push(`新增账户 ${act}：目标 ID 共 ${ids.length} 个：${ids.join('、')}`)
  }
  for (const act of removedKeys) {
    const ids = normalizeStringList(before[act])
    lines.push(`移除账户 ${act}：此前目标 ID 共 ${ids.length} 个：${ids.join('、')}`)
  }
  const common = [...beforeKeys].filter((k) => afterKeys.has(k)).sort((a, b) => a.localeCompare(b))
  for (const act of common) {
    const { added, removed } = diffStringSets(before[act], after[act])
    if (!added.length && !removed.length) continue
    const segs = []
    if (added.length) segs.push(`新增 ${added.join('、')}`)
    if (removed.length) segs.push(`移除 ${removed.join('、')}`)
    lines.push(`手动按账户目标（账户 ${act}）：${segs.join('；')}。`)
  }
  if (!lines.length) {
    return [`${c.label}：无有效变更（归一后对比为空）。`]
  }
  return lines
}

/**
 * 单份 exclude_ids 快照 → 多行文本（用于双栏「变更前/后」单列展示）
 * @param {unknown} val
 */
export function formatExcludeSnapshotHuman(val) {
  const o = safeExcludeIds(val)
  /** @type {string[]} */
  const lines = []
  const layers = /** @type {const} */ (['ad_ids', 'adset_ids', 'campaign_ids'])
  const layerNames = { ad_ids: '广告', adset_ids: '广告组', campaign_ids: '广告系列' }
  for (const key of layers) {
    const ids = normalizeStringList(o[key])
    if (!ids.length) continue
    lines.push(`${layerNames[key]}：${ids.join('、')}`)
  }
  return lines.length ? lines.join('\n') : '（各层级均为空）'
}

/**
 * 单份 target_by_account 快照 → 按账户分行的文本（§10.4 键级一览）
 * @param {unknown} val
 */
export function formatTargetByAccountSnapshotHuman(val) {
  const o = safeObject(val)
  const keys = Object.keys(o).sort((a, b) => a.localeCompare(b))
  if (!keys.length) return '（无按账户分桶）'
  return keys
    .map((k) => {
      const ids = normalizeStringList(o[k])
      return `${k}：${ids.length ? ids.join('、') : '（空）'}`
    })
    .join('\n')
}

/**
 * 双栏 UI：仅「变更前」列人话（不拼「由…改为…」）
 * @param {{ field?: string, label?: string, before?: unknown, after?: unknown }} c
 * @param {Record<string, unknown>} detail
 */
export function formatDiffColumnBefore(c, detail) {
  try {
    return formatDiffColumnSide(c, detail, 'before')
  } catch (err) {
    console.error('[ruleAuditNarrative] formatDiffColumnBefore', err, { field: c?.field })
    return '（该侧解析失败，请使用下方 JSON 对照或兜底区）'
  }
}

/**
 * 双栏 UI：仅「变更后」列人话
 * @param {{ field?: string, label?: string, before?: unknown, after?: unknown }} c
 * @param {Record<string, unknown>} detail
 */
export function formatDiffColumnAfter(c, detail) {
  try {
    return formatDiffColumnSide(c, detail, 'after')
  } catch (err) {
    console.error('[ruleAuditNarrative] formatDiffColumnAfter', err, { field: c?.field })
    return '（该侧解析失败，请使用下方 JSON 对照或兜底区）'
  }
}

/**
 * 双栏 UI：左「修改前」右「修改后」——集合类展示该侧完整快照（与截图一致），非仅增减差分
 * @param {{ field?: string, before?: unknown, after?: unknown }} c
 * @param {Record<string, unknown>} detail
 * @param {'before'|'after'} side
 */
function formatDiffColumnSide(c, detail, side) {
  const field = typeof c.field === 'string' ? c.field : ''
  const v = side === 'before' ? c.before : c.after
  const snap = side === 'before' ? safeObject(detail.snapshot_before) : safeObject(detail.snapshot_after)
  const logicOp = snap.logic_operator ?? snap.logicOperator ?? 'AND'

  switch (field) {
    case 'use_dynamic_scope':
      return boolOnOff(v)
    case 'scope_filters':
      return formatScopeFiltersForHumans(v)
    case 'conditions':
      return formatConditionsForHumans(v, logicOp)
    case 'logic_operator':
      return formatLogicOpReadable(v)
    case 'actions':
      return formatActionsForHumans(v)
    case 'target_account_ids': {
      const ids = normalizeStringList(v)
      return ids.length ? ids.join('、') : '（空）'
    }
    case 'target_ids': {
      const ids = normalizeStringList(v)
      return ids.length ? ids.join('、') : '（空）'
    }
    case 'exclude_ids':
      return formatExcludeSnapshotHuman(v)
    case 'target_by_account':
      return formatTargetByAccountSnapshotHuman(v)
    default:
      return displayScalar(v)
  }
}

/** 与变更说明相同的字段顺序，供详情页 JSON 对照区复用 */
/** @param {Record<string, unknown>} detail */
export function sortRuleHistoryChanges(detail) {
  const diff = detail && typeof detail === 'object' ? detail.diff : null
  const raw = safeArray(diff?.changes).slice()
  raw.sort((a, b) => {
    const fa = typeof a?.field === 'string' ? a.field : ''
    const fb = typeof b?.field === 'string' ? b.field : ''
    const ra = DIFF_FIELD_RANK[fa] ?? 1000
    const rb = DIFF_FIELD_RANK[fb] ?? 1000
    if (ra !== rb) return ra - rb
    return fa.localeCompare(fb)
  })
  return raw
}

/**
 * 单条 diff 条目 → 一行或多行叙述
 * @param {{ field: string, label: string, before: unknown, after: unknown }} c
 * @param {Record<string, unknown>} detail
 * @returns {string[]}
 */
function linesForOneChange(c, detail) {
  const field = typeof c.field === 'string' ? c.field : ''
  try {
    switch (field) {
      case 'use_dynamic_scope':
        return [narrateUseDynamicScope(c)]
      case 'scope_filters':
        return [narrateScopeFiltersDiff(c)]
      case 'conditions':
        return [narrateConditionsDiff(c, detail)]
      case 'logic_operator':
        return [narrateLogicOperatorChange(c)]
      case 'actions':
        return [narrateActionsDiff(c)]
      case 'target_account_ids':
        return [narrateTargetAccountIds(c)]
      case 'exclude_ids':
        return linesForExcludeIds(c)
      case 'target_ids':
        return [narrateTargetIds(c)]
      case 'target_by_account':
        return linesForTargetByAccount(c)
      default:
        return [narrateGenericChange(c)]
    }
  } catch (err) {
    console.error('[ruleAuditNarrative] 单条解析失败', err, {
      field: c.field,
      label: c.label,
      recordId: detail?.record?.id,
      changeType: detail?.record?.change_type
    })
    return [`该条目解析失败，请查看下方原始 JSON。（${c.label} / ${c.field}）`]
  }
}

/**
 * 管理端详情 API 返回体 → 变更说明文案行（用于 <ul><li>）
 * @param {Record<string, unknown> | null | undefined} detail
 * @returns {string[]}
 */
export function buildDetailNarrativeLines(detail) {
  try {
    if (!detail || typeof detail !== 'object') {
      return ['（无详情数据）']
    }
    const record = detail.record
    const diff = detail.diff
    const notice = typeof diff?.notice === 'string' ? diff.notice : ''
    const changes = sortRuleHistoryChanges(detail)

    /** @type {string[]} */
    const lines = []

    if (notice) lines.push(notice)

    if (!changes.length) {
      if (!lines.length) lines.push('（无字段级对比；请查看下方完整配置或原始 JSON。）')
      return lines
    }

    for (const c of changes) {
      if (!c || typeof c !== 'object') continue
      const label = typeof c.label === 'string' ? c.label : String(c.field ?? '')
      const field = typeof c.field === 'string' ? c.field : ''
      const one = { field, label, before: c.before, after: c.after }
      let sub
      try {
        sub = linesForOneChange(one, detail)
      } catch (err) {
        console.error('[ruleAuditNarrative] linesForOneChange 外层异常', err, {
          field,
          recordId: record?.id
        })
        sub = [`该条目解析失败，请查看下方原始 JSON。（${label} / ${field}）`]
      }
      for (const s of sub) {
        if (typeof s === 'string' && s.length) lines.push(s)
      }
    }

    return lines.length ? lines : ['（无变更说明行）']
  } catch (err) {
    console.error('[ruleAuditNarrative] buildDetailNarrativeLines 失败', err, {
      recordId: detail?.record?.id
    })
    return ['变更说明生成失败，请查看下方原始 JSON。']
  }
}
