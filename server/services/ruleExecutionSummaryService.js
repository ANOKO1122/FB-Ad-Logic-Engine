/**
 * 规则执行摘要服务
 * 用途：记录每次规则评估的摘要，用于系统层可观测性
 */

import pool from '../db/connection.js'
import logger from '../utils/logger.js'

/**
 * 插入规则执行摘要
 * @param {Object} summary - 摘要对象
 * @param {string} summary.runId - 运行批次ID
 * @param {number} summary.ruleId - 规则ID
 * @param {string} summary.ruleName - 规则名称
 * @param {string} summary.accountId - 广告账户ID
 * @param {number} summary.userId - 用户ID
 * @param {number} summary.ownerId - owner_id
 * @param {number} summary.matchedCount - 匹配数量
 * @param {number} summary.executedCount - 执行成功数量
 * @param {number} summary.failedCount - 执行失败数量
 * @param {number} summary.skippedCount - 跳过数量
 * @param {string} summary.status - 状态：matched/no_match/skipped/error
 * @param {string} summary.skipReason - 跳过原因：cooldown/no_permission/account_mismatch/user_not_found/no_match/error/suppressed_by_priority（M4）/muted/account_inactive
 * @param {Object} summary.skipDetails - 跳过详情（JSON对象）
 * @param {string} summary.errorMessage - 错误信息（已脱敏）
 * @param {number} summary.durationMs - 耗时（毫秒）
 * @param {Date} summary.evaluatedAt - 评估时间
 */
export async function insertRuleExecutionSummary(summary) {
  try {
    const sql = `
      INSERT INTO rule_execution_summaries (
        run_id, rule_id, rule_name, account_id, user_id, owner_id,
        matched_count, executed_count, failed_count, skipped_count,
        status, skip_reason, skip_details, error_message, duration_ms, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    
    // ✅ 确保 evaluatedAt 是 UTC 时间字符串（避免时区转换问题）
    let evaluatedAt = summary.evaluatedAt || new Date()
    if (evaluatedAt instanceof Date) {
      // 转换为 UTC 时间字符串：YYYY-MM-DD HH:MM:SS
      const year = evaluatedAt.getUTCFullYear()
      const month = String(evaluatedAt.getUTCMonth() + 1).padStart(2, '0')
      const day = String(evaluatedAt.getUTCDate()).padStart(2, '0')
      const hours = String(evaluatedAt.getUTCHours()).padStart(2, '0')
      const minutes = String(evaluatedAt.getUTCMinutes()).padStart(2, '0')
      const seconds = String(evaluatedAt.getUTCSeconds()).padStart(2, '0')
      evaluatedAt = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    }
    
    const params = [
      summary.runId,
      summary.ruleId,
      summary.ruleName,
      summary.accountId,
      summary.userId,
      summary.ownerId || 0,
      summary.matchedCount || 0,
      summary.executedCount || 0,
      summary.failedCount || 0,
      summary.skippedCount || 0,
      summary.status || null,
      summary.skipReason || null,
      summary.skipDetails ? JSON.stringify(summary.skipDetails) : null,  // MySQL JSON 列需要 stringify
      summary.errorMessage || null,
      summary.durationMs || 0,
      evaluatedAt  // ✅ 使用显式转换的 UTC 时间字符串
    ]
    
    await pool.execute(sql, params)
  } catch (error) {
    // 摘要记录失败不应该影响规则执行，只记录错误
    logger.error('❌ 插入规则执行摘要失败:', error.message)
  }
}

/**
 * 脱敏错误信息（避免敏感信息泄露）
 * @param {string} errorMessage - 原始错误信息
 * @param {number} maxLength - 最大长度（默认500）
 * @returns {string} 脱敏后的错误信息
 */
export function sanitizeErrorMessage(errorMessage, maxLength = 500) {
  if (!errorMessage) return null
  
  let sanitized = String(errorMessage)
  
  // 移除可能的敏感信息
  sanitized = sanitized.replace(/token[=:]\s*[\w-]+/gi, 'token=***')
  sanitized = sanitized.replace(/password[=:]\s*\S+/gi, 'password=***')
  sanitized = sanitized.replace(/authorization[=:]\s*\S+/gi, 'authorization=***')
  
  // 截断
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength - 3) + '...'
  }
  
  return sanitized
}

/**
 * 生成 run_id
 * @returns {string} run_id 格式：timestamp-randomString
 */
export function generateRunId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}
