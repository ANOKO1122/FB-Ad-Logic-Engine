// 实际开发示例：如何在 API 路由中使用 Drizzle
// 
// ⚠️ 这是实际开发中应该使用的代码
// ✅ 所有 CRUD 操作都用 Drizzle
// ❌ 不要手写 SQL 字符串

import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, and, desc } from 'drizzle-orm'

// ============================================
// 示例 1：创建规则 API（POST /api/rules）
// ============================================
export async function createRule(userId, ruleData) {
  // ✅ 使用 Drizzle：类型安全、自动处理 JSON
  const newRule = await db.insert(rules).values({
    userId: userId,
    ruleName: ruleData.ruleName,
    conditions: ruleData.conditions,  // Drizzle 自动转为 JSON
    actions: ruleData.actions,         // Drizzle 自动转为 JSON
    enabled: ruleData.enabled ?? true
  })
  
  return {
    id: newRule[0].insertId,
    message: '规则创建成功'
  }
}

// ❌ 不要这样做（手写 SQL）：
// const [result] = await pool.query(
//   'INSERT INTO rules (user_id, rule_name, conditions, actions) VALUES (?, ?, ?, ?)',
//   [userId, ruleData.ruleName, JSON.stringify(ruleData.conditions), JSON.stringify(ruleData.actions)]
// )

// ============================================
// 示例 2：获取用户规则列表 API（GET /api/rules）
// ============================================
export async function getUserRules(userId, options = {}) {
  // ✅ 使用 Drizzle：链式调用，易读易维护
  let query = db.select().from(rules).where(eq(rules.userId, userId))
  
  // 如果只查询启用的规则
  if (options.onlyEnabled) {
    query = query.where(and(eq(rules.userId, userId), eq(rules.enabled, true)))
  }
  
  // 排序
  if (options.orderBy === 'createdAt') {
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

// ❌ 不要这样做（手写 SQL）：
// const [rows] = await pool.query(
//   'SELECT * FROM rules WHERE user_id = ? AND enabled = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
//   [userId, true, limit, offset]
// )

// ============================================
// 示例 3：更新规则 API（PUT /api/rules/:id）
// ============================================
export async function updateRule(ruleId, userId, updates) {
  // ✅ 使用 Drizzle：只更新提供的字段
  const result = await db
    .update(rules)
    .set({
      ...updates,
      updatedAt: new Date()
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
  
  return { message: '规则更新成功' }
}

// ❌ 不要这样做（手写 SQL）：
// const [result] = await pool.query(
//   'UPDATE rules SET rule_name = ?, conditions = ?, actions = ? WHERE id = ? AND user_id = ?',
//   [updates.ruleName, JSON.stringify(updates.conditions), JSON.stringify(updates.actions), ruleId, userId]
// )

// ============================================
// 示例 4：删除规则 API（DELETE /api/rules/:id）
// ============================================
export async function deleteRule(ruleId, userId) {
  // ✅ 使用 Drizzle：类型安全，防止 SQL 注入
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
  
  return { message: '规则删除成功' }
}

// ❌ 不要这样做（手写 SQL，有 SQL 注入风险）：
// const [result] = await pool.query(
//   `DELETE FROM rules WHERE id = ${ruleId} AND user_id = ${userId}`  // ❌ 危险！
// )

// ============================================
// 示例 5：在 Express 路由中使用
// ============================================
/*
// server/routes/rules.js
import express from 'express'
import { requireAuth } from '../middleware/authJwt.js'
import * as rulesService from '../db/实际开发示例.js'

const router = express.Router()

// 创建规则
router.post('/rules', requireAuth, async (req, res) => {
  try {
    const result = await rulesService.createRule(req.user.id, req.body)
    res.status(201).json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 获取规则列表
router.get('/rules', requireAuth, async (req, res) => {
  try {
    const rules = await rulesService.getUserRules(req.user.id, {
      onlyEnabled: req.query.enabled === 'true',
      orderBy: 'createdAt',
      limit: parseInt(req.query.limit) || 10,
      offset: parseInt(req.query.offset) || 0
    })
    res.json({ rules })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 更新规则
router.put('/rules/:id', requireAuth, async (req, res) => {
  try {
    const result = await rulesService.updateRule(
      parseInt(req.params.id),
      req.user.id,
      req.body
    )
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 删除规则
router.delete('/rules/:id', requireAuth, async (req, res) => {
  try {
    const result = await rulesService.deleteRule(
      parseInt(req.params.id),
      req.user.id
    )
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

export default router
*/

// ============================================
// 总结：实际开发中的最佳实践
// ============================================
/*
1. ✅ 所有 CRUD 操作都用 Drizzle
2. ✅ 将数据库操作封装成服务函数（如上面的 createRule、getUserRules）
3. ✅ 在路由中调用服务函数，而不是直接写数据库代码
4. ❌ 不要手写 SQL 字符串
5. ❌ 不要在路由中直接写数据库操作代码

优势：
- 类型安全：编译时检查错误
- 易维护：代码更清晰
- 防注入：Drizzle 自动处理参数化查询
- 易测试：服务函数可以单独测试
*/


