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
 * 合并 targetByAccount keys + targetAccountIds → 单 accountId
 * @param {Object} task - 任务对象
 * @returns {string[]}
 */
function getTaskAccountIds(task) {
  const accountIds = new Set()

  // 1. 从 targetByAccount 提取有手动目标对象的账户
  const targetByAccount = task.targetByAccount ?? task.target_by_account
  if (targetByAccount && typeof targetByAccount === 'object') {
    for (const k of Object.keys(targetByAccount)) {
      if (Array.isArray(targetByAccount[k]) && targetByAccount[k].length > 0) {
        accountIds.add(String(k).trim())
      }
    }
  }

  // 2. 从 targetAccountIds 补充（可能有些账户只有动态筛选没有手动对象）
  const targetAccountIds = task.targetAccountIds ?? task.target_account_ids
  if (Array.isArray(targetAccountIds) && targetAccountIds.length > 0) {
    for (const a of targetAccountIds) {
      const s = String(a).trim()
      if (s) accountIds.add(s)
    }
  }

  if (accountIds.size > 0) return [...accountIds]

  // 3. 兜底：单账户
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
 * @returns {Promise<{ result: any, apiRequest: string|null, apiResponse: string|null }>}
 */
async function executeAction(api, task, targetId, budgetObjectId, targetCampaignId = null) {
  const actionType = task.actionType || task.action_type
  const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
  const params = typeof task.actionParams === 'string'
    ? JSON.parse(task.actionParams)
    : (task.actionParams || task.action_params || {})

  let apiRequest = null
  let apiResponse = null
  let result

  const makeReq = (method, endpoint, body) => JSON.stringify({ method, endpoint, targetLevel, body })
  const makeResp = (ok, data) => JSON.stringify({ success: !!ok, ...(typeof data === 'object' ? data : { message: data }) })

  try {
    switch (actionType) {
      case 'pause_ad': {
        const method = targetLevel === 'adset' ? 'pauseAdset' : targetLevel === 'campaign' ? 'pauseCampaign' : 'pauseAd'
        apiRequest = makeReq('POST', `/${targetId}`, { status: 'PAUSED' })
        if (targetLevel === 'adset') result = await api.pauseAdset(targetId)
        else if (targetLevel === 'campaign') result = await api.pauseCampaign(targetId)
        else result = await api.pauseAd(targetId)
        break
      }

      case 'activate_ad': {
        const method = targetLevel === 'adset' ? 'activateAdset' : targetLevel === 'campaign' ? 'activateCampaign' : 'activateAd'
        apiRequest = makeReq('POST', `/${targetId}`, { status: 'ACTIVE' })
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
        // v3.6 ABO/CBO 智能路由（对齐规则引擎 AdsPolar 逻辑）：
        // 广告/广告组目标先查当前节点是否有预算(ABO)，有则直接调；无则向上调 Campaign(CBO)
        let useCBO = targetLevel === 'campaign'
        if (!useCBO && (targetLevel === 'ad' || targetLevel === 'adset') && targetCampaignId) {
          const budgetNodeId = targetLevel === 'adset' ? targetId : budgetObjectId
          try {
            const detail = await api.getAdsetBudgetDetail(budgetNodeId)
            const hasBudget = detail && ((detail.daily_budget || 0) > 0 || (detail.lifetime_budget || 0) > 0)
            if (!hasBudget) {
              useCBO = true
              logger.info(`[ScheduledTask #${task.id}] ${targetLevel === 'adset' ? 'AdSet' : 'AdSet(vi a ad)'} ${budgetNodeId} 无预算，切换为 CBO (Campaign ${targetCampaignId})`)
            }
          } catch (e) {
            logger.warn(`[ScheduledTask #${task.id}] 无法获取预算详情，尝试 CBO:`, e.message)
            useCBO = true
          }
        }
        if (useCBO) {
          const cboId = targetLevel === 'campaign' ? budgetObjectId : targetCampaignId
          if (!cboId) throw new Error('CBO 路由失败：缺少 campaign_id')
          apiRequest = makeReq('POST', `/${cboId}`, { daily_budget: newCents, budgetUnit: 'cents' })
          result = await api.updateCampaignBudget(cboId, newCents)
        } else {
          apiRequest = makeReq('POST', `/${budgetObjectId}`, { daily_budget: newCents, budgetUnit: 'cents' })
          result = await api.updateAdsetBudget(budgetObjectId, newCents)
        }
        break
      }

      case 'increase_budget':
      case 'decrease_budget': {
        // v3.6 ABO/CBO 智能路由
        let useCBO = targetLevel === 'campaign'
        if (!useCBO && (targetLevel === 'ad' || targetLevel === 'adset') && targetCampaignId) {
          const budgetNodeId = targetLevel === 'adset' ? targetId : budgetObjectId
          try {
            const detail = await api.getAdsetBudgetDetail(budgetNodeId)
            const hasBudget = detail && ((detail.daily_budget || 0) > 0 || (detail.lifetime_budget || 0) > 0)
            if (!hasBudget) {
              useCBO = true
              logger.info(`[ScheduledTask #${task.id}] ${targetLevel === 'adset' ? 'AdSet' : 'AdSet(via ad)'} ${budgetNodeId} 无预算，切换为 CBO (Campaign ${targetCampaignId})`)
            }
          } catch (e) {
            logger.warn(`[ScheduledTask #${task.id}] 无法获取预算详情，尝试 CBO:`, e.message)
            useCBO = true
          }
        }
        const effectiveBudgetId = useCBO ? (targetLevel === 'campaign' ? budgetObjectId : targetCampaignId) : budgetObjectId
        if (!effectiveBudgetId) throw new Error('预算路由失败：缺少有效的预算对象 ID')

        let currentCents
        if (useCBO) {
          currentCents = await api.getCampaignBudget(effectiveBudgetId)
        } else {
          currentCents = await api.getAdsetBudget(effectiveBudgetId)
        }
        const action = { ...params, type: actionType }
        const newCents = computeNewBudgetCentsOnce(currentCents, action)
        if (newCents === currentCents) {
          logger.info(`[ScheduledTask #${task.id}] 预算无需调整（当前=${currentCents}分，目标=${newCents}分），跳过API调用`)
          apiRequest = makeReq('GET', `/${effectiveBudgetId}`, { action: 'readBudget' })
          apiResponse = makeResp(true, { skipped: true, reason: '预算无需调整', currentCents, newCents })
          return { result: null, apiRequest, apiResponse }
        }
        const direction = actionType === 'increase_budget' ? 'increase' : 'decrease'
        if (useCBO) {
          apiRequest = makeReq('POST', `/${effectiveBudgetId}`, { daily_budget: newCents, previousCents: currentCents, direction })
          result = await api.updateCampaignBudget(effectiveBudgetId, newCents)
        } else {
          apiRequest = makeReq('POST', `/${effectiveBudgetId}`, { daily_budget: newCents, previousCents: currentCents, direction })
          result = await api.updateAdsetBudget(effectiveBudgetId, newCents)
        }
        break
      }

      default:
        throw new Error(`不支持的动作类型: ${actionType}`)
    }

    apiResponse = makeResp(true, result && typeof result === 'object' ? result : { data: result })
    return { result, apiRequest, apiResponse }

  } catch (err) {
    apiResponse = makeResp(false, { error: err.message, stack: err.stack?.slice(0, 300) })
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
      adName: extra.adName || null,                                  // v3.2：关联广告名称
      runId: extra.runId || null,
      ruleName: taskName,
      objectType: targetLevel,
      objectId: targetId,
      objectName: extra.objectName || null,
      actionType: actionType,
      actionPayload: actionParams,
      // apiRequest/apiResponse 是 TEXT 列，需序列化为 JSON 字符串
      apiRequest: extra.apiRequest ? (typeof extra.apiRequest === 'string' ? extra.apiRequest : JSON.stringify(extra.apiRequest)) : null,
      apiResponse: extra.apiResponse ? (typeof extra.apiResponse === 'string' ? extra.apiResponse : JSON.stringify(extra.apiResponse)) : null,
      explanation: {
        trigger_type: 'scheduled',
        schedule_type: task.scheduleType || task.schedule_type,
        schedule_at: task.scheduleAt || task.schedule_at,
        scheduled_at: task.nextExecuteAt || task.next_execute_at,
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
    logger.error(`[ScheduledTask #${task.id}] 审计日志写入失败: ${e.message || '(无错误消息)'} code=${e.code} errno=${e.errno} sqlMessage=${e.sqlMessage}`)
  }
}

/**
 * 成功后更新任务状态
 * v3.2：增加 affectedRows 检查，乐观锁冲突时记录 warn；once 类型 nextExecuteAt 始终为 null
 */
async function updateTaskAfterExecute(task) {
  const scheduleType = task.scheduleType || task.schedule_type
  // once 类型是一次性的，执行后无需计算下次执行时间；其他类型正常计算
  const nextAt = scheduleType === 'once' ? null : await computeNextExecuteAt(task)
  let newEnabled = task.enabled ?? true
  if (scheduleType === 'once' && (task.autoDisable ?? task.auto_disable ?? true)) {
    newEnabled = false
  }
  const result = await db.update(scheduledTasks)
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
  const affected = Array.isArray(result) ? result[0]?.affectedRows : result?.affectedRows
  if (!affected) {
    logger.warn(`[ScheduledTask #${task.id}] updateTaskAfterExecute 乐观锁冲突，可能被并发修改`)
  }
}

/**
 * 失败后更新：不做重试（失败多为限流，短期重试无意义）
 * once 类型失败后直接禁用
 * 周期类型失败后前推到下一正常调度时间，不重试
 * v3.4：取消指数退避重试
 */
async function updateTaskAfterFailure(task) {
  const scheduleType = task.scheduleType || task.schedule_type
  const now = DateTime.utc()

  if (scheduleType === 'once') {
    // 一次性任务失败 → 直接禁用，不重试
    const result = await db.update(scheduledTasks)
      .set({
        lastStatus: 'fail',
        enabled: false,
        nextExecuteAt: null,
        lastExecutedAt: now.toJSDate(),
        version: sql`version + 1`
      })
      .where(and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.version, task.version ?? 0)
      ))
    const affected = Array.isArray(result) ? result[0]?.affectedRows : result?.affectedRows
    if (!affected) {
      logger.warn(`[ScheduledTask #${task.id}] updateTaskAfterFailure(once) 乐观锁冲突`)
      return
    }
    logger.warn(`[ScheduledTask #${task.id}] 一次性任务执行失败，已禁用（不重试）`)
    return
  }

  // 周期任务：不重试，直接前推到下一正常调度时间
  const nextAt = await computeNextExecuteAt(task)
  const result = await db.update(scheduledTasks)
    .set({
      lastStatus: 'fail',
      nextExecuteAt: nextAt,
      lastExecutedAt: now.toJSDate(),
      retryCount: 0,
      version: sql`version + 1`
    })
    .where(and(
      eq(scheduledTasks.id, task.id),
      eq(scheduledTasks.version, task.version ?? 0)
    ))
  const affected = Array.isArray(result) ? result[0]?.affectedRows : result?.affectedRows
  if (!affected) {
    logger.warn(`[ScheduledTask #${task.id}] updateTaskAfterFailure(periodic) 乐观锁冲突`)
    return
  }
  logger.warn(`[ScheduledTask #${task.id}] 执行失败，已前推到下一周期（不重试）`)
}

