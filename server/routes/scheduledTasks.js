// 定时任务 CRUD API 路由
// 方案二：独立 scheduled_tasks 表

import { Router } from 'express'
import logger from '../utils/logger.js'
import { db } from '../db/drizzle.js'
import { scheduledTasks } from '../db/schema.js'
import { eq, and, or, desc, sql } from 'drizzle-orm'
import { requireAuth, requireActive, isAdminLikeRole } from '../middleware/authJwt.js'
import { hasAccountAccess } from '../utils/accountAccess.js'
import { computeNextExecuteAt } from '../services/scheduledTaskService.js'
import { forceExecuteTask } from '../services/scheduledTaskService.js'
import { DateTime } from 'luxon'
import pool from '../db/connection.js'

const router = Router()

// 所有路由均需登录 + 激活
router.use(requireAuth)
router.use(requireActive)

/** 安全解析路由参数中的 task ID，NaN 时返回 null */
function parseTaskId(raw) {
  const n = parseInt(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

/** 规范化 target_ids：统一转为字符串数组，兼容前端传入的复合键 "act_xxx:id" */
function normalizeTargetIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map(v => {
      const s = String(v).trim()
      const idx = s.indexOf(':')
      return idx >= 0 ? s.slice(idx + 1) : s
    }).filter(Boolean)
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.map(v => String(v).trim()).filter(Boolean)
        : []
    } catch { return [] }
  }
  return []
}

/**
 * GET /api/scheduled-tasks
 * 列表查询，支持筛选：?account_id=&status=enabled&schedule_type=once
 */
