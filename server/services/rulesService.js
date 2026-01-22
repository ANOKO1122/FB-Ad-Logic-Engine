// 规则服务层 - 使用 Drizzle ORM 操作 rules 表
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { db } from '../db/drizzle.js'
import { rules } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'

/**
 * 创建规则
 * @param {number} userId - 用户 ID
 * @param {object} ruleData - 规则数据
 * @returns {Promise<object>} 新创建的规则
 */
export async function createRule(userId, ruleData) {
  // 使用 Drizzle 插入数据
  // 对应 SQL: INSERT INTO rules (user_id, rule_name, target_level, target_ids, conditions, logic_operator, timezone_name, is_simulation, actions, enabled) VALUES (...)
  const result = await db.insert(rules).values({
    userId: userId,
    ruleName: ruleData.ruleName,
    // M3 新增字段（可选，有默认值）
    targetLevel: ruleData.targetLevel || 'ad',
    targetIds: ruleData.targetIds || [],
    conditions: ruleData.conditions,  // Drizzle 自动转为 JSON
    logicOperator: ruleData.logicOperator || 'AND',
    timezoneName: ruleData.timezoneName || 'UTC',
    isSimulation: ruleData.isSimulation ?? false,
    actions: ruleData.actions,         // Drizzle 自动转为 JSON
    enabled: ruleData.enabled ?? true
  })
  
  // 获取新插入的规则 ID
  const newRuleId = result[0].insertId
  
  // 查询并返回完整的规则数据
  const newRule = await db
    .select()
    .from(rules)
    .where(eq(rules.id, newRuleId))
    .limit(1)
  
  return newRule[0]
}

/**
 * 获取用户的所有规则
 * @param {number} userId - 用户 ID
 * @param {object} options - 查询选项
 * @returns {Promise<Array>} 规则列表
 */
export async function getUserRules(userId, options = {}) {
  // 构建查询
  // 对应 SQL: SELECT * FROM rules WHERE user_id = ? [AND enabled = ?] [ORDER BY created_at DESC]
  let query = db.select().from(rules).where(eq(rules.userId, userId))
  
  // 如果只查询启用的规则
  if (options.onlyEnabled) {
    query = query.where(and(eq(rules.userId, userId), eq(rules.enabled, true)))
  }
  
  // 排序（默认按创建时间倒序）
  if (options.orderBy === 'createdAt' || !options.orderBy) {
    query = query.orderBy(desc(rules.createdAt))
  }
  
  // 分页
  if (options.limit) {
    query = query.limit(options.limit)
    if (options.offset) {
      query = query.offset(options.offset)
    }
  }
  
  const userRules = await query
  return userRules
}

/**
 * 根据 ID 获取规则（带用户验证）
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @returns {Promise<object|null>} 规则对象或 null
 */
export async function getRuleById(ruleId, userId) {
  // 对应 SQL: SELECT * FROM rules WHERE id = ? AND user_id = ?
  const result = await db
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.id, ruleId),
        eq(rules.userId, userId)  // 确保只能查询自己的规则
      )
    )
    .limit(1)
  
  return result[0] || null
}

/**
 * 更新规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {object} updates - 要更新的字段
 * @returns {Promise<object>} 更新结果
 */
export async function updateRule(ruleId, userId, updates) {
  // 对应 SQL: UPDATE rules SET ... WHERE id = ? AND user_id = ?
  const result = await db
    .update(rules)
    .set({
      ...updates,
      updatedAt: new Date()  // 自动更新更新时间
    })
    .where(
      and(
        eq(rules.id, ruleId),
        eq(rules.userId, userId)  // 确保只能更新自己的规则
      )
    )
  
  if (result[0].affectedRows === 0) {
    throw new Error('规则不存在或无权访问')
  }
  
  // 返回更新后的规则
  const updatedRule = await getRuleById(ruleId, userId)
  return updatedRule
}

/**
 * 删除规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteRule(ruleId, userId) {
  // 对应 SQL: DELETE FROM rules WHERE id = ? AND user_id = ?
  const result = await db
    .delete(rules)
    .where(
      and(
        eq(rules.id, ruleId),
        eq(rules.userId, userId)  // 确保只能删除自己的规则
      )
    )
  
  if (result[0].affectedRows === 0) {
    throw new Error('规则不存在或无权访问')
  }
  
  return true
}

/**
 * 启用/禁用规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} enabled - 是否启用
 * @returns {Promise<object>} 更新后的规则
 */
export async function toggleRule(ruleId, userId, enabled) {
  // 对应 SQL: UPDATE rules SET enabled = ? WHERE id = ? AND user_id = ?
  return await updateRule(ruleId, userId, { enabled })
}


