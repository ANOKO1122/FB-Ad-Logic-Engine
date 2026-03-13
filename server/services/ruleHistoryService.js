// 规则配置变更历史服务（历史数据与审计方案 P0）
// 仅负责向 rule_history 表插入记录，不参与业务事务
import pool from '../db/connection.js'
import logger from '../utils/logger.js'

/** 方案 3.2：rule_snapshot 只存配置字段，严禁运行时/统计字段 */
const SNAPSHOT_KEYS = [
  'rule_name', 'target_level', 'target_ids', 'target_by_account', 'target_account_ids',
  'scope_filters', 'use_dynamic_scope', 'exclude_ids', 'max_dynamic_matches',
  'conditions', 'logic_operator', 'actions', 'enabled', 'timezone_name',
  'is_simulation', 'execution_interval_minutes', 'execution_time_windows'
]

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
    addedIds = null,
    removedIds = null,
    connection: conn = null
  } = opts

  const sql = `INSERT INTO rule_history (
    rule_id, change_type, source, changed_by_user_id, changed_by_owner_id,
    rule_snapshot, added_ids, removed_ids
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  const snapshotJson = ruleSnapshot != null ? JSON.stringify(ruleSnapshot) : null
  const addedJson = addedIds != null ? JSON.stringify(addedIds) : null
  const removedJson = removedIds != null ? JSON.stringify(removedIds) : null
  const params = [ruleId, changeType, source, changedByUserId ?? null, changedByOwnerId ?? null, snapshotJson, addedJson, removedJson]

  if (conn) {
    await conn.execute(sql, params)
    return
  }
  await pool.execute(sql, params)
}
