// 定时任务调度服务 - 方案二：独立 scheduled_tasks 表
// 职责：每分钟扫描到期的定时任务并执行，复用现有 FB API 和审计日志接口

import logger from '../utils/logger.js'
import { db } from '../db/drizzle.js'
import { scheduledTasks, automationLogs } from '../db/schema.js'
import { and, eq, lte, gte, sql } from 'drizzle-orm'
import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'
import { computeNewBudgetCentsOnce } from './actionExecutorService.js'
import { previewDynamicScope } from './dynamicScopeService.js'
import { DateTime } from 'luxon'

// ============================================
// 互斥锁：防止每分钟 Cron 并发重叠
// ============================================
let _scheduledTaskRunning = false
export function isScheduledTaskRunning() { return _scheduledTaskRunning }

/**
 * 获取任务的所有目标账户 ID 列表（v3 多账户支持）
 * 优先 targetByAccount keys → targetAccountIds → 单 accountId
 * @param {Object} task - 任务对象
 * @returns {string[]}
 */
function getTaskAccountIds(task) {
  const targetByAccount = task.targetByAccount ?? task.target_by_account
  if (targetByAccount && typeof targetByAccount === 'object') {
    const keys = Object.keys(targetByAccount).filter(k => {
      const ids = targetByAccount[k]
      return Array.isArray(ids) && ids.length > 0
    })
    if (keys.length > 0) return keys
  }
  const targetAccountIds = task.targetAccountIds ?? task.target_account_ids
  if (Array.isArray(targetAccountIds) && targetAccountIds.length > 0) {
    return targetAccountIds.map(a => String(a).trim()).filter(Boolean)
  }
  const accountId = task.accountId || task.account_id
  return accountId ? [String(accountId).trim()] : []
}

/**
 * 计算下次执行时间（UTC）
 * @param {Object} task - 任务对象
 * @returns {Promise<Date|null>}
 */
async function computeNextExecuteAt(task) {
  const scheduleType = task.scheduleType || task.schedule_type
  const scheduleAt = task.scheduleAt || task.schedule_at
  const scheduleCron = task.scheduleCron || task.schedule_cron
  const scheduleTimezone = task.scheduleTimezone || task.schedule_timezone
  const accountId = task.accountId || task.account_id

  // 时区回退：schedule_timezone 为 NULL 时用账户时区，再 NULL 用 UTC
  let zone = scheduleTimezone
  if (!zone) {
    try {
      const [rows] = await pool.execute(
        'SELECT timezone_name FROM account_mappings WHERE fb_account_id = ? LIMIT 1',
        [accountId]
      )
      zone = rows?.[0]?.timezone_name || 'UTC'
    } catch {
      zone = 'UTC'
    }
  }

  // 校验时区有效性，无效时区回退到 UTC 并记录 warn
  const testDt = DateTime.now().setZone(zone)
  if (!testDt.isValid) {
    logger.warn(`[ScheduledTask] 无效时区 "${zone}"，回退为 UTC`)
    zone = 'UTC'
  }

  const now = DateTime.now().setZone(zone)

  switch (scheduleType) {
    case 'once': {
      // 首次创建（未执行过）：返回 schedule_at 作为初始 next_execute_at
      // 已执行后：返回 null（一次性任务不重复）
      const alreadyExecuted = !!(task.lastExecutedAt || task.last_executed_at)
      if (!alreadyExecuted && scheduleAt) {
        const [datePart, timePart] = scheduleAt.split(' ')
        if (datePart && timePart) {
          const dt = DateTime.fromISO(`${datePart}T${timePart}:00`, { zone })
          if (dt.isValid) return dt.toUTC().toJSDate()
        }
      }
      return null
    }

    case 'daily': {
      const [hh, mm] = (scheduleAt || '00:00').split(':').map(Number)
      // 先检查今天的目标时间是否已过；未过则安排在今天
      const todayTarget = now.set({ hour: hh || 0, minute: mm || 0, second: 0, millisecond: 0 })
      if (todayTarget > now) {
        return todayTarget.toUTC().toJSDate()
      }
      const next = now.plus({ days: 1 }).set({ hour: hh || 0, minute: mm || 0, second: 0, millisecond: 0 })
      return next.toUTC().toJSDate()
    }

    case 'weekly': {
      const [weekDays, timeStr] = (scheduleAt || '').split('|')
      const allowed = (weekDays || '').split(',').map(Number).filter(Boolean)
      const [hh, mm] = (timeStr || '00:00').split(':').map(Number)
      if (allowed.length === 0) return null
      // 从今天（d=0）开始查找，避免跳过当天未过期的时间窗口
      for (let d = 0; d <= 7; d++) {
        const candidate = now.plus({ days: d })
        const targetTime = candidate.set({ hour: hh || 0, minute: mm || 0, second: 0, millisecond: 0 })
        // 如果是今天，检查目标时间是否已过
        if (d === 0 && targetTime <= now) continue
        if (allowed.includes(candidate.weekday)) {
          return targetTime.toUTC().toJSDate()
        }
      }
      return null
    }

    case 'cron': {
      if (!scheduleCron) return null
      try {
        const { default: cronParser } = await import('cron-parser')
        const interval = cronParser.parseExpression(scheduleCron, { tz: zone })
        return interval.next().toDate()
      } catch (e) {
        logger.error(`[ScheduledTask] cron 表达式解析失败: ${scheduleCron}`, e.message)
        return null
      }
    }

    case 'interval': {
      if (!scheduleAt) return null
      // 解析格式："15m" 或 "2h30m"
      const hMatch = scheduleAt.match(/(\d+)h/)
      const mMatch = scheduleAt.match(/(\d+)m/)
      const hours = hMatch ? Number(hMatch[1]) : 0
      const minutes = mMatch ? Number(mMatch[1]) : 0
      const totalMinutes = hours * 60 + minutes
      if (totalMinutes < 1) {
        logger.warn(`[ScheduledTask] interval 间隔无效: ${scheduleAt}`)
        return null
      }
      // 以上次执行时间为基准 + 间隔；若从未执行，以当前时间为基准
      const lastExecuted = task.lastExecutedAt || task.last_executed_at
      const base = lastExecuted ? DateTime.fromJSDate(new Date(lastExecuted)).setZone(zone) : now
      const next = base.plus({ minutes: totalMinutes })
      // 如果计算结果已过期（上次执行太久），以当前时间+间隔为准
      if (next <= now) {
        return now.plus({ minutes: totalMinutes }).toUTC().toJSDate()
      }
      return next.toUTC().toJSDate()
    }

    default:
      return null
  }
}

