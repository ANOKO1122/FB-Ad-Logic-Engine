/**
 * 2.3.1 方案B：线性条件列表 ↔ v2 DNF 转换
 * 用于 RuleManager 触发条件编辑
 */

/**
 * 线性 → v2 DNF：AND 追加到当前组，OR 开启新组
 * @param {Array} lines - [{ join, metric, operator, value }]，首行 join 为 null
 * @param {string} timeWindow - 全局 time_window
 * @param {object|null} customRange - { since, until } | null
 * @returns {{ version: 2, groups: Array }}
 */
export function linesToV2Groups(lines, timeWindow, customRange) {
  const groups = []
  let currentGroup = []
  for (const line of lines) {
    const cond = {
      metric: line.metric,
      operator: line.operator,
      value: line.value,
      time_window: timeWindow
    }
    if (customRange && timeWindow === 'custom_range') {
      cond.custom_range = { ...customRange }
    }
    if (line.join === 'OR') {
      if (currentGroup.length > 0) {
        groups.push({ operator: 'AND', conditions: currentGroup })
      }
      currentGroup = [cond]
    } else {
      currentGroup.push(cond)
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ operator: 'AND', conditions: currentGroup })
  }
  return { version: 2, groups }
}

/**
 * v2 DNF → 线性：组内 AND，跨组首条 OR
 * @param {object} v2 - { version: 2, groups }
 * @returns {{ lines: Array, timeWindow: string, customRange: object|null }}
 */
export function v2ToLines(v2) {
  const lines = []
  let timeWindow = 'today'
  let customRange = null
  if (!v2?.groups) return { lines, timeWindow, customRange }
  for (let i = 0; i < v2.groups.length; i++) {
    const group = v2.groups[i]
    for (let j = 0; j < (group?.conditions || []).length; j++) {
      const c = group.conditions[j]
      if (i === 0 && j === 0) {
        timeWindow = c.time_window || 'today'
        customRange = c.custom_range || null
      }
      const join = (i === 0 && j === 0) ? null : (j === 0 ? 'OR' : 'AND')
      lines.push({
        join,
        metric: c.metric,
        operator: c.operator,
        value: c.value
      })
    }
  }
  return { lines, timeWindow, customRange }
}

/**
 * v1 数组 → 线性：除首行外 join 均为 logicOperator
 * @param {Array} v1Array - v1 conditions
 * @param {string} logicOperator - 'AND' | 'OR'
 * @returns {{ lines: Array, timeWindow: string, customRange: object|null }}
 */
export function v1ToLines(v1Array, logicOperator) {
  const arr = Array.isArray(v1Array) ? v1Array : []
  let timeWindow = 'today'
  let customRange = null
  if (arr.length > 0) {
    const first = arr[0]
    timeWindow = first.time_window || 'today'
    customRange = first.time_window === 'custom_range' && first.custom_range
      ? { ...first.custom_range } : null
  }
  const lines = arr.map((c, i) => ({
    join: i === 0 ? null : logicOperator,
    metric: c.metric,
    operator: c.operator,
    value: c.value
  }))
  return { lines, timeWindow, customRange }
}

/** 创建默认条件行 */
export function createDefaultWhenLine(join = null) {
  return {
    join,
    metric: 'spend',
    operator: 'gt',
    value: 0
  }
}

/** 默认 custom_range（当天） */
export function getDefaultWhenCustomRange() {
  const t = new Date().toISOString().slice(0, 10)
  return { since: t, until: t }
}
