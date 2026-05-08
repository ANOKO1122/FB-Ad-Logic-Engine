/**
 * 规则×冷却键执行状态服务（迁移 031：scope_key 统一冷却键）
 * 供 cronService 与 actionExecutorService 复用，避免循环依赖。
 * 策略 B：提供 isCooldownDue(ruleId, scopeKey, intervalMin) 封装「查表 + 是否到期」。
 * 使用约定：调度层用 loadRuleAdExecutionState 批量查 + 本地 diffMin 比较；执行层可按需用 isCooldownDue 单键判断。
 */
import pool from '../db/connection.js'
import logger from '../utils/logger.js'
import { DateTime } from 'luxon'

/**
 * 批量查询规则×冷却键的最后执行时间
 * @param {number} ruleId
 * @param {string[]} scopeKeys - 冷却键列表，如 ['ad:123', 'budget_campaign:456']
 * @returns {Promise<Map<string, Date>>} scopeKey -> last_executed_at (UTC Date)
 */
export async function loadRuleAdExecutionState(ruleId, scopeKeys) {
  const map = new Map()
  if (!scopeKeys?.length) return map
  const uniq = [...new Set(scopeKeys)]
  const placeholders = uniq.map(() => '?').join(',')
  try {
    const [rows] = await pool.execute(
      `SELECT scope_key, last_executed_at FROM rule_ad_execution_state WHERE rule_id = ? AND scope_key IN (${placeholders})`,
      [ruleId, ...uniq]
    )
    for (const row of rows) {
      const key = String(row?.scope_key ?? '').trim()
      const at = row?.last_executed_at
      if (key) map.set(key, at ? new Date(at) : null)
    }
  } catch (err) {
    logger.warn(`   ⚠️  loadRuleAdExecutionState(rule=${ruleId}) 失败:`, err.message)
  }
  return map
}

/**
 * 判断指定 (ruleId, scopeKey) 是否已过冷却期（策略 B：查表 + 比较封装为一处）
 * @param {number} ruleId
 * @param {string} scopeKey
 * @param {number} intervalMin - 规则配置的执行间隔（分钟）
 * @returns {Promise<boolean>} true = 可执行（已到期或从未执行）
 */
export async function isCooldownDue(ruleId, scopeKey, intervalMin) {
  // intervalMin <= 0 视为无冷却限制
  if (!intervalMin || intervalMin <= 0) return true

  try {
    // 直接在 MySQL 里用 UTC 基准计算「距上次执行的分钟数」，避免 JS 与 DB 时区/解析差异
    const [rows] = await pool.execute(
      `SELECT 
         last_executed_at,
         TIMESTAMPDIFF(MINUTE, last_executed_at, UTC_TIMESTAMP()) AS diff_min
       FROM rule_ad_execution_state
       WHERE rule_id = ? AND scope_key = ?`,
      [ruleId, scopeKey]
    )

    // 没有记录：说明从未执行，视为冷却已到期
    if (!rows || rows.length === 0) {
      logger.debug(
        `   [ruleExecutionState] isCooldownDue(DB) rule=${ruleId} scope=${scopeKey} interval=${intervalMin} lastAt=null diffMin=Infinity due=true`
      )
      return true
    }

    const row = rows[0]
    const lastAt = row.last_executed_at
    const diffMin = Number(row.diff_min ?? 0)
    const due = diffMin >= intervalMin

    try {
      const lastAtUtc = lastAt ? new Date(lastAt).toISOString() : 'null'
      const lastAtBj = lastAt
        ? DateTime.fromJSDate(new Date(lastAt), { zone: 'utc' }).setZone('Asia/Shanghai').toFormat('yyyy-MM-dd HH:mm:ss')
        : 'null'
      logger.debug(
        `   [ruleExecutionState] isCooldownDue(DB) rule=${ruleId} scope=${scopeKey} interval=${intervalMin} lastAtUtc=${lastAtUtc} lastAtBj=${lastAtBj} diffMin=${diffMin.toFixed(2)} due=${due}`
      )
    } catch {
      // 日志失败不影响主流程
    }

    return due
  } catch (err) {
    // 查询失败时，为避免中断主流程，保守放行一次，并打印告警
    logger.warn(
      `   ⚠️  isCooldownDue(DB) 查询失败，退化为允许执行 rule=${ruleId} scope=${scopeKey}: ${err.message}`
    )
    return true
  }
}

/**
 * 批量写入规则×冷却键状态（ON DUPLICATE KEY UPDATE）
 * 迁移 031 后主键为 (rule_id, scope_key)；ad_id 仅回填兼容（ad:/status_ad: 前缀时写入，非 ad 键写空串以满足 NOT NULL）
 * @param {Array<{ ruleId: number, scopeKey: string, lastStatus: string }>} entries
 */
export async function upsertRuleAdExecutionStateBatch(entries) {
  if (!entries?.length) return
  const validStatus = ['success', 'fail', 'suppressed', 'outside_window']
  try {
    for (const { ruleId, scopeKey, lastStatus } of entries) {
      const status = validStatus.includes(lastStatus) ? lastStatus : null
      // 表 ad_id 为 NOT NULL：仅 ad/status_ad 前缀回填 ad_id，其余写空串
      let adIdVal = ''
      if (scopeKey.startsWith('status_ad:')) {
        adIdVal = scopeKey.slice('status_ad:'.length)
      } else if (scopeKey.startsWith('ad:')) {
        adIdVal = scopeKey.slice(3)
      }
      await pool.execute(
        `INSERT INTO rule_ad_execution_state (rule_id, scope_key, last_executed_at, last_status, ad_id)
         VALUES (?, ?, UTC_TIMESTAMP(), ?, ?)
         ON DUPLICATE KEY UPDATE last_executed_at = VALUES(last_executed_at), last_status = VALUES(last_status)`,
        [ruleId, scopeKey, status, adIdVal]
      )
    }
  } catch (err) {
    logger.warn('   ⚠️  upsertRuleAdExecutionStateBatch 失败:', err.message)
  }
}