/**
 * 跳过时更新：前推 next_execute_at 到下一周期，防止每分钟重复 skip
 * once 类型跳过时直接禁用（目标不存在或账户未激活，重试无意义）
 * v3.2：增加 affectedRows 检查
 */
async function updateTaskAfterSkip(task) {
  const scheduleType = task.scheduleType || task.schedule_type
  if (scheduleType === 'once') {
    const result = await db.update(scheduledTasks)
      .set({
        lastStatus: 'skipped',
        enabled: false,
        version: sql`version + 1`
      })
      .where(and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.version, task.version ?? 0)
      ))
    const affected = Array.isArray(result) ? result[0]?.affectedRows : result?.affectedRows
    if (!affected) {
      logger.warn(`[ScheduledTask #${task.id}] updateTaskAfterSkip(once) 乐观锁冲突`)
    }
    return
  }
  const nextAt = await computeNextExecuteAt(task)
  const result = await db.update(scheduledTasks)
    .set({
      lastStatus: 'skipped',
      nextExecuteAt: nextAt,
      version: sql`version + 1`
    })
    .where(and(
      eq(scheduledTasks.id, task.id),
      eq(scheduledTasks.version, task.version ?? 0)
    ))
  const affected = Array.isArray(result) ? result[0]?.affectedRows : result?.affectedRows
  if (!affected) {
    logger.warn(`[ScheduledTask #${task.id}] updateTaskAfterSkip 乐观锁冲突`)
  }
}