/**
 * 执行单个动作
 * @param {FacebookMarketingAPI} api - FB API 实例
 * @param {Object} task - 任务对象
 * @param {string} targetId - 目标对象 ID
 * @param {string} budgetObjectId - 预算操作的实际对象 ID（adset 或 campaign）
 * @returns {Promise<{ result: any, apiRequest: object|null, apiResponse: object|null }>}
 */
async function executeAction(api, task, targetId, budgetObjectId) {
  const actionType = task.actionType || task.action_type
  const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
  const params = typeof task.actionParams === 'string'
    ? JSON.parse(task.actionParams)
    : (task.actionParams || task.action_params || {})

  let apiRequest = null
  let apiResponse = null
  let result

  try {
    switch (actionType) {
      case 'pause_ad': {
        apiRequest = { method: targetLevel === 'adset' ? 'pauseAdset' : targetLevel === 'campaign' ? 'pauseCampaign' : 'pauseAd', targetId }
        if (targetLevel === 'adset') result = await api.pauseAdset(targetId)
        else if (targetLevel === 'campaign') result = await api.pauseCampaign(targetId)
        else result = await api.pauseAd(targetId)
        break
      }

      case 'activate_ad': {
        apiRequest = { method: targetLevel === 'adset' ? 'activateAdset' : targetLevel === 'campaign' ? 'activateCampaign' : 'activateAd', targetId }
        if (targetLevel === 'adset') result = await api.activateAdset(targetId)
        else if (targetLevel === 'campaign') result = await api.activateCampaign(targetId)
        else result = await api.activateAd(targetId)
        break
      }

      case 'set_budget': {
        const targetUsd = Number(params?.value)
        if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
          throw new Error(`set_budget value 无效: ${params?.value}`)
        }
        let newCents = Math.round(targetUsd * 100)
        newCents = Math.max(newCents, 100)
        if (params?.max_daily_budget != null) {
          const cap = Math.round(Number(params.max_daily_budget))
          if (cap > 0) newCents = Math.min(newCents, cap)
        }
        if (targetLevel === 'campaign') {
          apiRequest = { method: 'updateCampaignBudget', targetId: budgetObjectId, budgetCents: newCents }
          result = await api.updateCampaignBudget(budgetObjectId, newCents)
        } else {
          apiRequest = { method: 'updateAdsetBudget', targetId: budgetObjectId, budgetCents: newCents }
          result = await api.updateAdsetBudget(budgetObjectId, newCents)
        }
        break
      }

      case 'increase_budget':
      case 'decrease_budget': {
        let currentCents
        if (targetLevel === 'campaign') {
          currentCents = await api.getCampaignBudget(budgetObjectId)
        } else {
          currentCents = await api.getAdsetBudget(budgetObjectId)
        }
        const action = { ...params, type: actionType }
        const newCents = computeNewBudgetCentsOnce(currentCents, action)
        if (newCents === currentCents) {
          logger.info(`[ScheduledTask #${task.id}] 预算无需调整（当前=${currentCents}分，目标=${newCents}分），跳过API调用`)
          apiRequest = { method: 'budget_no_change', currentCents, newCents }
          apiResponse = { skipped: true, reason: '预算无需调整' }
          return { result: null, apiRequest, apiResponse }
        }
        if (targetLevel === 'campaign') {
          apiRequest = { method: 'updateCampaignBudget', targetId: budgetObjectId, budgetCents: newCents, previousCents: currentCents }
          result = await api.updateCampaignBudget(budgetObjectId, newCents)
        } else {
          apiRequest = { method: 'updateAdsetBudget', targetId: budgetObjectId, budgetCents: newCents, previousCents: currentCents }
          result = await api.updateAdsetBudget(budgetObjectId, newCents)
        }
        break
      }

      default:
        throw new Error(`不支持的动作类型: ${actionType}`)
    }

    apiResponse = result ? (typeof result === 'object' ? { ...result } : { data: result }) : { success: true }
    return { result, apiRequest, apiResponse }

  } catch (err) {
    apiResponse = { error: err.message, stack: err.stack?.slice(0, 500) }
    err._apiRequest = apiRequest
    err._apiResponse = apiResponse
    throw err
  }
}

