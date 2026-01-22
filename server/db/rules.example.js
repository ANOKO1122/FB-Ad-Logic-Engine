// Drizzle ORM 使用示例
// 这个文件仅作为参考，展示如何使用 Drizzle 操作 rules 表
// 实际使用时，请将这些代码集成到相应的路由或服务中

import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, and } from 'drizzle-orm'

// 示例 1：创建规则
export async function createRule(ruleData) {
  const newRule = await db.insert(rules).values({
    userId: ruleData.userId,
    ruleName: ruleData.ruleName,
    conditions: ruleData.conditions,  // JSON 格式
    actions: ruleData.actions,         // JSON 格式
    enabled: ruleData.enabled ?? true
  })
  
  return newRule
}

// 示例 2：查询用户的所有规则
export async function getUserRules(userId) {
  const userRules = await db
    .select()
    .from(rules)
    .where(eq(rules.userId, userId))
  
  return userRules
}

// 示例 3：查询启用的规则
export async function getEnabledRules(userId) {
  const enabledRules = await db
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.userId, userId),
        eq(rules.enabled, true)
      )
    )
  
  return enabledRules
}

// 示例 4：更新规则
export async function updateRule(ruleId, updates) {
  const updated = await db
    .update(rules)
    .set({
      ...updates,
      updatedAt: new Date()
    })
    .where(eq(rules.id, ruleId))
  
  return updated
}

// 示例 5：删除规则
export async function deleteRule(ruleId) {
  const deleted = await db
    .delete(rules)
    .where(eq(rules.id, ruleId))
  
  return deleted
}

// 示例 6：启用/禁用规则
export async function toggleRule(ruleId, enabled) {
  const updated = await db
    .update(rules)
    .set({ enabled })
    .where(eq(rules.id, ruleId))
  
  return updated
}