/**
 * 刷写审计日志批次（v3.2：改为每个任务完成后立即刷写，防止服务重启丢日志）
 * @param {Array} batch - 审计日志记录数组
 */
async function flushAuditBatch(batch) {
  if (!batch || batch.length === 0) return
  // 逐条写入，每条失败单独记日志便于定位
  let ok = 0, fail = 0
  for (const record of batch) {
    try {
      await db.insert(automationLogs).values(record)
      ok++
    } catch (e) {
      fail++
      logger.error(`[ScheduledTask] 审计日志写入失败 (${ok+fail}/${batch.length}): ${e.message || '(无错误消息)'} code=${e.code} errno=${e.errno} sqlMessage=${e.sqlMessage}`)
    }
  }
  if (fail > 0) {
    logger.warn(`[ScheduledTask] 审计日志写入完成: ${ok} 成功, ${fail} 失败`)
  }
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
        let taskExecuted = 0, taskErrors = 0, taskSkippedAccounts = 0, taskSkipped = 0

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
            // v3.2: objectName/auditAdId/adName 提前声明并尽早解析，确保所有路径（含跳过）都能写入审计日志
            const targetLevel = (task.targetLevel || task.target_level || 'ad').toLowerCase()
            let auditAdId = targetId  // 默认值，解析失败时兜底
            let objectName = null
            let adName = null
            try {
              const actionType = task.actionType || task.action_type
              const isBudgetAction = ['set_budget', 'increase_budget', 'decrease_budget'].includes(actionType)
              let budgetObjectId = targetId
              let targetCampaignId = null  // v3.6：CBO 系列预算路由用

              // 解析审计日志用的 ad_id
              auditAdId = await resolveAuditAdId(acctId, targetLevel, targetId)

              // v3.5：提前解析对象名称 + 广告名称（在"找不到广告"跳过之前），确保跳过路径也能写入 audit 日志
              objectName = await resolveObjectName(acctId, targetLevel, targetId)
              adName = await resolveAdName(acctId, targetLevel, targetId)

              if (targetLevel === 'ad' && isBudgetAction) {
                const [adRows] = await pool.execute(
                  'SELECT adset_id, campaign_id FROM structure_ads WHERE account_id = ? AND ad_id = ? LIMIT 1',
                  [acctId, targetId]
                )
                if (adRows.length === 0) {
                  logger.warn(`[ScheduledTask #${task.id}] 账户 ${acctId} 目标 ${targetId} 找不到广告，跳过该对象`)
                  taskErrors++
                  auditBatch.push(buildAuditRecord(task, targetId, 'skipped', null, `找不到广告 ${targetId}`, { runId, objectName, adName, accountId: acctId, auditAdId }))
                  continue
                }
                budgetObjectId = adRows[0].adset_id
                targetCampaignId = adRows[0].campaign_id || null
              } else if (targetLevel === 'adset' && isBudgetAction) {
                // v3.6：广告组层级的预算动作也需要查 campaign_id，用于 CBO 路由
                const [adsetRows] = await pool.execute(
                  'SELECT campaign_id FROM structure_adsets WHERE account_id = ? AND adset_id = ? LIMIT 1',
                  [acctId, targetId]
                )
                if (adsetRows.length > 0) {
                  targetCampaignId = adsetRows[0].campaign_id || null
                }
              }

              // 执行
              if (task.isSimulation) {
                logger.info(`[ScheduledTask #${task.id}] Dry Run: ${task.actionType} on ${targetId} (${acctId})`)
                taskExecuted++
                auditBatch.push(buildAuditRecord(task, targetId, 'success', 'preflight', null, { runId, objectName, adName, accountId: acctId, auditAdId }))
              } else {
                const actionResult = await executeAction(api, task, targetId, budgetObjectId, targetCampaignId)
                // v3.4：预算类动作 result=null 表示已触达封顶/保底，实际未发 POST，记为 skipped
                if (actionResult.result === null) {
                  taskSkipped++
                  auditBatch.push(buildAuditRecord(task, targetId, 'skipped', null, '预算已触达上限/下限，无需调整', {
                    runId, objectName, adName, accountId: acctId, auditAdId,
                    apiRequest: actionResult.apiRequest,
                    apiResponse: actionResult.apiResponse
                  }))
                } else {
                  taskExecuted++
                  auditBatch.push(buildAuditRecord(task, targetId, 'success', null, null, {
                    runId, objectName, adName, accountId: acctId, auditAdId,
                    apiRequest: actionResult.apiRequest,
                    apiResponse: actionResult.apiResponse
                  }))
                }
              }
            } catch (targetErr) {
              logger.error(`[ScheduledTask #${task.id}] 账户 ${acctId} 目标 ${targetId} 执行失败:`, targetErr.message)
              taskErrors++
              auditBatch.push(buildAuditRecord(task, targetId, 'fail', null, targetErr.message, {
                runId, accountId: acctId, auditAdId, objectName, adName,
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
          // 所有目标都被跳过（账户未激活 / 无有效目标 / 预算触达上限）
          skipped++
          await updateTaskAfterSkip(task)
        }

        // v3.2：每个任务完成后立即刷写审计日志，防止服务重启丢日志
        await flushAuditBatch(auditBatch)
        auditBatch.length = 0

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
        // 异常路径也刷写审计日志
        await flushAuditBatch(auditBatch)
        auditBatch.length = 0
      }
    }

    // 最终兜底刷写（正常情况此时 auditBatch 已空，仅防御性保留）
    await flushAuditBatch(auditBatch)

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
export async function forceExecuteTask(task) {
  if (!task) return { success: false, message: '任务不存在' }

  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) return { success: false, message: 'FACEBOOK_ACCESS_TOKEN 缺失' }

  try {
    const api = new FacebookMarketingAPI(token)

    // v3 多账户支持
    const taskAccountIds = getTaskAccountIds(task)
    let totalSuccess = 0, totalFail = 0, totalSkipped = 0
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
        // v3.2: objectName 提前声明，确保失败路径也能写入审计日志
        // v3.5: objectName/adName 提前声明并尽早解析，确保跳过路径也能写入 audit 日志
        let objectName = null
        let adName = null
        try {
          const actionType = task.actionType || task.action_type
          const isBudgetAction = ['set_budget', 'increase_budget', 'decrease_budget'].includes(actionType)
          let budgetObjectId = targetId
          let targetCampaignId = null  // v3.6：CBO 系列预算路由用

          // 提前解析对象名称 + 广告名称（在"找不到广告"跳过之前）
          objectName = await resolveObjectName(acctId, targetLevel, targetId)
          adName = await resolveAdName(acctId, targetLevel, targetId)

          if (targetLevel === 'ad' && isBudgetAction) {
            const [adRows] = await pool.execute(
              'SELECT adset_id, campaign_id FROM structure_ads WHERE account_id = ? AND ad_id = ? LIMIT 1',
              [acctId, targetId]
            )
            if (adRows.length === 0) {
              totalFail++
              await writeAuditLog(task, targetId, 'skipped', null, `找不到广告 ${targetId}`, { runId, objectName, adName, accountId: acctId })
              continue
            }
            budgetObjectId = adRows[0].adset_id
            targetCampaignId = adRows[0].campaign_id || null
          } else if (targetLevel === 'adset' && isBudgetAction) {
            const [adsetRows] = await pool.execute(
              'SELECT campaign_id FROM structure_adsets WHERE account_id = ? AND adset_id = ? LIMIT 1',
              [acctId, targetId]
            )
            if (adsetRows.length > 0) {
              targetCampaignId = adsetRows[0].campaign_id || null
            }
          }

          if (task.isSimulation) {
            logger.info(`[ScheduledTask #${task.id}] Force Dry Run: ${task.actionType} on ${targetId} (${acctId})`)
            totalSuccess++
            await writeAuditLog(task, targetId, 'success', 'preflight', null, { runId, objectName, adName, accountId: acctId })
          } else {
            const actionResult = await executeAction(api, task, targetId, budgetObjectId, targetCampaignId)
            // v3.4：预算类动作 result=null 表示已触达封顶/保底，实际未发 POST，记为 skipped
            if (actionResult.result === null) {
              totalSkipped++
              await writeAuditLog(task, targetId, 'skipped', null, '预算已触达上限/下限，无需调整', {
                runId, objectName, adName, accountId: acctId,
                apiRequest: actionResult.apiRequest,
                apiResponse: actionResult.apiResponse
              })
            } else {
              totalSuccess++
              await writeAuditLog(task, targetId, 'success', null, null, {
                runId, objectName, adName, accountId: acctId,
                apiRequest: actionResult.apiRequest,
                apiResponse: actionResult.apiResponse
              })
            }
          }
        } catch (targetErr) {
          logger.error(`[ScheduledTask #${task.id}] 目标 ${targetId} 手动执行失败:`, targetErr.message)
          totalFail++
          await writeAuditLog(task, targetId, 'fail', null, targetErr.message, {
            runId, accountId: acctId, objectName, adName,
            apiRequest: targetErr._apiRequest || null,
            apiResponse: targetErr._apiResponse || null
          })
        }
      }
    }

    if (totalFail > 0) {
      await updateTaskAfterFailure(task)
      return { success: totalSuccess > 0, message: `执行完成: ${totalSuccess} 成功, ${totalSkipped} 跳过, ${totalFail} 失败` }
    }
    if (totalSuccess === 0) {
      await updateTaskAfterSkip(task)
      return { success: true, message: `全部跳过 (${totalSkipped} 个对象)` }
    }
    await updateTaskAfterExecute(task)
    return { success: true, message: `执行完成: ${totalSuccess} 成功, ${totalSkipped} 跳过` }
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
  const hasTargetByAccount = targetByAccount && typeof targetByAccount === 'object' && Object.keys(targetByAccount).length > 0
  let manualIds = []

  // v3.6：检测旧任务数据异常 — targetByAccount 把所有目标归到一个账户但 targetAccountIds 有多个账户
  const targetAccountIds = task.targetAccountIds ?? task.target_account_ids
  const hasMultipleTargetAccounts = Array.isArray(targetAccountIds) && targetAccountIds.length > 1
  const allTbaIds = hasTargetByAccount ? Object.values(targetByAccount).flat().map(v => String(v).trim()).filter(Boolean) : []
  const tbaHasOnlyOneAccount = hasTargetByAccount && Object.keys(targetByAccount).length === 1

  if (tbaHasOnlyOneAccount && hasMultipleTargetAccounts && allTbaIds.length > 0) {
    // 数据异常：所有目标被归到一个账户 → 对所有账户统一从 structure 表按真实归属查询
    logger.info(`[ScheduledTask #${task.id}] targetByAccount 数据异常（全部目标在单一账户），从 structure 表修复账户 ${accountId} 的归属`)
    try {
      const tableName = targetLevel === 'campaign' ? 'structure_campaigns' : targetLevel === 'adset' ? 'structure_adsets' : 'structure_ads'
      const idCol = targetLevel === 'campaign' ? 'campaign_id' : targetLevel === 'adset' ? 'adset_id' : 'ad_id'
      const placeholders = allTbaIds.map(() => '?').join(',')
      const [rows] = await pool.execute(
        `SELECT ${idCol} AS object_id FROM \`${tableName}\` WHERE account_id = ? AND ${idCol} IN (${placeholders})`,
        [accountId, ...allTbaIds]
      )
      manualIds = rows.map(r => String(r.object_id)).filter(Boolean)
      if (manualIds.length > 0) {
        logger.info(`[ScheduledTask #${task.id}] 从 structure 表为账户 ${accountId} 解析到 ${manualIds.length} 个目标`)
      }
    } catch (e) {
      logger.warn(`[ScheduledTask #${task.id}] 修复账户 ${accountId} 归属失败:`, e.message)
    }
  } else if (hasTargetByAccount && accountId && targetByAccount[accountId]) {
    // 该账户在 targetByAccount 中有明确的手动目标列表
    manualIds = (targetByAccount[accountId] || []).map(v => String(v).trim()).filter(Boolean)
  } else if (hasTargetByAccount && accountId) {
    // 该账户在 targetByAccount 中无数据（且前面已处理数据异常情况）→ 尝试从复合 targetIds 提取
    if (Array.isArray(targetIdsRaw) && targetIdsRaw.length > 0) {
      const prefix = `${accountId}:`
      manualIds = targetIdsRaw
        .filter(v => String(v).trim().startsWith(prefix))
        .map(v => String(v).trim().slice(prefix.length))
        .filter(Boolean)
    }
  } else if (!hasTargetByAccount && Array.isArray(targetIdsRaw) && targetIdsRaw.length > 0) {
    // 无 targetByAccount（单账户 / 旧数据兼容）：targetIds 中提取纯 ID
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
    return manualIds.filter(id => !excludeSet.has(id) && isValidObjectId(id))
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
          if (isValidObjectId(pureId)) dynIds.add(pureId)
        }
      }
    } catch (e) {
      logger.warn(`[ScheduledTask #${task.id}] 动态筛选解析失败，回退为仅手动 IDs:`, e.message)
    }
  }

  // 去重 + 排除
  return [...dynIds].filter(id => !excludeSet.has(id) && isValidObjectId(id))
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
    adName: extra.adName || null,                                   // v3.2：关联广告名称
    runId: extra.runId || null,
    ruleName: taskName,                                             // 任务自定义名称写入 rule_name
    objectType: targetLevel,
    objectId: String(targetId),
    objectName: extra.objectName || null,
    actionType,
    actionPayload: actionParams,
    // apiRequest/apiResponse 是 TEXT 列，需序列化为 JSON 字符串，不可直接传 JS 对象
    apiRequest: extra.apiRequest ? (typeof extra.apiRequest === 'string' ? extra.apiRequest : JSON.stringify(extra.apiRequest)) : null,
    apiResponse: extra.apiResponse ? (typeof extra.apiResponse === 'string' ? extra.apiResponse : JSON.stringify(extra.apiResponse)) : null,
    explanation: { trigger_type: 'scheduled', schedule_type: task.scheduleType || task.schedule_type, schedule_at: task.scheduleAt || task.schedule_at, scheduled_at: task.nextExecuteAt || task.next_execute_at, task_id: task.id, task_name: taskName },
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
 * 校验对象 ID 是否有效（非 null/undefined/空字符串，非字面量 "null"/"undefined"）
 */