/**
 * 写入审计日志
 * @param {Object} task - 任务对象
 * @param {string} status - 执行状态：success / fail
 * @param {string|null} preflightMode - preflight 模式标记
 * @param {string|null} errorMessage - 错误信息
 */
async function writeAuditLog(task, targetId, status, preflightMode, errorMessage, extra = {}) {
  const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
  const accountId = extra.accountId || String(task.accountId || task.account_id || '')
  const actionType = String(task.actionType || task.action_type || '').toUpperCase()
  const taskName = task.taskName || task.task_name || null

  // 非 ad 级操作从 structure_ads 获取一个关联广告 ID，用于审计日志追溯
  let auditAdId = ''
  if (targetLevel === 'ad') {
    auditAdId = targetId
  } else {
    try {
      const filterCol = targetLevel === 'adset' ? 'adset_id' : 'campaign_id'
      const [rows] = await pool.execute(
        `SELECT ad_id FROM structure_ads WHERE account_id = ? AND ${filterCol} = ? LIMIT 1`,
        [accountId, targetId]
      )
      auditAdId = String(rows?.[0]?.ad_id || targetId)
    } catch {
      auditAdId = targetId
    }
  }

  try {
    const actionParams = typeof task.actionParams === 'string'
      ? JSON.parse(task.actionParams)
      : (task.actionParams || task.action_params || {})

    await db.insert(automationLogs).values({
      accountId: accountId,
      adId: auditAdId,
      runId: extra.runId || null,
      ruleName: taskName,
      objectType: targetLevel,
      objectId: targetId,
      objectName: extra.objectName || null,
      actionType: actionType,
      actionPayload: actionParams,
      apiRequest: extra.apiRequest || null,
      apiResponse: extra.apiResponse || null,
      explanation: {
        trigger_type: 'scheduled',
        schedule_type: task.scheduleType || task.schedule_type,
        schedule_at: task.scheduleAt || task.schedule_at,
        task_id: task.id,
        task_name: taskName
      },
      preflightMode: preflightMode || (task.isSimulation ? 'preflight' : null),
      status: status,
      errorMessage: errorMessage || null,
      isSimulation: !!(task.isSimulation || task.is_simulation),
      triggeredAt: new Date(),
      ownerId: task.ownerId || task.owner_id || 0
    })
  } catch (e) {
    logger.error(`[ScheduledTask #${task.id}] 审计日志写入失败:`, e.message)
  }
}