router.get('/', async (req, res) => {
  try {
    const { account_id, status, schedule_type, limit: limitStr = '50', offset: offsetStr = '0' } = req.query
    const limit = Math.min(Math.max(parseInt(limitStr) || 50, 1), 200)
    const offset = Math.max(parseInt(offsetStr) || 0, 0)

    const conditions = []

    // 账户筛选
    if (account_id) {
      conditions.push(eq(scheduledTasks.accountId, String(account_id)))
    }

    // 状态筛选
    if (status === 'enabled') {
      conditions.push(eq(scheduledTasks.enabled, true))
    } else if (status === 'disabled') {
      conditions.push(eq(scheduledTasks.enabled, false))
    }

    // 类型筛选
    if (schedule_type && ['once', 'daily', 'weekly', 'interval', 'cron'].includes(String(schedule_type))) {
      conditions.push(eq(scheduledTasks.scheduleType, String(schedule_type)))
    }

    // 普通用户只看自己的任务，管理员看全部
    if (!isAdminLikeRole(req.user.role)) {
      conditions.push(eq(scheduledTasks.userId, req.user.id))
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await db
      .select()
      .from(scheduledTasks)
      .where(where)
      .orderBy(desc(scheduledTasks.createdAt))
      .limit(limit)
      .offset(offset)

    // 计数
    let countResult
    if (where) {
      countResult = await db
        .select({ count: sql`COUNT(*)` })
        .from(scheduledTasks)
        .where(where)
    } else {
      countResult = await db
        .select({ count: sql`COUNT(*)` })
        .from(scheduledTasks)
    }

    const total = Number(countResult?.[0]?.count ?? 0)

    res.json({
      items: rows,
      total,
      limit,
      offset
    })
  } catch (err) {
    logger.error('[ScheduledTasks API] 列表查询失败:', err.message)
    res.status(500).json({ error: '查询失败', message: err.message })
  }
})

/**
 * POST /api/scheduled-tasks
 * 创建定时任务
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id
    const ownerId = req.user?.owner_id ?? 0
    const isAdmin = isAdminLikeRole(req.user.role)
    const {
      schedule_type,
      schedule_at,
      schedule_cron,
      schedule_timezone,
      account_id,
      target_accounts,       // v3 多选账户：['act_1','act_2']
      target_by_account,     // v3 按账户分组目标：{ "act_1": ["id1"], "act_2": ["id2"] }
      target_level = 'ad',
      target_id,
      target_ids,
      use_dynamic_scope = false,
      scope_filters,
      exclude_ids,
      max_dynamic_matches = 1000,
      action_type,
      action_params,
      task_name,
      is_simulation = false,
      auto_disable = true
    } = req.body

    // ============ 校验 ============

    // schedule_type 必填
    if (!schedule_type || !['once', 'daily', 'weekly', 'interval', 'cron'].includes(schedule_type)) {
      return res.status(400).json({ error: 'schedule_type 必须为 once/daily/weekly/interval/cron' })
    }

    // schedule_at 校验（cron 除外，interval 也需要）
    if (schedule_type !== 'cron' && !schedule_at) {
      return res.status(400).json({ error: 'schedule_at 为必填（cron 类型除外）' })
    }

    // cron 类型需要 schedule_cron
    if (schedule_type === 'cron' && !schedule_cron) {
      return res.status(400).json({ error: 'cron 类型需要 schedule_cron' })
    }

    // interval 类型校验 schedule_at 格式
    if (schedule_type === 'interval' && schedule_at) {
      if (!/^(\d+h)?(\d+m)?$/.test(schedule_at) || schedule_at === '') {
        return res.status(400).json({ error: 'interval 类型的 schedule_at 格式应为 "15m" 或 "2h30m"' })
      }
      const hMatch = schedule_at.match(/(\d+)h/)
      const mMatch = schedule_at.match(/(\d+)m/)
      const totalMin = (hMatch ? Number(hMatch[1]) * 60 : 0) + (mMatch ? Number(mMatch[1]) : 0)
      if (totalMin < 1) {
        return res.status(400).json({ error: '间隔时间至少为 1 分钟' })
      }
    }

    // once 类型必须大于当前时间（至少 2 分钟缓冲），使用时区感知的 Luxon 计算
    if (schedule_type === 'once' && schedule_at) {
      const zone = schedule_timezone || 'UTC'
      const now = DateTime.now().setZone(zone)
      const targetDt = DateTime.fromFormat(schedule_at, 'yyyy-MM-dd HH:mm', { zone })
      if (!targetDt.isValid) {
        return res.status(400).json({ error: 'schedule_at 格式无效，应为 YYYY-MM-DD HH:mm' })
      }
      const diffMinutes = targetDt.diff(now, 'minutes').minutes
      if (diffMinutes < 2) {
        return res.status(400).json({ error: '一次性任务执行时间必须至少比当前时间晚 2 分钟' })
      }
    }

    // account_id 必填，且必须存在且 active
    if (!account_id) {
      return res.status(400).json({ error: 'account_id 为必填' })
    }
    const [mappingRows] = await pool.execute(
      'SELECT id FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
      [account_id]
    )
    if (mappingRows.length === 0) {
      return res.status(400).json({ error: '广告账户不存在或未激活' })
    }

    // 账户权限校验
    if (!hasAccountAccess(req, account_id)) {
      return res.status(403).json({ error: '无权限操作该广告账户' })
    }

    // v3 多账户支持：校验 target_accounts / target_by_account 中每个账户的权限
    const effectiveTargetAccountIds = Array.isArray(target_accounts) && target_accounts.length > 0
      ? target_accounts.map(a => String(a).trim()).filter(Boolean)
      : (account_id ? [String(account_id).trim()] : [])
    const effectiveTargetByAccount = target_by_account && typeof target_by_account === 'object' && Object.keys(target_by_account).length > 0
      ? target_by_account
      : null

    if (!isAdmin) {
      const allAccountIdsToCheck = [...new Set([
        ...effectiveTargetAccountIds,
        ...(effectiveTargetByAccount ? Object.keys(effectiveTargetByAccount) : [])
      ])]
      for (const aid of allAccountIdsToCheck) {
        const [rows] = await pool.execute(
          'SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1',
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    // 目标对象校验：手动模式需 target_ids 或 target_id；动态模式需 scope_filters
    const effectiveTargetIds = normalizeTargetIds(target_ids)
    const effectiveUseDynamic = !!use_dynamic_scope
    
    if (effectiveUseDynamic) {
      if (!scope_filters || typeof scope_filters !== 'object') {
        return res.status(400).json({ error: '开启动态筛选时 scope_filters 为必填' })
      }
    } else {
      if (effectiveTargetIds.length === 0 && !target_id) {
        return res.status(400).json({ error: '请至少选择一个目标对象，或开启动态筛选' })
      }
    }

    // action_type 必填
    if (!action_type) {
      return res.status(400).json({ error: 'action_type 为必填' })
    }
    const validActionTypes = ['pause_ad', 'activate_ad', 'set_budget', 'increase_budget', 'decrease_budget']
    if (!validActionTypes.includes(action_type)) {
      return res.status(400).json({ error: `action_type 必须为 ${validActionTypes.join('/')}` })
    }

    // action_params 校验
    if (!action_params || typeof action_params !== 'object') {
      return res.status(400).json({ error: 'action_params 为必填的 JSON 对象' })
    }

    // set_budget 必须提供 value
    if (action_type === 'set_budget') {
      const v = Number(action_params?.value)
      if (!Number.isFinite(v) || v <= 0) {
        return res.status(400).json({ error: 'set_budget 的 value 必须大于 0' })
      }
    }

    // 计算 next_execute_at
    let nextExecuteAt = null
    try {
      const fakeTask = { scheduleType: schedule_type, scheduleAt: schedule_at, scheduleCron: schedule_cron, scheduleTimezone: schedule_timezone, accountId: account_id }
      nextExecuteAt = await computeNextExecuteAt(fakeTask)
    } catch (e) {
      return res.status(400).json({ error: `无法计算下次执行时间: ${e.message}` })
    }

    // 构建插入数据
    const insertData = {
      userId: userId,
      ownerId: req.user?.owner_id ?? 0,
      scheduleType: schedule_type,
      scheduleAt: schedule_at || null,
      scheduleCron: schedule_cron || null,
      scheduleTimezone: schedule_timezone || null,
      nextExecuteAt: nextExecuteAt,
      accountId: account_id,
      targetAccountIds: effectiveTargetAccountIds.length > 1 ? effectiveTargetAccountIds : null,
      targetByAccount: effectiveTargetByAccount,
      targetLevel: target_level,
      targetId: target_id || null,
      targetIds: effectiveTargetIds.length > 0 ? effectiveTargetIds : null,
      useDynamicScope: effectiveUseDynamic,
      scopeFilters: scope_filters || null,
      excludeIds: exclude_ids || null,
      maxDynamicMatches: max_dynamic_matches != null ? Number(max_dynamic_matches) : 1000,
      actionType: action_type,
      actionParams: action_params,
      taskName: task_name || null,
      enabled: true,
      isSimulation: !!is_simulation,
      autoDisable: !!auto_disable,
      retryCount: 0,
      maxRetries: 3,
      version: 0
    }

    const result = await db.insert(scheduledTasks).values(insertData)
    const taskId = Array.isArray(result) ? result[0]?.insertId : result?.insertId

    logger.info(`[ScheduledTasks API] 创建成功: id=${taskId}, type=${schedule_type}, action=${action_type}`)

    // 返回新创建的记录
    const [newRow] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    res.status(201).json(newRow)

  } catch (err) {
    logger.error('[ScheduledTasks API] 创建失败:', err.message)
    res.status(500).json({ error: '创建失败', message: err.message })
  }
})

/**
 * GET /api/scheduled-tasks/:id
 * 查看单条
 */
router.get('/:id', async (req, res) => {
  try {
    const taskId = parseTaskId(req.params.id)
    if (taskId == null) {
      return res.status(400).json({ error: '无效的任务 ID' })
    }
    const [row] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    if (!row) {
      return res.status(404).json({ error: '任务不存在' })
    }
    // 权限校验
    if (!isAdminLikeRole(req.user.role) && row.userId !== req.user.id) {
      return res.status(403).json({ error: '无权访问' })
    }
    res.json(row)
  } catch (err) {
    logger.error('[ScheduledTasks API] 查询失败:', err.message)
    res.status(500).json({ error: '查询失败', message: err.message })
  }
})

/**
 * PUT /api/scheduled-tasks/:id
 * 更新定时任务
 */
router.put('/:id', async (req, res) => {
  try {
    const taskId = parseTaskId(req.params.id)
    if (taskId == null) {
      return res.status(400).json({ error: '无效的任务 ID' })
    }
    const [existing] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    if (!existing) {
      return res.status(404).json({ error: '任务不存在' })
    }
    // 权限校验
    if (!isAdminLikeRole(req.user.role) && existing.userId !== req.user.id) {
      return res.status(403).json({ error: '无权修改' })
    }

    const {
      schedule_type,
      schedule_at,
      schedule_cron,
      schedule_timezone,
      account_id,
      target_accounts,       // v3 多选账户
      target_by_account,     // v3 按账户分组目标
      target_level,
      target_id,
      target_ids,
      use_dynamic_scope,
      scope_filters,
      exclude_ids,
      max_dynamic_matches,
      action_type,
      action_params,
      task_name,
      is_simulation,
      auto_disable,
      enabled
    } = req.body

    const updateData = {}

    // 只更新传入的字段
    if (schedule_type !== undefined) updateData.scheduleType = String(schedule_type)
    if (schedule_at !== undefined) updateData.scheduleAt = String(schedule_at) || null
    if (schedule_cron !== undefined) updateData.scheduleCron = String(schedule_cron) || null
    if (schedule_timezone !== undefined) updateData.scheduleTimezone = String(schedule_timezone) || null
    if (account_id !== undefined) updateData.accountId = String(account_id)
    // v3 多账户支持
    if (target_accounts !== undefined) {
      const accIds = Array.isArray(target_accounts) ? target_accounts.map(a => String(a).trim()).filter(Boolean) : []
      updateData.targetAccountIds = accIds.length > 1 ? accIds : null
    }
    if (target_by_account !== undefined) {
      updateData.targetByAccount = (target_by_account && typeof target_by_account === 'object' && Object.keys(target_by_account).length > 0)
        ? target_by_account : null
    }

    // v3 多账户权限校验（对齐规则管理 PUT /rules/:id）
    const isAdmin = isAdminLikeRole(req.user.role)
    const ownerId = req.user?.owner_id ?? 0
    if (updateData.targetAccountIds && updateData.targetAccountIds.length > 0 && !isAdmin) {
      for (const aid of updateData.targetAccountIds) {
        const [rows] = await pool.execute(
          'SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1',
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }
    // v3 权限校验：targetByAccount 中每个账户也需校验（对齐 POST 创建逻辑）
    if (updateData.targetByAccount && typeof updateData.targetByAccount === 'object' && !isAdmin) {
      for (const aid of Object.keys(updateData.targetByAccount)) {
        const [rows] = await pool.execute(
          'SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1',
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    if (target_level !== undefined) updateData.targetLevel = String(target_level)
    if (target_id !== undefined) updateData.targetId = String(target_id) || null
    if (target_ids !== undefined) updateData.targetIds = normalizeTargetIds(target_ids).length > 0 ? normalizeTargetIds(target_ids) : null
    if (use_dynamic_scope !== undefined) updateData.useDynamicScope = !!use_dynamic_scope
    if (scope_filters !== undefined) updateData.scopeFilters = scope_filters || null
    if (exclude_ids !== undefined) updateData.excludeIds = exclude_ids || null
    if (max_dynamic_matches !== undefined) updateData.maxDynamicMatches = max_dynamic_matches != null ? Number(max_dynamic_matches) : 1000
    if (action_type !== undefined) updateData.actionType = String(action_type)
    if (action_params !== undefined) updateData.actionParams = action_params
    if (task_name !== undefined) updateData.taskName = String(task_name) || null

    // v3 校验 action_params（对齐 POST 创建校验）
    const effectiveActionType = action_type ?? existing.actionType
    const effectiveActionParams = action_params ?? existing.actionParams
    if (effectiveActionType === 'set_budget') {
      const v = Number(effectiveActionParams?.value)
      if (!Number.isFinite(v) || v <= 0) {
        return res.status(400).json({ error: 'set_budget 的 value 必须大于 0' })
      }
    }

    if (is_simulation !== undefined) updateData.isSimulation = !!is_simulation
    if (auto_disable !== undefined) updateData.autoDisable = !!auto_disable
    if (enabled !== undefined) updateData.enabled = !!enabled

    // 校验 schedule_at 格式（如果提供了）
    const effectiveScheduleType = schedule_type ?? existing.scheduleType
    const effectiveScheduleAt = schedule_at ?? existing.scheduleAt
    const effectiveScheduleTz = schedule_timezone ?? existing.scheduleTimezone
    if (effectiveScheduleType !== 'cron' && effectiveScheduleAt) {
      const zone = effectiveScheduleTz || 'UTC'
      if (effectiveScheduleType === 'once') {
        const targetDt = DateTime.fromFormat(effectiveScheduleAt, 'yyyy-MM-dd HH:mm', { zone })
        if (!targetDt.isValid) {
          return res.status(400).json({ error: 'schedule_at 格式无效，应为 YYYY-MM-DD HH:mm' })
        }
      } else if (effectiveScheduleType === 'daily') {
        if (!/^\d{2}:\d{2}$/.test(effectiveScheduleAt)) {
          return res.status(400).json({ error: 'daily 类型的 schedule_at 格式应为 HH:mm' })
        }
      } else if (effectiveScheduleType === 'weekly') {
        if (!/^\d(,\d)*\|\d{2}:\d{2}$/.test(effectiveScheduleAt)) {
          return res.status(400).json({ error: 'weekly 类型的 schedule_at 格式应为 W1,W2|HH:mm' })
        }
      } else if (effectiveScheduleType === 'interval') {
        if (!/^(\d+h)?(\d+m)?$/.test(effectiveScheduleAt) || effectiveScheduleAt === '') {
          return res.status(400).json({ error: 'interval 类型的 schedule_at 格式应为 "15m" 或 "2h30m"' })
        }
        const hMatch = effectiveScheduleAt.match(/(\d+)h/)
        const mMatch = effectiveScheduleAt.match(/(\d+)m/)
        const totalMin = (hMatch ? Number(hMatch[1]) * 60 : 0) + (mMatch ? Number(mMatch[1]) : 0)
        if (totalMin < 1) {
          return res.status(400).json({ error: '间隔时间至少为 1 分钟' })
        }
      }
    }

    // 如果调度相关字段变更，重算 next_execute_at
    if (schedule_type !== undefined || schedule_at !== undefined || schedule_cron !== undefined || schedule_timezone !== undefined || account_id !== undefined) {
      const calcType = schedule_type ?? existing.scheduleType
      const calcAt = schedule_at ?? existing.scheduleAt
      const calcCron = schedule_cron ?? existing.scheduleCron
      const calcTz = schedule_timezone ?? existing.scheduleTimezone
      const calcAccount = account_id ?? existing.accountId
      try {
        const fakeTask = { scheduleType: calcType, scheduleAt: calcAt, scheduleCron: calcCron, scheduleTimezone: calcTz, accountId: calcAccount }
        updateData.nextExecuteAt = await computeNextExecuteAt(fakeTask)
      } catch (e) {
        return res.status(400).json({ error: `无法计算下次执行时间: ${e.message}` })
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: '未提供任何更新字段' })
    }

    await db.update(scheduledTasks)
      .set(updateData)
      .where(eq(scheduledTasks.id, taskId))

    const [updated] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    res.json(updated)

  } catch (err) {
    logger.error('[ScheduledTasks API] 更新失败:', err.message)
    res.status(500).json({ error: '更新失败', message: err.message })
  }
})

/**
 * DELETE /api/scheduled-tasks/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const taskId = parseTaskId(req.params.id)
    if (taskId == null) {
      return res.status(400).json({ error: '无效的任务 ID' })
    }
    const [existing] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    if (!existing) {
      return res.status(404).json({ error: '任务不存在' })
    }
    if (!isAdminLikeRole(req.user.role) && existing.userId !== req.user.id) {
      return res.status(403).json({ error: '无权删除' })
    }

    await db.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId))
    res.json({ message: '已删除', id: taskId })

  } catch (err) {
    logger.error('[ScheduledTasks API] 删除失败:', err.message)
    res.status(500).json({ error: '删除失败', message: err.message })
  }
})

/**
 * PATCH /api/scheduled-tasks/:id/toggle
 * 启用/禁用
 */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const taskId = parseTaskId(req.params.id)
    if (taskId == null) {
      return res.status(400).json({ error: '无效的任务 ID' })
    }
    const [existing] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    if (!existing) {
      return res.status(404).json({ error: '任务不存在' })
    }
    if (!isAdminLikeRole(req.user.role) && existing.userId !== req.user.id) {
      return res.status(403).json({ error: '无权操作' })
    }

    const newEnabled = !existing.enabled

    // 启用时额外校验：once 类型已过期则不允许启用
    if (newEnabled && existing.scheduleType === 'once' && existing.scheduleAt) {
      const zone = existing.scheduleTimezone || 'UTC'
      const now = DateTime.now().setZone(zone)
      const targetDt = DateTime.fromFormat(existing.scheduleAt, 'yyyy-MM-dd HH:mm', { zone })
      if (targetDt.isValid) {
        const diffMinutes = targetDt.diff(now, 'minutes').minutes
        if (diffMinutes < -2) {
          return res.status(400).json({ error: '一次性任务的执行时间已过期，无法重新启用' })
        }
      }
    }

    await db.update(scheduledTasks)
      .set({ enabled: newEnabled })
      .where(eq(scheduledTasks.id, taskId))

    const [updated] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    res.json(updated)

  } catch (err) {
    logger.error('[ScheduledTasks API] 切换状态失败:', err.message)
    res.status(500).json({ error: '操作失败', message: err.message })
  }
})

/**
 * POST /api/scheduled-tasks/:id/execute
 * 手动立即执行（force），不受互斥锁限制
 */
router.post('/:id/execute', async (req, res) => {
  try {
    const taskId = parseTaskId(req.params.id)
    if (taskId == null) {
      return res.status(400).json({ error: '无效的任务 ID' })
    }
    const [existing] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
    if (!existing) {
      return res.status(404).json({ error: '任务不存在' })
    }
    if (!isAdminLikeRole(req.user.role) && existing.userId !== req.user.id) {
      return res.status(403).json({ error: '无权操作' })
    }

    const result = await forceExecuteTask(taskId)
    if (result.success) {
      res.json({ message: result.message, taskId })
    } else {
      res.status(400).json({ error: result.message, taskId })
    }

  } catch (err) {
    logger.error('[ScheduledTasks API] 手动执行失败:', err.message)
    res.status(500).json({ error: '执行失败', message: err.message })
  }
})

export default router
