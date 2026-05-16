/**
 * 规则模板校验（2.3.2 自定义模板页面）
 * 校验 when_lines、when_time_window、when_custom_range、actions
 */

const VALID_TIME_WINDOWS = [
  'today',
  'yesterday',
  'last_3_days',
  'last_3_days_excluding_today',
  'last_5_days',
  'last_5_days_excluding_today',
  'last_7_days',
  'last_7_days_excluding_today',
  'last_30_days',
  'lifetime',
  'custom_range'
]
// M1 合同：持久化动作枚举不变（旧枚举继续入库，执行层按 targetLevel 解释）
// pause_ad/activate_ad 在数据库中保持不变，执行时根据 targetLevel 决定实际目标层级
const VALID_ACTION_TYPES = ['pause_ad', 'activate_ad', 'increase_budget', 'decrease_budget', 'set_budget', 'set_dynamic_budget']
/** value_unit：percent=百分比增减，usd=固定美元增减 */
const VALID_VALUE_UNITS = ['percent', 'usd']
/** 与 RuleManager/AdminTemplates 前端下拉、ruleDataService 读侧口径对齐，见 docs/0指标清单，字段清单.md */
const VALID_METRICS = [
  'spend', 'roas', 'cpa', 'cpc', 'purchases', 'link_clicks',
  'add_to_cart_count', 'add_to_cart_cost', 'initiate_checkout_count', 'checkout_cost',
  'add_payment_info_count', 'payment_cost', 'purchases_avg_after_create'
]
const VALID_OPERATORS = ['gt', 'lt', 'gte', 'lte', 'eq']

/**
 * 校验模板请求体（新建/更新）
 * @param {object} body - { name, slug?, when_lines, when_time_window, when_custom_range?, actions, sort_order? }
 * @param {boolean} isUpdate - 是否更新（更新时 slug 不可改）
 * @returns {{ valid: boolean, error?: string, field?: string }}
 */
export function validateTemplateBody(body, isUpdate = false) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: '请求体不能为空', field: 'body' }
  }

  if (!isUpdate) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return { valid: false, error: '模板名称不能为空', field: 'name' }
    }
    if (!body.slug || typeof body.slug !== 'string' || !body.slug.trim()) {
      return { valid: false, error: 'slug 不能为空', field: 'slug' }
    }
    const slugOk = /^[a-z0-9_]+$/.test(body.slug.trim())
    if (!slugOk) {
      return { valid: false, error: 'slug 仅允许小写字母、数字、下划线', field: 'slug' }
    }
  }

  const targetLevel = body.target_level || body.targetLevel || 'ad'
  const wl = validateWhenLines(body.when_lines, targetLevel)
  if (!wl.valid) return wl

  const tw = validateWhenTimeWindow(body.when_time_window, body.when_custom_range)
  if (!tw.valid) return tw

  const act = validateActions(body.actions, targetLevel)
  if (!act.valid) return act

  if (body.sort_order != null && (typeof body.sort_order !== 'number' || !Number.isFinite(body.sort_order))) {
    return { valid: false, error: 'sort_order 须为数字', field: 'sort_order' }
  }

  return { valid: true }
}

/**
 * 校验 when_lines
 */
function validateWhenLines(whenLines, targetLevel = 'ad') {
  const safeTargetLevel = String(targetLevel || 'ad').toLowerCase()
  if (!Array.isArray(whenLines) || whenLines.length === 0) {
    return { valid: false, error: 'when_lines 须为非空数组', field: 'when_lines' }
  }
  for (let i = 0; i < whenLines.length; i++) {
    const line = whenLines[i]
    if (!line || typeof line !== 'object') {
      return { valid: false, error: `when_lines[${i}] 须为对象`, field: 'when_lines' }
    }
    if (i === 0 && line.join != null) {
      return { valid: false, error: 'when_lines 首行 join 须为 null', field: 'when_lines' }
    }
    if (i > 0 && line.join !== 'AND' && line.join !== 'OR') {
      return { valid: false, error: `when_lines[${i}] join 须为 AND 或 OR`, field: 'when_lines' }
    }
    if (!VALID_METRICS.includes(line.metric)) {
      return { valid: false, error: `when_lines[${i}] metric 不支持: ${line.metric}`, field: 'when_lines' }
    }
    if (line.metric === 'purchases_avg_after_create' && safeTargetLevel !== 'ad') {
      return { valid: false, error: `when_lines[${i}] 多天购买次数平均数仅支持 targetLevel=ad`, field: 'when_lines' }
    }
    if (!VALID_OPERATORS.includes(line.operator)) {
      return { valid: false, error: `when_lines[${i}] operator 不支持: ${line.operator}`, field: 'when_lines' }
    }
    if (line.value == null || (typeof line.value !== 'number' && typeof line.value !== 'string')) {
      return { valid: false, error: `when_lines[${i}] value 不能为空`, field: 'when_lines' }
    }
    const v = Number(line.value)
    if (!Number.isFinite(v) && typeof line.value !== 'string') {
      return { valid: false, error: `when_lines[${i}] value 须为有效数值`, field: 'when_lines' }
    }
  }
  return { valid: true }
}