/**
 * 成功后更新任务状态
 */
async function updateTaskAfterExecute(task) {
  const nextAt = await computeNextExecuteAt(task)
  let newEnabled = task.enabled ?? true
  if ((task.scheduleType || task.schedule_type) === 'once' && (task.autoDisable ?? task.auto_disable ?? true)) {
    newEnabled = false
  }
  await db.update(scheduledTasks)
    .set({
      lastExecutedAt: new Date(),
      lastStatus: 'success',
      nextExecuteAt: nextAt,
      enabled: newEnabled,
      retryCount: 0,
      version: sql`version + 1`
    })
    .where(and(
      eq(scheduledTasks.id, task.id),
      eq(scheduledTasks.version, task.version ?? 0)
    ))
}

/**
 * 失败后更新：指数退避重试
 * 第1次失败：5分钟后重试
 * 第2次失败：10分钟后重试
 * 第3次失败：20分钟后重试（超过 maxRetries → 自动禁用）
 */
async function updateTaskAfterFailure(task) {
  const maxRetries = task.maxRetries ?? task.max_retries ?? 3
  const newRetryCount = (task.retryCount ?? task.retry_count ?? 0) + 1
  const now = DateTime.utc()

  if (newRetryCount >= maxRetries) {
    await db.update(scheduledTasks)
      .set({
        lastStatus: 'stale',
        retryCount: newRetryCount,
        enabled: false,
        lastExecutedAt: now.toJSDate(),
        version: sql`version + 1`
      })
      .where(and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.version, task.version ?? 0)
      ))
    logger.warn(`[ScheduledTask #${task.id}] 已重试 ${newRetryCount}/${maxRetries} 次，自动禁用`)
  } else {
    const backoffMinutes = 5 * Math.pow(2, newRetryCount - 1)
    const nextRetry = now.plus({ minutes: backoffMinutes }).toJSDate()
    await db.update(scheduledTasks)
      .set({
        lastStatus: 'fail',
        retryCount: newRetryCount,
        nextExecuteAt: nextRetry,
        lastExecutedAt: now.toJSDate(),
        version: sql`version + 1`
      })
      .where(and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.version, task.version ?? 0)
      ))
    logger.info(`[ScheduledTask #${task.id}] 第 ${newRetryCount}/${maxRetries} 次失败，${backoffMinutes} 分钟后重试`)
  }
}

/**
 * 跳过时更新：前推 next_execute_at 到下一周期，防止每分钟重复 skip
 * once 类型跳过时直接禁用（目标不存在或账户未激活，重试无意义）
 */
async function updateTaskAfterSkip(task) {
  const scheduleType = task.scheduleType || task.schedule_type
  if (scheduleType === 'once') {
    await db.update(scheduledTasks)
      .set({
        lastStatus: 'skipped',
        enabled: false,
        version: sql`version + 1`
      })
      .where(and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.version, task.version ?? 0)
      ))
    return
  }
  const nextAt = await computeNextExecuteAt(task)
  await db.update(scheduledTasks)
    .set({
      lastStatus: 'skipped',
      nextExecuteAt: nextAt,
      version: sql`version + 1`
    })
    .where(and(
      eq(scheduledTasks.id, task.id),
      eq(scheduledTasks.version, task.version ?? 0)
    ))
}

/**
 * 入口：执行所有到期定时任务
 * @returns {Promise<{ executed: number, skipped: number, errors: number, skippedDueToLock?: boolean }>}
 */
