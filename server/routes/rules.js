// 规则管理路由 - 使用 Drizzle ORM
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { Router } from 'express'
import { requireAuth, requireActive } from '../middleware/authJwt.js'
import * as rulesService from '../services/rulesService.js'

const router = Router()

/**
 * GET /api/rules
 * 获取当前用户的所有规则
 * 查询参数：
 *   - onlyEnabled: true/false（只查询启用的规则）
 *   - orderBy: createdAt（排序字段）
 *   - limit: 数量限制
 *   - offset: 偏移量
 */
router.get('/rules', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const options = {
      onlyEnabled: req.query.onlyEnabled === 'true',
      orderBy: req.query.orderBy || 'createdAt',
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset) : undefined
    }
    
    const userRules = await rulesService.getUserRules(userId, options)
    
    res.json({
      rules: userRules,
      count: userRules.length
    })
  } catch (error) {
    console.error('获取规则列表失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/rules/:id
 * 获取特定规则的详情
 */
router.get('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    const rule = await rulesService.getRuleById(ruleId, userId)
    
    if (!rule) {
      return res.status(404).json({ error: '规则不存在或无权访问' })
    }
    
    res.json({ rule })
  } catch (error) {
    console.error('获取规则详情失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules
 * 创建新规则
 * 请求体：
 *   - ruleName: 规则名称
 *   - conditions: 规则条件数组
 *   - actions: 执行操作数组
 *   - enabled: 是否启用（可选，默认 true）
 */
router.post('/rules', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const { 
      ruleName, 
      conditions, 
      actions, 
      enabled,
      // M3 新增字段
      targetLevel,
      targetIds,
      logicOperator,
      timezoneName,
      isSimulation
    } = req.body
    
    // 验证必填字段
    if (!ruleName || !conditions || !actions) {
      return res.status(400).json({ 
        error: '缺少必填字段：ruleName, conditions, actions',
        code: 'MISSING_FIELDS'
      })
    }
    
    // 验证 conditions 和 actions 是数组
    if (!Array.isArray(conditions) || !Array.isArray(actions)) {
      return res.status(400).json({ 
        error: 'conditions 和 actions 必须是数组',
        code: 'INVALID_FORMAT'
      })
    }
    
    // 验证 targetLevel（如果提供）
    if (targetLevel && !['ad', 'adset', 'campaign'].includes(targetLevel)) {
      return res.status(400).json({ 
        error: 'targetLevel 必须是 ad、adset 或 campaign',
        code: 'INVALID_TARGET_LEVEL'
      })
    }
    
    // 验证 logicOperator（如果提供）
    if (logicOperator && !['AND', 'OR'].includes(logicOperator)) {
      return res.status(400).json({ 
        error: 'logicOperator 必须是 AND 或 OR',
        code: 'INVALID_LOGIC_OPERATOR'
      })
    }
    
    // 创建规则
    const newRule = await rulesService.createRule(userId, {
      ruleName,
      conditions,
      actions,
      enabled,
      // M3 新增字段
      targetLevel,
      targetIds,
      logicOperator,
      timezoneName,
      isSimulation
    })
    
    res.status(201).json({
      message: '规则创建成功',
      rule: newRule
    })
  } catch (error) {
    console.error('创建规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PUT /api/rules/:id
 * 更新规则
 * 请求体：要更新的字段（ruleName, conditions, actions, enabled）
 */
router.put('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const updates = req.body
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    // 验证 updates 不为空
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '请提供要更新的字段' })
    }
    
    // 如果更新 conditions 或 actions，验证是数组
    if (updates.conditions && !Array.isArray(updates.conditions)) {
      return res.status(400).json({ error: 'conditions 必须是数组' })
    }
    if (updates.actions && !Array.isArray(updates.actions)) {
      return res.status(400).json({ error: 'actions 必须是数组' })
    }
    
    // 更新规则
    const updatedRule = await rulesService.updateRule(ruleId, userId, updates)
    
    res.json({
      message: '规则更新成功',
      rule: updatedRule
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    console.error('更新规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/rules/:id
 * 删除规则
 */
router.delete('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    await rulesService.deleteRule(ruleId, userId)
    
    res.json({
      message: '规则删除成功'
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    console.error('删除规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/rules/:id/toggle
 * 启用/禁用规则
 * 请求体：
 *   - enabled: true/false
 */
router.patch('/rules/:id/toggle', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const { enabled } = req.body
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值' })
    }
    
    const updatedRule = await rulesService.toggleRule(ruleId, userId, enabled)
    
    res.json({
      message: `规则已${enabled ? '启用' : '禁用'}`,
      rule: updatedRule
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    console.error('启用/禁用规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router


