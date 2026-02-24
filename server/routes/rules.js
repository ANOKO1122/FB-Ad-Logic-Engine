// 规则管理路由 - 使用 Drizzle ORM
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { Router } from 'express'
import logger from '../utils/logger.js'
import { requireAuth, requireActive } from '../middleware/authJwt.js'
import * as rulesService from '../services/rulesService.js'
import { manualExecute, getCronStatus, executeSingleRule } from '../services/cronService.js'
import { assertAccountAccess } from '../utils/accountAccess.js'
import { generateRunId } from '../services/ruleExecutionSummaryService.js'
import pool from '../db/connection.js'
import { validateConditionsStructure, validateTimeWindowConsistency, normalizeConditionsToV2 } from '../utils/conditionsValidator.js'
import { validateActions } from '../utils/templateValidator.js'

const router = Router()

/**
 * GET /api/templates
 * 获取启用的规则模板（普通用户只读，用于规则创建时应用）
 */
router.get('/templates', requireAuth, requireActive, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, slug, description, when_lines, when_time_window, when_custom_range, actions, sort_order
       FROM rule_templates
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    )
    const templates = rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      when_lines: typeof r.when_lines === 'string' ? JSON.parse(r.when_lines) : r.when_lines,
      when_time_window: r.when_time_window,
      when_custom_range: r.when_custom_range ? (typeof r.when_custom_range === 'string' ? JSON.parse(r.when_custom_range) : r.when_custom_range) : null,
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : r.actions,
      sort_order: r.sort_order
    }))
    res.json({ success: true, templates })
  } catch (err) {
    logger.error('获取模板列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

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
    const isAdmin = req.user.role === 'admin'
    
    const options = {
      onlyEnabled: req.query.onlyEnabled === 'true',
      orderBy: req.query.orderBy || 'createdAt',
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset) : undefined,
      isAdmin: isAdmin  // 传递管理员标识
    }
    
    const userRules = await rulesService.getUserRules(userId, options)
    
    res.json({
      rules: userRules,
      count: userRules.length,
      isAdmin: isAdmin  // 返回给前端，方便 UI 展示
    })
  } catch (error) {
    logger.error('获取规则列表失败:', error)
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
    const isAdmin = req.user.role === 'admin'
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    const rule = await rulesService.getRuleById(ruleId, userId, isAdmin)
    
    if (!rule) {
      return res.status(404).json({ error: '规则不存在或无权访问' })
    }
    
    res.json({ rule })
  } catch (error) {
    logger.error('获取规则详情失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules
 * 创建新规则
 * 请求体：
 *   - ruleName: 规则名称（必填）
 *   - accountId: 广告账户ID（必填，规则必须绑定账户）
 *   - conditions: 规则条件数组（必填）
 *   - actions: 执行操作数组（必填）
 *   - enabled: 是否启用（可选，默认 true）
 *   - targetLevel, targetIds, logicOperator, timezoneName, isSimulation: M3 新增字段
 * 
 * 权限校验：
 *   - 普通用户：accountId 必须属于该用户的负责人（owner_id），且账户必须激活
 *   - 管理员：可以绑定任意账户，但账户必须存在且激活
 */
router.post('/rules', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const isAdmin = req.user.role === 'admin'
    const ownerId = req.user.owner_id
    
    const { 
      ruleName, 
      accountId,
      conditions, 
      actions, 
      enabled,
      targetLevel,
      targetIds,
      targetAccounts,      // 多选账户：['act_1','act_2']，落库为 target_account_ids
      target_by_account,   // 方案B：{ "act_1": ["id1","id2"], "act_2": ["id3"] }
      logicOperator,
      timezoneName,
      isSimulation
    } = req.body
    
    // ✅ 方案三：accountId 必填校验（防止反向索引退化）
    // 使用 String() 防御非字符串类型，避免 .trim() 抛异常
    const accountIdStr = accountId != null ? String(accountId).trim() : ''
    if (!accountIdStr) {
      return res.status(400).json({ 
        error: '缺少必填字段: accountId（请选择广告账户）',
        code: 'MISSING_ACCOUNT_ID'
      })
    }
    
    // 验证必填字段
    if (!ruleName || !conditions || !actions) {
      return res.status(400).json({ 
        error: '缺少必填字段：ruleName, conditions, actions',
        code: 'MISSING_FIELDS'
      })
    }
    
    // 验证 actions 是数组且结构合法（与模板校验一致）
    if (!Array.isArray(actions)) {
      return res.status(400).json({ 
        error: 'actions 必须是数组',
        code: 'INVALID_FORMAT'
      })
    }
    const actCheck = validateActions(actions)
    if (!actCheck.valid) {
      return res.status(400).json({ error: actCheck.error, code: 'INVALID_ACTIONS' })
    }
    // 验证 conditions：允许 v1 array 或 v2 object
    const condCheck = validateConditionsStructure(conditions)
    if (!condCheck.valid) {
      return res.status(400).json({ error: condCheck.error, code: 'INVALID_CONDITIONS' })
    }
    const logicOp = logicOperator || 'AND'
    const normalizedForTw = normalizeConditionsToV2(conditions, logicOp)
    const twCheck = validateTimeWindowConsistency(normalizedForTw)
    if (!twCheck.valid) {
      return res.status(400).json({ error: twCheck.error, code: 'INCONSISTENT_TIME_WINDOW' })
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
    
    // ✅ 方案三：权限校验（防止普通用户把规则绑到不属于自己的账户）
    if (!isAdmin) {
      // 普通用户：accountId 必须属于自己的负责人且 active
      if (!ownerId) {
        return res.status(400).json({ 
          error: '当前用户未绑定负责人(owner_id)，无法创建规则',
          code: 'MISSING_OWNER'
        })
      }
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings 
         WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
         LIMIT 1`,
        [accountIdStr, ownerId]
      )
      if (rows.length === 0) {
        return res.status(403).json({ 
          error: '无权访问该广告账户，无法创建规则',
          code: 'ACCOUNT_FORBIDDEN'
        })
      }
    } else {
      // 管理员：建议也校验账户存在且 active（避免写错 accountId）
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings 
         WHERE fb_account_id = ? AND is_active = 1 
         LIMIT 1`,
        [accountIdStr]
      )
      if (rows.length === 0) {
        return res.status(400).json({ 
          error: '广告账户不存在或未激活(account_mappings)，无法创建规则',
          code: 'ACCOUNT_NOT_FOUND'
        })
      }
    }
    
    // 多选账户：校验 targetAccounts / target_by_account 中每个账户的权限（与 accountId 一致）
    const targetAccountIds = Array.isArray(targetAccounts) && targetAccounts.length > 0
      ? targetAccounts.map(a => String(a).trim()).filter(Boolean)
      : null
    const targetByAccount = target_by_account && typeof target_by_account === 'object' ? target_by_account : null
    if (targetAccountIds && targetAccountIds.length > 0 && !isAdmin) {
      for (const aid of targetAccountIds) {
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1`,
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    const newRule = await rulesService.createRule(userId, {
      ruleName,
      accountId: accountIdStr,
      conditions,
      actions,
      enabled,
      targetLevel,
      targetIds: targetIds ?? [],
      targetAccountIds: targetAccountIds ?? null,
      targetByAccount: targetByAccount ?? null,
      logicOperator,
      timezoneName,
      isSimulation
    })
    
    res.status(201).json({
      message: '规则创建成功',
      rule: newRule
    })
  } catch (error) {
    logger.error('创建规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PUT /api/rules/:id
 * 更新规则
 * 请求体：要更新的字段（白名单模式，只允许更新指定字段）
 * 
 * 权限校验：
 *   - 如果更新 accountId，必须做权限校验（同 POST 规则）
 *   - 普通用户：只能绑定自己负责的账户
 *   - 管理员：可以绑定任意账户，但账户必须存在且激活
 */
router.put('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = req.user.role === 'admin'
    const ownerId = req.user.owner_id
    const body = req.body || {}
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    // 验证 updates 不为空
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: '请提供要更新的字段' })
    }
    
    const allowed = [
      'ruleName',
      'accountId',
      'conditions',
      'actions',
      'enabled',
      'targetLevel',
      'targetIds',
      'targetAccountIds',
      'targetByAccount',
      'logicOperator',
      'timezoneName',
      'isSimulation'
    ]
    
    const updates = {}
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        updates[k] = body[k]
      }
    }
    if (body.targetAccounts != null) updates.targetAccountIds = Array.isArray(body.targetAccounts) ? body.targetAccounts : null
    if (body.target_by_account != null && typeof body.target_by_account === 'object') updates.targetByAccount = body.target_by_account

    if (updates.targetAccountIds && updates.targetAccountIds.length > 0 && !isAdmin) {
      for (const aid of updates.targetAccountIds) {
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1`,
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有可更新的合法字段' })
    }
    
    if (updates.conditions) {
      const condCheck = validateConditionsStructure(updates.conditions)
      if (!condCheck.valid) {
        return res.status(400).json({ error: condCheck.error, code: 'INVALID_CONDITIONS' })
      }
      const logicOp = updates.logicOperator ?? 'AND'
      const normalizedForTw = normalizeConditionsToV2(updates.conditions, logicOp)
      const twCheck = validateTimeWindowConsistency(normalizedForTw)
      if (!twCheck.valid) {
        return res.status(400).json({ error: twCheck.error, code: 'INCONSISTENT_TIME_WINDOW' })
      }
    }
    if (updates.actions) {
      if (!Array.isArray(updates.actions)) {
        return res.status(400).json({ error: 'actions 必须是数组' })
      }
      const actCheck = validateActions(updates.actions)
      if (!actCheck.valid) {
        return res.status(400).json({ error: actCheck.error, code: 'INVALID_ACTIONS' })
      }
    }
    
    // ✅ 方案三：如果更新 accountId，必须做权限校验
    if (Object.prototype.hasOwnProperty.call(updates, 'accountId')) {
      // 使用 String() 防御非字符串类型，避免 .trim() 抛异常
      const accountIdStr = updates.accountId != null ? String(updates.accountId).trim() : ''
      if (!accountIdStr) {
        return res.status(400).json({ 
          error: '缺少必填字段: accountId（请选择广告账户）',
          code: 'MISSING_ACCOUNT_ID'
        })
      }
      
      if (!isAdmin) {
        // 普通用户：accountId 必须属于自己的负责人且 active
        if (!ownerId) {
          return res.status(400).json({ 
            error: '当前用户未绑定负责人(owner_id)，无法修改规则账户',
            code: 'MISSING_OWNER'
          })
        }
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings 
           WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
           LIMIT 1`,
          [accountIdStr, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ 
            error: '无权访问该广告账户，无法修改规则',
            code: 'ACCOUNT_FORBIDDEN'
          })
        }
      } else {
        // 管理员：建议也校验账户存在且 active（避免写错 accountId）
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings 
           WHERE fb_account_id = ? AND is_active = 1 
           LIMIT 1`,
          [accountIdStr]
        )
        if (rows.length === 0) {
          return res.status(400).json({ 
            error: '广告账户不存在或未激活(account_mappings)，无法修改规则',
            code: 'ACCOUNT_NOT_FOUND'
          })
        }
      }
      
      // 确保 accountId 是字符串（使用已校验的值）
      updates.accountId = accountIdStr
    }
    
    // ✅ 方案三：补充 PUT 路由的校验（与 POST 保持一致）
    // 验证 targetLevel（如果提供）
    if (updates.targetLevel && !['ad', 'adset', 'campaign'].includes(updates.targetLevel)) {
      return res.status(400).json({ 
        error: 'targetLevel 必须是 ad、adset 或 campaign',
        code: 'INVALID_TARGET_LEVEL'
      })
    }
    
    // 验证 logicOperator（如果提供）
    if (updates.logicOperator && !['AND', 'OR'].includes(updates.logicOperator)) {
      return res.status(400).json({ 
        error: 'logicOperator 必须是 AND 或 OR',
        code: 'INVALID_LOGIC_OPERATOR'
      })
    }
    
    // 验证 targetIds（如果提供，必须是数组）
    if (updates.targetIds && !Array.isArray(updates.targetIds)) {
      return res.status(400).json({ 
        error: 'targetIds 必须是数组',
        code: 'INVALID_TARGET_IDS'
      })
    }
    
    // 更新规则（管理员可以更新所有规则）
    const updatedRule = await rulesService.updateRule(ruleId, userId, updates, isAdmin)
    
    res.json({
      message: '规则更新成功',
      rule: updatedRule
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    logger.error('更新规则失败:', error)
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
    const isAdmin = req.user.role === 'admin'
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    // 删除规则（管理员可以删除所有规则）
    await rulesService.deleteRule(ruleId, userId, isAdmin)
    
    res.json({
      message: '规则删除成功'
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    logger.error('删除规则失败:', error)
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
    const isAdmin = req.user.role === 'admin'
    const { enabled } = req.body
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值' })
    }
    
    // 启用/禁用规则（管理员可以操作所有规则）
    const updatedRule = await rulesService.toggleRule(ruleId, userId, enabled, isAdmin)
    
    res.json({
      message: `规则已${enabled ? '启用' : '禁用'}`,
      rule: updatedRule
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    logger.error('启用/禁用规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules/execute-all
 * 手动触发规则执行（离线查询模式）
 * 
 * 说明：
 * - 这个接口触发的是离线查询模式（从数据库 daily_stats/ad_snapshots 查询）
 * - 不会直接调用 Facebook API，避免触发频率限制
 * - 执行结果会写入 automation_logs 审计日志
 */
router.post('/rules/execute-all', requireAuth, requireActive, async (req, res) => {
  try {
    // 检查是否已经在运行
    const status = getCronStatus()
    if (status.isRunning) {
      return res.status(409).json({ 
        error: '规则正在执行中，请稍后再试',
        code: 'ALREADY_RUNNING'
      })
    }
    
    // 方案B：非 admin 只跑自己负责人下的账户；admin 跑全部
    const ownerId = req.user.role === 'admin' ? undefined : req.user.owner_id
    manualExecute(true, { ownerId }).catch(err => {
      logger.error('规则执行后台任务失败:', err)
    })
    
    res.json({ 
      success: true, 
      message: ownerId != null ? '已触发您负责账户的规则执行，请查看执行日志' : '已触发规则执行，请查看执行日志页面查看结果'
    })
  } catch (error) {
    logger.error('触发规则执行失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules/:id/execute
 * 单条规则手动执行（仅执行这一条规则，force 忽略冷却期）
 * - admin：可执行任意规则
 * - 非 admin：只能执行自己创建的规则，且规则绑定的 accountId 须属于自己 owner_id
 */
router.post('/rules/:id/execute', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = req.user.role === 'admin'
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID', code: 'INVALID_ID' })
    }
    const rule = await rulesService.getRuleById(ruleId, userId, isAdmin)
    if (!rule) {
      return res.status(404).json({ error: '规则不存在或无权访问', code: 'NOT_FOUND' })
    }
    if (!isAdmin && !(await assertAccountAccess(req, res, rule.accountId))) return
    let ownerId = req.user.owner_id
    if (isAdmin) {
      const [rows] = await pool.execute(
        'SELECT owner_id FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
        [rule.accountId]
      )
      ownerId = rows[0]?.owner_id ?? 0
    }
    const status = getCronStatus()
    if (status.isRunning) {
      return res.status(409).json({
        error: '规则正在执行中，请稍后再试',
        code: 'ALREADY_RUNNING'
      })
    }
    const runId = generateRunId()
    const result = await executeSingleRule(rule, { force: true, runId, ownerId })
    if (result == null) {
      return res.status(409).json({
        error: '该账户规则正在执行中，请稍后再试',
        code: 'ACCOUNT_LOCKED'
      })
    }
    res.json({
      success: true,
      message: '已执行',
      rule_id: result.rule_id,
      account_id: result.account_id,
      matched_count: result.matched_count,
      executed_count: result.executed_count,
      failed_count: result.failed_count,
      status: result.status,
      run_id: result.run_id
    })
  } catch (error) {
    logger.error('单条规则执行失败:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router