export async function executeDueScheduledTasks() {
  if (_scheduledTaskRunning) {
    return { executed: 0, skipped: 0, errors: 0, skippedDueToLock: true }
  }
  _scheduledTaskRunning = true

  try {
    // 1. 查询到期的任务（2分钟容差窗口）
    const toleranceWindow = new Date(Date.now() - 2 * 60 * 1000)
    const now = new Date()
    const dueTasks = await db
      .select()
      .from(scheduledTasks)
      .where(and(
        eq(scheduledTasks.enabled, true),
        gte(scheduledTasks.nextExecuteAt, toleranceWindow),
        lte(scheduledTasks.nextExecuteAt, now)
      ))
      .limit(100)

    if (dueTasks.length === 0) return { executed: 0, skipped: 0, errors: 0 }

    if (dueTasks.length >= 100) {
      logger.warn('[ScheduledTask Cron] 到期任务数达到 LIMIT 上限 100，可能存在积压')
    }

    // Token 仅在存在非 Dry Run 任务时必需
    const hasRealTask = dueTasks.some(t => !(t.isSimulation || t.is_simulation))
    const token = hasRealTask ? process.env.FACEBOOK_ACCESS_TOKEN : null
    if (hasRealTask && !token) {
      logger.warn('[ScheduledTask] 跳过：FACEBOOK_ACCESS_TOKEN 缺失（存在非 Dry Run 任务）')
      return { executed: 0, skipped: dueTasks.length, errors: 0 }
    }
    const api = token ? new FacebookMarketingAPI(token) : null
    let executed = 0, skipped = 0, errors = 0

    // 批量审计日志收集
    const auditBatch = []

    for (const task of dueTasks) {
      try {
        // v3 多账户支持：获取任务的所有目标账户
        const taskAccountIds = getTaskAccountIds(task)
        let taskExecuted = 0, taskErrors = 0, taskSkippedAccounts = 0

        for (const acctId of taskAccountIds) {
          // 2. 校验账户是否 active
          const [mappingRows] = await pool.execute(
            'SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
            [acctId]
          )
          if (mappingRows.length === 0) {
            logger.info(`[ScheduledTask #${task.id}] 账户 ${acctId} 未激活，跳过`)
            taskSkippedAccounts++
            continue
          }

          // 3. 解析该账户的执行目标列表
          const targetIds = await resolveTargetIdsForTask(task, acctId)
          if (targetIds.length === 0) {
            logger.warn(`[ScheduledTask #${task.id}] 账户 ${acctId} 无有效目标对象，跳过`)
            taskSkippedAccounts++
            continue
          }

          // 4. 遍历每个目标对象执行动作
          const runId = generateRunId(task.id)
          for (const targetId of targetIds) {
            try {
              const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
              const actionType = task.actionType || task.action_type
              const isBudgetAction = ['set_budget', 'increase_budget', 'decrease_budget'].includes(actionType)
              let budgetObjectId = targetId

              // v3 修复 S2：提前解析 auditAdId，避免后续分支引用未定义变量
              const auditAdId = await resolveAuditAdId(acctId, targetLevel, targetId)

              if (targetLevel === 'ad' && isBudgetAction) {
                const [adRows] = await pool.execute(
                  'SELECT adset_id FROM structure_ads WHERE account_id = ? AND ad_id = ? LIMIT 1',
                  [acctId, targetId]
                )
                if (adRows.length === 0) {
                  logger.warn(`[ScheduledTask #${task.id}] 账户 ${acctId} 目标 ${targetId} 找不到广告，跳过该对象`)
                  taskErrors++
                  auditBatch.push(buildAuditRecord(task, targetId, 'skipped', null, `找不到广告 ${targetId}`, { runId, accountId: acctId, auditAdId }))
                  continue
                }
                budgetObjectId = adRows[0].adset_id
              }

              // 解析对象名称
              const objectName = await resolveObjectName(acctId, targetLevel, targetId)

              // 执行
              if (task.isSimulation) {
                logger.info(`[ScheduledTask #${task.id}] Dry Run: ${task.actionType} on ${targetId} (${acctId})`)
                taskExecuted++
                auditBatch.push(buildAuditRecord(task, targetId, 'success', 'preflight', null, { runId, objectName, accountId: acctId, auditAdId }))
              } else {
                const actionResult = await executeAction(api, task, targetId, budgetObjectId)
                taskExecuted++
                auditBatch.push(buildAuditRecord(task, targetId, 'success', null, null, {
                  runId, objectName, accountId: acctId, auditAdId,
                  apiRequest: actionResult.apiRequest,
                  apiResponse: actionResult.apiResponse
                }))
              }
            } catch (targetErr) {
              logger.error(`[ScheduledTask #${task.id}] 账户 ${acctId} 目标 ${targetId} 执行失败:`, targetErr.message)
              taskErrors++
              auditBatch.push(buildAuditRecord(task, targetId, 'fail', null, targetErr.message, {
                runId, accountId: acctId, auditAdId,
                apiRequest: targetErr._apiRequest || null,
                apiResponse: targetErr._apiResponse || null
              }))
            }
          }
        }

        // 整体任务结果判定
        if (taskErrors > 0) {
          errors++
          await updateTaskAfterFailure(task)
        } else if (taskExecuted > 0) {
          executed++
          await updateTaskAfterExecute(task)
        } else {
          // 所有账户都跳过（无 active 账户 或 所有账户无有效目标）
          skipped++
          await updateTaskAfterSkip(task)
        }

      } catch (err) {
        logger.error(`[ScheduledTask #${task.id}] 执行失败:`, err.message)
        errors++
        await updateTaskAfterFailure(task)
        const fallbackTid = String(task.targetId || task.target_id || task.targetIds?.[0] || task.target_ids?.[0] || '')
        const fallbackAcctId = getTaskAccountIds(task)[0] || String(task.accountId || task.account_id || '')
        auditBatch.push(buildAuditRecord(task, fallbackTid, 'fail', null, err.message, {
          accountId: fallbackAcctId,
          apiRequest: err._apiRequest || null,
          apiResponse: err._apiResponse || null
        }))
      }
    }

    // 批量写入审计日志（单次 INSERT，避免逐条写入的性能损耗）
    if (auditBatch.length > 0) {
      try {
        await db.insert(automationLogs).values(auditBatch)
      } catch (e) {
        logger.error(`[ScheduledTask] 批量审计日志写入失败 (${auditBatch.length} 条):`, e.message)
      }
    }

    return { executed, skipped, errors }

  } finally {
    _scheduledTaskRunning = false
  }
}

