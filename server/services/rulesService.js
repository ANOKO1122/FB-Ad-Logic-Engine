// 规则服务层 - 使用 Drizzle ORM 操作 rules 表
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { db } from '../db/drizzle.js'
import { rules } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { getAccountTimezone } from './ruleDataService.js'
import pool from '../db/connection.js'

/**
 * 创建规则
 * @param {number} userId - 用户 ID
 * @param {object} ruleData - 规则数据
 * @returns {Promise<object>} 新创建的规则
 */
export async function createRule(userId, ruleData) {
  // 时区：空字符串/全空格/'UTC' 视为未指定，落库用账户时区
  const tzRaw = ruleData.timezoneName ?? ruleData.timezone_name
  const tzNorm = typeof tzRaw === 'string' ? tzRaw.trim() : ''
  const timezoneName = (!tzNorm || tzNorm === 'UTC')
    ? await getAccountTimezone(ruleData.accountId)
    : tzNorm
  // 使用 Drizzle 插入数据
  // 对应 SQL: INSERT INTO rules (user_id, account_id, rule_name, target_level, target_ids, conditions, logic_operator, timezone_name, is_simulation, actions, enabled) VALUES (...)
  const result = await db.insert(rules).values({
    userId: userId,
    accountId: ruleData.accountId,
    ruleName: ruleData.ruleName,
    targetLevel: ruleData.targetLevel || 'ad',
    targetIds: ruleData.targetIds || [],
    targetAccountIds: ruleData.targetAccountIds ?? null,
    targetByAccount: ruleData.targetByAccount ?? null,
    conditions: ruleData.conditions,
    logicOperator: ruleData.logicOperator || 'AND',
    timezoneName,
    isSimulation: ruleData.isSimulation ?? false,
    actions: ruleData.actions,
    enabled: ruleData.enabled ?? true,
    executionIntervalMinutes: ruleData.executionIntervalMinutes ?? ruleData.execution_interval_minutes ?? 15,
    executionTimeWindows: ruleData.executionTimeWindows ?? ruleData.execution_time_windows ?? null,
    useDynamicScope: ruleData.useDynamicScope ?? true,
    scopeFilters: ruleData.scopeFilters ?? null,
    excludeIds: ruleData.excludeIds ?? null,
    maxDynamicMatches: ruleData.maxDynamicMatches ?? 1000
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
 * @param {boolean} options.isAdmin - 是否为管理员（管理员可查看所有规则）
 * @returns {Promise<Array>} 规则列表
 */
export async function getUserRules(userId, options = {}) {
  // 构建查询
  // admin 用户可以查看所有规则，普通用户只能查看自己的规则
  let query = db.select().from(rules)
  
  // 非 admin 用户：只查询自己的规则
  if (!options.isAdmin) {
    query = query.where(eq(rules.userId, userId))
    
    // 如果只查询启用的规则
    if (options.onlyEnabled) {
      query = db.select().from(rules).where(and(eq(rules.userId, userId), eq(rules.enabled, true)))
    }
  } else {
    // admin 用户：查看所有规则（可选只查启用的）
    if (options.onlyEnabled) {
      query = query.where(eq(rules.enabled, true))
    }
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
 * @param {boolean} isAdmin - 是否为管理员（管理员可查看所有规则）
 * @returns {Promise<object|null>} 规则对象或 null
 */
export async function getRuleById(ruleId, userId, isAdmin = false) {
  // 构建查询条件
  let whereCondition = eq(rules.id, ruleId)
  
  // 非管理员用户：只能查询自己的规则
  if (!isAdmin) {
    whereCondition = and(whereCondition, eq(rules.userId, userId))
  }
  
  // 对应 SQL: SELECT * FROM rules WHERE id = ? [AND user_id = ?]
  const result = await db
    .select()
    .from(rules)
    .where(whereCondition)
    .limit(1)
  
  return result[0] || null
}

/**
 * 更新规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {object} updates - 要更新的字段
 * @param {boolean} isAdmin - 是否为管理员（管理员可更新所有规则）
 * @returns {Promise<object>} 更新结果
 */
export async function updateRule(ruleId, userId, updates, isAdmin = false) {
  // 构建查询条件
  let whereCondition = eq(rules.id, ruleId)
  
  // 非管理员用户：只能更新自己的规则
  if (!isAdmin) {
    whereCondition = and(whereCondition, eq(rules.userId, userId))
  }
  
  // 对应 SQL: UPDATE rules SET ... WHERE id = ? [AND user_id = ?]
  const result = await db
    .update(rules)
    .set({
      ...updates,
      updatedAt: new Date()  // 自动更新更新时间
    })
    .where(whereCondition)
  
  if (result[0].affectedRows === 0) {
    throw new Error('规则不存在或无权访问')
  }
  
  // 返回更新后的规则（管理员可以查看所有规则）
  const updatedRule = await getRuleById(ruleId, userId, isAdmin)
  return updatedRule
}

/**
 * 删除规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} isAdmin - 是否为管理员（管理员可删除所有规则）
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteRule(ruleId, userId, isAdmin = false) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    const deleteRuleSql = isAdmin
      ? 'DELETE FROM rules WHERE id = ? LIMIT 1'
      : 'DELETE FROM rules WHERE id = ? AND user_id = ? LIMIT 1'
    const deleteRuleParams = isAdmin ? [ruleId] : [ruleId, userId]
    const [ruleResult] = await connection.execute(deleteRuleSql, deleteRuleParams)

    if (!ruleResult || ruleResult.affectedRows === 0) {
      await connection.rollback()
      throw new Error('规则不存在或无权访问')
    }

    // 联动清理动态快照，避免留下 rule_matched_objects 孤儿数据
    await connection.execute(
      'DELETE FROM rule_matched_objects WHERE rule_id = ?',
      [ruleId]
    )

    await connection.commit()
    return true
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch {}
    }
    throw error
  } finally {
    connection.release()
  }
}

/**
 * 启用/禁用规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} enabled - 是否启用
 * @param {boolean} isAdmin - 是否为管理员（管理员可操作所有规则）
 * @returns {Promise<object>} 更新后的规则
 */
export async function toggleRule(ruleId, userId, enabled, isAdmin = false) {
  // 对应 SQL: UPDATE rules SET enabled = ? WHERE id = ? [AND user_id = ?]
  return await updateRule(ruleId, userId, { enabled }, isAdmin)
}