/**
 * 校验 when_time_window 与 when_custom_range
 */
function validateWhenTimeWindow(whenTimeWindow, whenCustomRange) {
  if (!whenTimeWindow || typeof whenTimeWindow !== 'string') {
    return { valid: false, error: 'when_time_window 不能为空', field: 'when_time_window' }
  }
  if (!VALID_TIME_WINDOWS.includes(whenTimeWindow)) {
    return { valid: false, error: `when_time_window 不支持: ${whenTimeWindow}`, field: 'when_time_window' }
  }
  if (whenTimeWindow === 'custom_range') {
    if (!whenCustomRange || typeof whenCustomRange !== 'object') {
      return { valid: false, error: 'custom_range 时须提供 when_custom_range', field: 'when_custom_range' }
    }
    const since = whenCustomRange.since
    const until = whenCustomRange.until
    if (!since || !until) {
      return { valid: false, error: 'when_custom_range 须含 since 和 until', field: 'when_custom_range' }
    }
    if (String(since) > String(until)) {
      return { valid: false, error: 'when_custom_range since 须小于等于 until', field: 'when_custom_range' }
    }
  }
  return { valid: true }
}

/**
 * 校验 actions（模板与规则共用）
 * @param {Array} actions
 * @returns {{ valid: boolean, error?: string, field?: string }}
 */
export function validateActions(actions, targetLevel = 'ad') {
  return _validateActions(actions, targetLevel)
}