/**
 * 手动执行单个任务（force 路径，不受互斥锁限制）
 * @param {number} taskId - 任务 ID
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function forceExecuteTask(taskId) {
  const [rows] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).limit(1)
  const task = rows[0]
  if (!task) return { success: false, message: '任务不存在' }

  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) return { success: false, message: 'FACEBOOK_ACCESS_TOKEN 缺失' }

  try {
    const api = new FacebookMarketingAPI(token)

    // v3 多账户支持
    const taskAccountIds = getTaskAccountIds(task)
    let totalSuccess = 0, totalFail = 0
    const runId = generateRunId(task.id)
    const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()

    for (const acctId of taskAccountIds) {
      // 校验账户
      const [mappingRows] = await pool.execute(
        'SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
        [acctId]
      )
      if (mappingRows.length === 0) {
        totalFail++
        await writeAuditLog(task, '', 'skipped', null, `账户 ${acctId} 未激活，跳过执行`, { runId, accountId: acctId })
        continue
      }

      // 解析目标列表
      const targetIds = await resolveTargetIdsForTask(task, acctId)
      if (targetIds.length === 0) continue

      for (const targetId of targetIds) {
        try {
          const actionType = task.actionType || task.action_type
          const isBudgetAction = ['set_budget', 'increase_budget', 'decrease_budget'].includes(actionType)
          let budgetObjectId = targetId
          if (targetLevel === 'ad' && isBudgetAction) {
            const [adRows] = await pool.execute(
              'SELECT adset_id FROM structure_ads WHERE account_id = ? AND ad_id = ? LIMIT 1',
              [acctId, targetId]
            )
            if (adRows.length === 0) {
              totalFail++
              await writeAuditLog(task, targetId, 'skipped', null, `找不到广告 ${targetId}`, { runId, accountId: acctId })
              continue
            }
            budgetObjectId = adRows[0].adset_id
          }

          // 解析对象名称
          const objectName = await resolveObjectName(acctId, targetLevel, targetId)

          if (task.isSimulation) {
            logger.info(`[ScheduledTask #${task.id}] Force Dry Run: ${task.actionType} on ${targetId} (${acctId})`)
            totalSuccess++
            await writeAuditLog(task, targetId, 'success', 'preflight', null, { runId, objectName, accountId: acctId })
          } else {
            const actionResult = await executeAction(api, task, targetId, budgetObjectId)
            totalSuccess++
            await writeAuditLog(task, targetId, 'success', null, null, {
              runId, objectName, accountId: acctId,
              apiRequest: actionResult.apiRequest,
              apiResponse: actionResult.apiResponse
            })
          }
        } catch (targetErr) {
          logger.error(`[ScheduledTask #${task.id}] 目标 ${targetId} 手动执行失败:`, targetErr.message)
          totalFail++
          await writeAuditLog(task, targetId, 'fail', null, targetErr.message, {
            runId, accountId: acctId,
            apiRequest: targetErr._apiRequest || null,
            apiResponse: targetErr._apiResponse || null
          })
        }
      }
    }

    if (totalFail > 0 || totalSuccess === 0) {
      await updateTaskAfterFailure(task)
      return { success: totalSuccess > 0, message: `执行完成: ${totalSuccess} 成功, ${totalFail} 失败` }
    }
    await updateTaskAfterExecute(task)
    return { success: true, message: `全部执行成功 (${totalSuccess} 个对象)` }
  } catch (err) {
    logger.error(`[ScheduledTask #${task.id}] 手动执行失败:`, err.message)
    await updateTaskAfterFailure(task)
    const fallbackTargetId = String(task.targetId || task.target_id || task.targetIds?.[0] || task.target_ids?.[0] || '')
    const fallbackAcctId = getTaskAccountIds(task)[0] || String(task.accountId || task.account_id || '')
    await writeAuditLog(task, fallbackTargetId, 'fail', null, err.message, {
      accountId: fallbackAcctId,
      apiRequest: err._apiRequest || null,
      apiResponse: err._apiResponse || null
    })
    return { success: false, message: err.message }
  }
}

/**
 * 解析任务的执行目标列表
 * 支持三种模式：
 *   1. useDynamicScope=true  → 调用 previewDynamicScope 动态解析 scope_filters → 合并 target_ids → 减去 exclude_ids
 *   2. targetIds 非空         → 直接用 target_ids
 *   3. 兼容旧数据 targetId     → 转为单元素数组
 * @param {Object} task - 任务对象
 * @param {string} [accountId] - v3 多账户：指定要解析的账户 ID，用于从 targetByAccount 中提取该账户的手动 IDs
 * @returns {Promise<string[]>}
 */
