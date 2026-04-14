// 规则配置变更历史服务（历史数据与审计方案 P0）
// 仅负责向 rule_history 表插入记录，不参与业务事务
import pool from '../db/connection.js'
import logger from '../utils/logger.js'

/** 方案 3.2：rule_snapshot 只存配置字段，严禁运行时/统计字段（与 diff 口径一致） */
export const SNAPSHOT_KEYS = [
  'rule_name', 'target_level', 'target_ids', 'target_by_account', 'target_account_ids',
  'scope_filters', 'use_dynamic_scope', 'exclude_ids', 'max_dynamic_matches',
  'conditions', 'logic_operator', 'actions', 'enabled', 'timezone_name',
  'is_simulation', 'execution_interval_minutes', 'execution_time_windows'
]

/** 管理端审计展示用中文字段名 */
export const SNAPSHOT_FIELD_LABELS = {
  rule_name: '规则名称',
  target_level: '目标层级',
  target_ids: '目标 ID 列表',
  target_by_account: '按账户分组目标',
  target_account_ids: '目标广告账户',
  scope_filters: '动态筛选条件',
  use_dynamic_scope: '启用动态筛选',
  exclude_ids: '排除名单',
  max_dynamic_matches: '动态匹配上限',
  conditions: 'IF 条件',
  logic_operator: '条件逻辑',
  actions: 'THEN 动作',
  enabled: '是否启用',
  timezone_name: '时区',
  is_simulation: '模拟运行',
  execution_interval_minutes: '执行间隔(分钟)',
  execution_time_windows: '执行时间窗'
}

function stableStringify(v) {
  if (v === null || v === undefined) return String(v)
  const t = typeof v
  if (t !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',')}}`
}

function snapshotValuesEqual(a, b) {
  return stableStringify(a) === stableStringify(b)
}

/**
 * 对比变更前后快照，产出字段级差异（仅 SNAPSHOT_KEYS）
 * @param {object|null} before
 * @param {object|null} after
 * @returns {{ changes: Array<{ field: string, label: string, before: unknown, after: unknown }> }}
 */
export function diffRuleSnapshots(before, after) {
  const changes = []
  const beforeObj = before && typeof before === 'object' ? before : {}
  const afterObj = after && typeof after === 'object' ? after : {}
  for (const key of SNAPSHOT_KEYS) {
    const hasB = Object.prototype.hasOwnProperty.call(beforeObj, key)
    const hasA = Object.prototype.hasOwnProperty.call(afterObj, key)
    if (!hasB && !hasA) continue
    const bv = hasB ? beforeObj[key] : undefined
    const av = hasA ? afterObj[key] : undefined
    if (snapshotValuesEqual(bv, av)) continue
    changes.push({
      field: key,
      label: SNAPSHOT_FIELD_LABELS[key] || key,
      before: hasB ? bv : undefined,
      after: hasA ? av : undefined
    })
  }
  return { changes }
}

/**
 * 从规则行对象中提取仅配置字段，用于 rule_history.rule_snapshot（严禁 matched_count、dynamic_scope_status 等）
 * @param {object} rule - 来自 rules 表的行（含蛇形/驼峰均可）
 * @returns {object|null} 窄化后的对象，若无可写字段则返回 null
 */
export function buildRuleSnapshot(rule) {
  if (!rule || typeof rule !== 'object') return null
  const out = {}
  const raw = { ...rule }
  // 兼容驼峰字段名
  if (raw.ruleName !== undefined) raw.rule_name = raw.ruleName
  if (raw.targetLevel !== undefined) raw.target_level = raw.targetLevel
  if (raw.targetIds !== undefined) raw.target_ids = raw.targetIds
  if (raw.targetByAccount !== undefined) raw.target_by_account = raw.targetByAccount
  if (raw.targetAccountIds !== undefined) raw.target_account_ids = raw.targetAccountIds
  if (raw.scopeFilters !== undefined) raw.scope_filters = raw.scopeFilters
  if (raw.useDynamicScope !== undefined) raw.use_dynamic_scope = raw.useDynamicScope
  if (raw.excludeIds !== undefined) raw.exclude_ids = raw.excludeIds
  if (raw.maxDynamicMatches !== undefined) raw.max_dynamic_matches = raw.maxDynamicMatches
  if (raw.logicOperator !== undefined) raw.logic_operator = raw.logicOperator
  if (raw.timezoneName !== undefined) raw.timezone_name = raw.timezoneName
  if (raw.isSimulation !== undefined) raw.is_simulation = raw.isSimulation
  if (raw.executionIntervalMinutes !== undefined) raw.execution_interval_minutes = raw.executionIntervalMinutes
  if (raw.executionTimeWindows !== undefined) raw.execution_time_windows = raw.executionTimeWindows

  for (const key of SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key]
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * 向 rule_history 插入一条记录（不开启事务，由调用方保证在事务内或独立调用）
 * @param {object} opts
 * @param {number} opts.ruleId - 规则 ID
 * @param {string} opts.changeType - CREATE | UPDATE | DELETE | TOGGLE | SYSTEM_REFRESH
 * @param {string} opts.source - api_save | api_toggle | dynamic_scope_refresh
 * @param {number|null} [opts.changedByUserId] - 操作用户 ID，系统刷新为 null
 * @param {number|null} [opts.changedByOwnerId] - 负责人 ID，可选
 * @param {object|null} [opts.ruleSnapshot] - 规则配置快照（建议用 buildRuleSnapshot(rule)）
 * @param {object|null} [opts.snapshotBefore] - UPDATE/TOGGLE 时变更前快照（buildRuleSnapshot 旧行）
 * @param {Array|null} [opts.addedIds] - 可选，排障用
 * @param {Array|null} [opts.removedIds] - 可选，排障用
 * @param {import('mysql2/promise').PoolConnection} [opts.connection] - 若在事务内插入，传入同一 connection
 */
export async function insertRuleHistory(opts) {
  const {
    ruleId,
    changeType,
    source,
    changedByUserId = null,
    changedByOwnerId = null,
    ruleSnapshot = null,
    snapshotBefore = null,
    addedIds = null,
    removedIds = null,
    connection: conn = null
  } = opts

  const sql = `INSERT INTO rule_history (
    rule_id, change_type, source, changed_by_user_id, changed_by_owner_id,
    rule_snapshot, snapshot_before, added_ids, removed_ids
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  const snapshotJson = ruleSnapshot != null ? JSON.stringify(ruleSnapshot) : null
  const beforeJson = snapshotBefore != null ? JSON.stringify(snapshotBefore) : null
  const addedJson = addedIds != null ? JSON.stringify(addedIds) : null
  const removedJson = removedIds != null ? JSON.stringify(removedIds) : null
  const params = [
    ruleId,
    changeType,
    source,
    changedByUserId ?? null,
    changedByOwnerId ?? null,
    snapshotJson,
    beforeJson,
    addedJson,
    removedJson
  ]

  if (conn) {
    await conn.execute(sql, params)
    return
  }
  await pool.execute(sql, params)
}