function _validateActions(actions, targetLevel = 'ad') {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { valid: false, error: 'actions 须为非空数组', field: 'actions' }
  }
  const budgetTypes = ['increase_budget', 'decrease_budget', 'set_budget']
  const safeTargetLevel = String(targetLevel || 'ad').toLowerCase()
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    const hasMaxDailyBudget = a?.max_daily_budget != null
    const hasMinDailyBudget = a?.min_daily_budget != null
    if (!a || typeof a !== 'object') {
      return { valid: false, error: `actions[${i}] 须为对象`, field: 'actions' }
    }
    if (!VALID_ACTION_TYPES.includes(a.type)) {
      return { valid: false, error: `actions[${i}] type 不支持: ${a.type}`, field: 'actions' }
    }
    if (budgetTypes.includes(a.type) && safeTargetLevel !== 'ad') {
      return { valid: false, error: `actions[${i}] 预算动作仅支持 targetLevel=ad`, field: 'actions' }
    }
    if (a.type !== 'set_dynamic_budget' && hasMaxDailyBudget && hasMinDailyBudget) {
      return { valid: false, error: `actions[${i}] 不允许同时配置 max_daily_budget 与 min_daily_budget`, field: 'actions' }
    }
    if (a.type === 'set_dynamic_budget') {
      if (!a.metric || !VALID_METRICS.includes(a.metric)) {
        return { valid: false, error: `actions[${i}] set_dynamic_budget metric 不支持: ${a.metric}`, field: 'actions' }
      }
      if (a.metric === 'purchases_avg_after_create' && safeTargetLevel !== 'ad') {
        return { valid: false, error: `actions[${i}] 多天购买次数平均数仅支持 targetLevel=ad`, field: 'actions' }
      }
      if (a.value_unit != null && a.value_unit !== 'usd') {
        return { valid: false, error: `actions[${i}] set_dynamic_budget 仅支持 value_unit=usd 或不传`, field: 'actions' }
      }
      const multiplier = Number(a.multiplier)
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        return { valid: false, error: `actions[${i}] set_dynamic_budget multiplier 须为大于 0 的数字`, field: 'actions' }
      }
      if (/\.\d{3,}$/.test(String(a.multiplier))) {
        return { valid: false, error: `actions[${i}] set_dynamic_budget multiplier 最多两位小数`, field: 'actions' }
      }
      if (hasMinDailyBudget) {
        const min = Number(a.min_daily_budget)
        if (!Number.isInteger(min) || min < 100) {
          return { valid: false, error: `actions[${i}] min_daily_budget 须为整数且 >= 100 分（1 美元）`, field: 'actions' }
        }
      }
      if (hasMaxDailyBudget) {
        const max = Number(a.max_daily_budget)
        if (!Number.isInteger(max) || max < 100) {
          return { valid: false, error: `actions[${i}] max_daily_budget 须为整数且 >= 100 分（1 美元）`, field: 'actions' }
        }
      }
      if (hasMinDailyBudget && hasMaxDailyBudget && Number(a.min_daily_budget) > Number(a.max_daily_budget)) {
        return { valid: false, error: `actions[${i}] min_daily_budget 须小于等于 max_daily_budget`, field: 'actions' }
      }
    } else if (a.type === 'set_budget') {
      // set_budget 仅允许 value_unit='usd' 或不传（undefined/null），其它一律报错
      if (a.value_unit != null && a.value_unit !== 'usd') {
        return { valid: false, error: `actions[${i}] set_budget 仅支持 value_unit=usd 或不传`, field: 'actions' }
      }
      if (a.value == null || (typeof a.value !== 'number' && typeof a.value !== 'string')) {
        return { valid: false, error: `actions[${i}] set_budget value 不能为空`, field: 'actions' }
      }
      const v = Number(a.value)
      if (!Number.isFinite(v) || v < 0.01 || v > 9999) {
        return { valid: false, error: `actions[${i}] set_budget value 须为 0.01–9999`, field: 'actions' }
      }
      const strVal = String(a.value)
      if (/\.\d{3,}$/.test(strVal)) {
        return { valid: false, error: `actions[${i}] set_budget value 最多两位小数`, field: 'actions' }
      }
      if (hasMaxDailyBudget || hasMinDailyBudget) {
        return { valid: false, error: `actions[${i}] set_budget 不允许配置 max_daily_budget 或 min_daily_budget`, field: 'actions' }
      }
    } else if (budgetTypes.includes(a.type)) {
      if (a.type === 'increase_budget' && hasMinDailyBudget) {
        return { valid: false, error: `actions[${i}] increase_budget 不允许配置 min_daily_budget`, field: 'actions' }
      }
      if (a.type === 'decrease_budget' && hasMaxDailyBudget) {
        return { valid: false, error: `actions[${i}] decrease_budget 不允许配置 max_daily_budget`, field: 'actions' }
      }
      const unit = VALID_VALUE_UNITS.includes(a.value_unit) ? a.value_unit : 'percent'
      if (unit === 'usd') {
        // usd 模式：value 必填，0.01–9999，最多两位小数
        if (a.value == null || (typeof a.value !== 'number' && typeof a.value !== 'string')) {
          return { valid: false, error: `actions[${i}] 固定金额模式下 value 不能为空`, field: 'actions' }
        }
        const v = Number(a.value)
        if (!Number.isFinite(v) || v < 0.01 || v > 9999) {
          return { valid: false, error: `actions[${i}] 固定金额 value 须为 0.01–9999`, field: 'actions' }
        }
        const strVal = String(a.value)
        if (/\.\d{3,}$/.test(strVal)) {
          return { valid: false, error: `actions[${i}] 固定金额 value 最多两位小数`, field: 'actions' }
        }
      } else {
        // percent 模式：value 1–100 整数
        const v = Number(a.value)
        if (a.value == null || a.value === '' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 100) {
          return { valid: false, error: `actions[${i}] 百分比模式下 value 须为 1–100 整数`, field: 'actions' }
        }
      }
      if (a.type === 'increase_budget' && hasMaxDailyBudget) {
        const mdb = Number(a.max_daily_budget)
        if (!Number.isInteger(mdb) || mdb < 0) {
          return { valid: false, error: `actions[${i}] max_daily_budget 须为非负整数（分）`, field: 'actions' }
        }
        if (mdb < 100) {
          return { valid: false, error: `actions[${i}] max_daily_budget 须 >= 100 分（1 美元）或留空不设上限`, field: 'actions' }
        }
      }
      if (a.type === 'decrease_budget' && hasMinDailyBudget) {
        const mdb = Number(a.min_daily_budget)
        if (!Number.isInteger(mdb) || mdb < 0) {
          return { valid: false, error: `actions[${i}] min_daily_budget 须为非负整数（分）`, field: 'actions' }
        }
        if (mdb < 100) {
          return { valid: false, error: `actions[${i}] min_daily_budget 须 >= 100 分（1 美元）或留空不设下限`, field: 'actions' }
        }
      }
    } else {
      // pause_ad / activate_ad 的 value 可为 null
      if (a.value != null && typeof a.value !== 'number') {
        return { valid: false, error: `actions[${i}] 非预算类动作 value 须为 null 或数字`, field: 'actions' }
      }
      if (a.max_daily_budget != null) {
        const mdb = Number(a.max_daily_budget)
        if (!Number.isInteger(mdb) || mdb < 0) {
          return { valid: false, error: `actions[${i}] max_daily_budget 须为非负整数（分）`, field: 'actions' }
        }
        if (mdb < 100) {
          return { valid: false, error: `actions[${i}] max_daily_budget 须 >= 100 分（1 美元）或留空不设上限`, field: 'actions' }
        }
      }
      if (a.min_daily_budget != null) {
        const mdb = Number(a.min_daily_budget)
        if (!Number.isInteger(mdb) || mdb < 0) {
          return { valid: false, error: `actions[${i}] min_daily_budget 须为非负整数（分）`, field: 'actions' }
        }
        if (mdb < 100) {
          return { valid: false, error: `actions[${i}] min_daily_budget 须 >= 100 分（1 美元）或留空不设下限`, field: 'actions' }
        }
      }
    }
  }
  return { valid: true }
}