async function resolveTargetIdsForTask(task, accountId = null) {
  const useDynamic = !!(task.useDynamicScope ?? task.use_dynamic_scope)
  const targetIdsRaw = task.targetIds ?? task.target_ids
  const targetIdLegacy = task.targetId ?? task.target_id
  const excludeIdsRaw = task.excludeIds ?? task.exclude_ids
  const effectiveAccountId = accountId || task.accountId || task.account_id
  const targetLevel = task.targetLevel || task.target_level || 'ad'

  // v3 多账户：targetByAccount 优先 — 提取指定账户的目标 ID
  const targetByAccount = task.targetByAccount ?? task.target_by_account
  let manualIds = []
  if (targetByAccount && typeof targetByAccount === 'object' && accountId && targetByAccount[accountId]) {
    manualIds = (targetByAccount[accountId] || []).map(v => String(v).trim()).filter(Boolean)
  } else if (Array.isArray(targetIdsRaw) && targetIdsRaw.length > 0) {
    // 兼容旧数据：targetIds 中的复合键 "act_xxx:id" 提取纯 ID
    manualIds = targetIdsRaw.map(v => {
      const s = String(v).trim()
      const idx = s.indexOf(':')
      return idx >= 0 ? s.slice(idx + 1) : s
    }).filter(Boolean)
  } else if (targetIdLegacy) {
    manualIds = [String(targetIdLegacy).trim()].filter(Boolean)
  }

  // 获取排除 ID
  const excludeSet = new Set()
  if (excludeIdsRaw && typeof excludeIdsRaw === 'object') {
    for (const level of ['ad_ids', 'adset_ids', 'campaign_ids']) {
      const ids = excludeIdsRaw[level]
      if (Array.isArray(ids)) ids.forEach(id => excludeSet.add(String(id).trim()))
    }
  }

  // 手动模式：直接返回手动 IDs（已排除）
  if (!useDynamic) {
    return manualIds.filter(id => !excludeSet.has(id))
  }

  // 动态模式：调用 previewDynamicScope 实时解析 scope_filters，与手动 IDs 合并后去排除
  const scopeFilters = task.scopeFilters ?? task.scope_filters
  const maxDynamicMatches = task.maxDynamicMatches ?? task.max_dynamic_matches ?? 1000
  const dynIds = new Set(manualIds)

  if (scopeFilters && typeof scopeFilters === 'object') {
    try {
      const result = await previewDynamicScope([effectiveAccountId], {
        scopeFilters,
        excludeIds: excludeIdsRaw,
        targetLevel,
        maxDynamicMatches
      })
      if (Array.isArray(result?.object_ids)) {
        for (const rawId of result.object_ids) {
          // previewDynamicScope 返回复合键 "act_xxx:id"，提取纯 ID 部分
          const s = String(rawId).trim()
          const idx = s.indexOf(':')
          const pureId = idx >= 0 ? s.slice(idx + 1) : s
          if (pureId) dynIds.add(pureId)
        }
      }
    } catch (e) {
      logger.warn(`[ScheduledTask #${task.id}] 动态筛选解析失败，回退为仅手动 IDs:`, e.message)
    }
  }

  // 去重 + 排除
  return [...dynIds].filter(id => !excludeSet.has(id))
}

