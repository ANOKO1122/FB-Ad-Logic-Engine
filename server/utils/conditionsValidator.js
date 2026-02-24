/**
 * 条件组校验与归一化（DNF：OR of AND Groups）
 * 支持 v1（扁平 conditions + logicOperator）与 v2（groups 结构）
 */

/**
 * 校验 conditions 结构：允许 v1 array 或 v2 object
 * @param {any} conditions - 规则条件
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateConditionsStructure(conditions) {
  if (!conditions) {
    return { valid: false, error: 'conditions 不能为空' }
  }

  // v1: 数组，非空
  if (Array.isArray(conditions)) {
    if (conditions.length === 0) return { valid: false, error: 'conditions 不能为空数组' }
    for (const c of conditions) {
      if (!c || typeof c !== 'object' || !c.metric || c.operator == null) {
        return { valid: false, error: 'v1 conditions 每项须含 metric、operator' }
      }
    }
    return { valid: true }
  }

  // v2: 对象，version=2，groups 为非空数组
  if (typeof conditions !== 'object') {
    return { valid: false, error: 'conditions 须为数组或对象' }
  }
  if (conditions.version !== 2) {
    return { valid: false, error: 'v2 conditions 须含 version: 2' }
  }
  if (!Array.isArray(conditions.groups) || conditions.groups.length === 0) {
    return { valid: false, error: 'v2 conditions 须含非空 groups 数组' }
  }
  for (const g of conditions.groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.conditions) || g.conditions.length === 0) {
      return { valid: false, error: 'v2 每个 group 须含非空 conditions 数组' }
    }
    if (g.operator != null && String(g.operator).toUpperCase() !== 'AND') {
      return { valid: false, error: 'v2 组内仅支持 AND，当前评估固定为组内 AND' }
    }
    for (const c of g.conditions) {
      if (!c || typeof c !== 'object' || !c.metric || c.operator == null) {
        return { valid: false, error: 'v2 条件须含 metric、operator' }
      }
    }
  }
  return { valid: true }
}

/**
 * 校验同规则内 time_window / custom_range 一致（v2 专用）
 * @param {object} conditions - v2 结构
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTimeWindowConsistency(conditions) {
  if (!conditions || conditions.version !== 2 || !Array.isArray(conditions.groups)) {
    return { valid: true } // 非 v2 跳过
  }

  let firstTimeWindow = null
  let firstCustomRange = null

  for (const g of conditions.groups) {
    for (const c of g.conditions || []) {
      const tw = c.time_window || 'today'
      const cr = c.time_window === 'custom_range' ? (c.custom_range || {}) : null

      if (firstTimeWindow == null) firstTimeWindow = tw
      else if (firstTimeWindow !== tw) {
        return { valid: false, error: `同规则内 time_window 须一致，发现 ${firstTimeWindow} 与 ${tw}` }
      }

      if (cr) {
        const key = `${cr.since || ''}_${cr.until || ''}`
        if (firstCustomRange == null) firstCustomRange = key
        else if (firstCustomRange !== key) {
          return { valid: false, error: '同规则内 custom_range 须一致' }
        }
      }
    }
  }
  return { valid: true }
}

/**
 * 归一化为 v2 结构（用于评估）
 * @param {any} conditions - v1 数组或 v2 对象
 * @param {string} logicOperator - v1 的 logicOperator（'AND'|'OR'）
 * @returns {{ version: 2, groups: Array<{ operator: string, conditions: Array }> }}
 */
export function normalizeConditionsToV2(conditions, logicOperator = 'AND') {
  if (!conditions) {
    return { version: 2, groups: [] }
  }

  // v2 直接返回
  if (conditions.version === 2 && Array.isArray(conditions.groups)) {
    return conditions
  }

  // v1 转 v2
  if (Array.isArray(conditions)) {
    if (conditions.length === 0) return { version: 2, groups: [] }
    if (logicOperator === 'OR') {
      // v1 OR → 多个单条件组
      return {
        version: 2,
        groups: conditions.map(c => ({ operator: 'AND', conditions: [c] }))
      }
    }
    // v1 AND → 单组多条件
    return {
      version: 2,
      groups: [{ operator: 'AND', conditions: [...conditions] }]
    }
  }

  return { version: 2, groups: [] }
}

/**
 * 从归一化后的 v2 结构中收集所有条件（扁平化）
 * 用于 getTimeWindowFromConditions / getCustomRangeFromConditions 遍历
 */
export function getAllConditionsFromV2(normalized) {
  if (!normalized?.groups) return []
  const list = []
  for (const g of normalized.groups) {
    for (const c of g.conditions || []) {
      list.push(c)
    }
  }
  return list
}