function isValidObjectId(id) {
  if (id == null) return false
  const s = String(id).trim()
  return s.length > 0 && s !== 'null' && s !== 'undefined'
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
      ad: { table: 'structure_ads', col: 'ad_id', nameCol: 'name' },
      adset: { table: 'structure_adsets', col: 'adset_id', nameCol: 'name' },
      campaign: { table: 'structure_campaigns', col: 'campaign_id', nameCol: 'name' }
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
 * 解析审计日志用的 ad_name（v3.2）
 * ad 级目标直接查 ad_name；adset/campaign 级目标查该层级下任意一个 ad 的名称
 */
async function resolveAdName(accountId, targetLevel, targetId) {
  try {
    if (targetLevel === 'ad') {
      const [rows] = await pool.execute(
        'SELECT name FROM structure_ads WHERE account_id = ? AND ad_id = ? LIMIT 1',
        [accountId, targetId]
      )
      return rows?.[0]?.name || null
    }
    const filterCol = targetLevel === 'adset' ? 'adset_id' : 'campaign_id'
    const [rows] = await pool.execute(
      `SELECT name FROM structure_ads WHERE account_id = ? AND ${filterCol} = ? LIMIT 1`,
      [accountId, targetId]
    )
    return rows?.[0]?.name || null
  } catch {
    return null
  }
}

/**
 * 计算任务的下次执行时间（供外部 CRUD 使用）
 * @param {Object} task - 任务对象（含 schedule_type, schedule_at, schedule_cron, schedule_timezone, account_id）
 * @returns {Promise<Date|null>}
 */
export { computeNextExecuteAt }