/**
 * 构建单条审计日志记录（用于批量写入）
 */
function buildAuditRecord(task, targetId, status, preflightMode, errorMessage, extra = {}) {
  const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
  const accountId = extra.accountId || String(task.accountId || task.account_id || '')
  const actionType = String(task.actionType || task.action_type || '').toUpperCase()
  const actionParams = typeof task.actionParams === 'string'
    ? JSON.parse(task.actionParams)
    : (task.actionParams || task.action_params || {})
  const isSim = !!(task.isSimulation || task.is_simulation)
  const taskName = task.taskName || task.task_name || null

  return {
    accountId,
    adId: extra.auditAdId || targetId,                             // S2 修复：非 ad 级目标使用解析后的关联 ad_id
    runId: extra.runId || null,
    ruleName: taskName,                                             // 任务自定义名称写入 rule_name
    objectType: targetLevel,
    objectId: String(targetId),
    objectName: extra.objectName || null,
    actionType,
    actionPayload: actionParams,
    apiRequest: extra.apiRequest || null,
    apiResponse: extra.apiResponse || null,
    explanation: { trigger_type: 'scheduled', schedule_type: task.scheduleType || task.schedule_type, schedule_at: task.scheduleAt || task.schedule_at, task_id: task.id, task_name: taskName },
    preflightMode: preflightMode || (isSim ? 'preflight' : null),
    status,
    errorMessage: errorMessage || null,
    isSimulation: isSim,
    triggeredAt: new Date(),
    ownerId: task.ownerId || task.owner_id || 0
  }
}

/**
 * 生成执行批次 run_id
 */
function generateRunId(taskId) {
  return `sched_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 查询目标对象的名称
 * @param {string} accountId
 * @param {string} targetLevel - ad / adset / campaign
 * @param {string} targetId
 * @returns {Promise<string|null>}
 */
async function resolveObjectName(accountId, targetLevel, targetId) {
  try {
    const tableMap = {
      ad: { table: 'structure_ads', col: 'ad_id', nameCol: 'ad_name' },
      adset: { table: 'structure_adsets', col: 'adset_id', nameCol: 'adset_name' },
      campaign: { table: 'structure_campaigns', col: 'campaign_id', nameCol: 'campaign_name' }
    }
    const mapping = tableMap[targetLevel]
    if (!mapping) return null
    const [rows] = await pool.execute(
      `SELECT ${mapping.nameCol} FROM ${mapping.table} WHERE account_id = ? AND ${mapping.col} = ? LIMIT 1`,
      [accountId, targetId]
    )
    return rows?.[0]?.[mapping.nameCol] || null
  } catch {
    return null
  }
}

/**
 * 解析审计日志用的 ad_id（S2 修复）
 * ad 级目标直接用 targetId；adset/campaign 级目标查 structure_ads 找到关联 ad_id
 */
async function resolveAuditAdId(accountId, targetLevel, targetId) {
  if (targetLevel === 'ad') return targetId
  try {
    const filterCol = targetLevel === 'adset' ? 'adset_id' : 'campaign_id'
    const [rows] = await pool.execute(
      `SELECT ad_id FROM structure_ads WHERE account_id = ? AND ${filterCol} = ? LIMIT 1`,
      [accountId, targetId]
    )
    return String(rows?.[0]?.ad_id || targetId)
  } catch {
    return targetId
  }
}

/**
 * 计算任务的下次执行时间（供外部 CRUD 使用）
 * @param {Object} task - 任务对象（含 schedule_type, schedule_at, schedule_cron, schedule_timezone, account_id）
 * @returns {Promise<Date|null>}
 */
export { computeNextExecuteAt }
