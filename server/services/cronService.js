// 定时任务服务 - AdsPolar 流水线架构
// 采用 AdsPolar 模式：数据同步完成后触发规则执行（链式反应）
// 账户级锁 + 超时保险丝，彻底解决僵尸锁问题
import cron from 'node-cron'
import logger from '../utils/logger.js'
import { db } from '../db/drizzle.js'
import { rules, automationLogs } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import pool from '../db/connection.js'
import { isAdminLikeRole } from '../middleware/authJwt.js'
import { RuleEngine, FacebookMarketingAPI } from '../index.js'
import { 
  syncAllAccountsTodayStats,
  syncAllAccountsSlidingWindow,
  archiveAllAccountsDailyStats,
  unifiedHeartbeatSync,
  cleanupAdSnapshots
} from './ingestorService.js'
import { getCircuitBreakerStatus, getLastUsageRate } from './rateLimitService.js'
import { executeActionsForRule, executeActionsForAd, resolveNewBudgetCentsForAction, mergeBudgetPendingActions, computeNewBudgetCentsOnce, resolveBudgetTargetContext } from './actionExecutorService.js'
import { pickSingleCandidateAction, getActionPriority } from '../utils/actionPriority.js'
import { loadDataForAccount, evaluateRuleWithCache } from './ruleEngineDispatcher.js'
import {
  loadRuleAdExecutionState,
  isCooldownDue,
  upsertRuleAdExecutionStateBatch
} from './ruleExecutionStateService.js'
import { getRuleExecutionAccountIds } from './ruleEnableGateService.js'
// [临时禁用] 定时任务模块有语法错误待修复
// import { executeDueScheduledTasks, isScheduledTaskRunning } from './scheduledTaskService.js'

// M4 Pre-Flight 刷新：执行前批量拉取 FB effective_status，解决 ad_snapshots 滞后导致误 POST
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN

/**
 * 批量拉取广告的 effective_status（用于 Pre-Flight 新鲜度）
 * @param {string[]} adIds - 广告 ID 列表
 * @returns {Promise<Map<string, string>>} adId -> effective_status（失败时返回空 Map，优雅降级）
 */
async function refreshEffectiveStatusForAds(adIds) {
  const result = new Map()
  if (!adIds?.length || !FACEBOOK_ACCESS_TOKEN) return result
  try {
    const api = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
    const items = await api.resolveObjectsByIds(adIds, { fields: 'id,effective_status,status' })
    for (const item of items) {
      const id = String(item?.id || '').trim()
      const status = item?.effective_status || item?.status || null
      if (id) result.set(id, status)
    }
  } catch (err) {
    logger.warn(`   ⚠️  Pre-Flight 刷新 status 失败，使用本地快照:`, err.message)
  }
  return result
}

async function writeBatchStatusAuditLog({
  runId,
  accountId,
  ownerId,
  rule,
  matchedAd,
  actionType,
  actionPayload = null,
  status,
  preflightMode = null,
  errorMessage = null,
  apiRequest = null,
  apiResponse = null
}) {
  const isSimulation = rule?.isSimulation || rule?.is_simulation || false
  const metricsSnapshot = {
    spend: matchedAd?.spend || 0,
    cpc: matchedAd?.cpc ?? null,
    ucpc: matchedAd?.ucpc ?? null,
    roas: matchedAd?.roas ?? null,
    cpa: matchedAd?.cpa ?? null,
    purchases: matchedAd?.purchases || 0,
    purchases_avg_after_create: matchedAd?.purchases_avg_after_create ?? null,
    purchases_avg_after_create_days: matchedAd?.purchases_avg_after_create_days ?? null,
    purchases_avg_after_create_range: matchedAd?.purchases_avg_after_create_range ?? null,
    link_clicks: matchedAd?.link_clicks ?? 0,
    unique_link_clicks: matchedAd?.unique_link_clicks ?? 0,
    add_to_cart_count: matchedAd?.add_to_cart_count ?? 0,
    initiate_checkout_count: matchedAd?.initiate_checkout_count ?? 0,
    add_payment_info_count: matchedAd?.add_payment_info_count ?? 0,
    ad_id: matchedAd?.ad_id,
    ad_name: matchedAd?.ad_name,
    status: matchedAd?.status ?? null
  }
  const explanationPayload = buildAutomationLogExplanation({
    rule,
    matchedObject: matchedAd,
    accountId
  })
  // M5 通用对象字段
  const logObjectType = matchedAd?.objectType || rule?.targetLevel || rule?.target_level || 'ad'
  const logObjectId = matchedAd?.objectId || (logObjectType === 'campaign'
    ? (matchedAd?.campaign_id || matchedAd?.ad_id || '')
    : logObjectType === 'adset'
      ? (matchedAd?.ad_set_id || matchedAd?.adset_id || matchedAd?.ad_id || '')
      : (matchedAd?.ad_id || ''))
  const logObjectName = matchedAd?.objectName || (logObjectType === 'campaign'
    ? (matchedAd?.campaign_name || null)
    : logObjectType === 'adset'
      ? (matchedAd?.adset_name || null)
      : (matchedAd?.ad_name || null))

  const auditLogContext = {
    runId: runId || null,
    ruleId: rule?.id || null,
    accountId: String(accountId),
    ownerId: ownerId ?? null,
    objectType: logObjectType,
    objectId: String(logObjectId || ''),
    adId: String(matchedAd?.ad_id || ''),
    actionType: String(actionType || ''),
    auditStatus: status
  }

  try {
    const insertResult = await db.insert(automationLogs).values({
      runId: runId || null,
      accountId: String(accountId),
      adId: String(matchedAd?.ad_id || ''),           // 旧字段兼容
      adName: matchedAd?.ad_name || null,              // 旧字段兼容
      // M5 通用对象字段（双写）
      objectType: logObjectType,
      objectId: String(logObjectId),
      objectName: logObjectName,
      preflightMode: preflightMode,
      ruleId: rule?.id || null,
      ruleName: rule?.ruleName || rule?.rule_name || null,
      ownerId: ownerId ?? 0,
      metricsSnapshot,
      explanation: explanationPayload,
      actionType: String(actionType || '').toUpperCase(),
      actionPayload: actionPayload || { type: actionType },
      isSimulation,
      apiRequest,
      apiResponse,
      status,
      errorMessage,
      triggeredAt: new Date()
    })
    const auditLogId = Array.isArray(insertResult)
      ? insertResult?.[0]?.insertId ?? null
      : insertResult?.insertId ?? null
    logAuditInsertSuccess({
      ...auditLogContext,
      auditLogId
    })
  } catch (e) {
    logAuditInsertFailure({
      context: auditLogContext,
      payload: {
        actionPayload: actionPayload || { type: actionType },
        metricsSnapshot,
        explanation: explanationPayload
      },
      error: e
    })
  }
}
import { syncAccountsFromFacebook } from './accountSyncService.js'
import { runHourlyStructureFullRotation, fastSyncStructureForAccount, collectFastSyncDataForAccount, applyMergedFastSyncPayload, healStructureIntegrity } from './structureSyncService.js'
import { refreshDynamicTargetsForAccount, isDynamicScopeFeatureEnabled } from './dynamicScopeService.js'
import { 
  insertRuleExecutionSummary, 
  sanitizeErrorMessage, 
  generateRunId 
} from './ruleExecutionSummaryService.js'
import { DateTime } from 'luxon'
import pLimit from 'p-limit'
import { buildAutomationLogExplanation } from '../utils/automationLogExplanation.js'
import {
  logAuditInsertFailure,
  logAuditInsertSuccess,
  logFbActionFailure,
  logFbActionSuccess
} from '../utils/auditLogTelemetry.js'

// ============================================
// 执行频率与执行时间（文档：执行频率与执行时间 — 适配方案）
// ============================================

/** 北京时区 */
const ZONE_BJ = 'Asia/Shanghai'

/**
 * 判断当前北京时间是否落在规则的允许执行时间段内（支持跨日窗口，见方案：执行时间跨日与24小时制）
 * @param {Object} rule - 规则（含 execution_time_windows / executionTimeWindows）
 * @param {import('luxon').DateTime} nowBJ - 当前北京时间（Luxon DateTime, zone=Asia/Shanghai）
 * @returns {boolean} 空/NULL/非数组视为全天允许 → true
 */
export function isInExecutionWindow(rule, nowBJ) {
  let windows = rule.executionTimeWindows ?? rule.execution_time_windows
  // MySQL/Drizzle 的 JSON 列可能返回字符串而非数组，需解析后再判断（见 BUG #744）
  if (typeof windows === 'string') {
    try {
      windows = JSON.parse(windows)
    } catch {
      return true
    }
  }
  if (windows == null || !Array.isArray(windows) || windows.length === 0) return true
  const hour = nowBJ.hour
  const minute = nowBJ.minute
  const second = nowBJ.second
  const currentSec = hour * 3600 + minute * 60 + second
  for (const w of windows) {
    const start = w.start || ''
    const end = w.end || ''
    const [sh, sm, ss] = start.split(':').map(Number)
    const [eh, em, es] = end.split(':').map(Number)
    const startSec = (sh || 0) * 3600 + (sm || 0) * 60 + (ss || 0)
    const endSec = (eh || 0) * 3600 + (em || 0) * 60 + (es || 0)
    // 同日内：当前秒数在 [startSec, endSec] 内则命中
    if (startSec < endSec) {
      if (currentSec >= startSec && currentSec <= endSec) return true
      continue
    }
    // 跨日（startSec > endSec）：当日 start 至次日 end，命中条件为 currentSec >= startSec || currentSec <= endSec
    if (startSec > endSec) {
      if (currentSec >= startSec || currentSec <= endSec) return true
      continue
    }
    // 相等（startSec === endSec）：视为全天该窗口恒命中（与 24:00–24:00 语义一致）
    return true
  }
  return false
}

// 锁超时时间：5分钟（如果规则执行超过5分钟，强制断开连接释放锁）5分钟（如果规则执行超过5分钟，强制断开连接释放锁）
const RULE_LOCK_TIMEOUT_MS = 5 * 60 * 1000

// 执行状态跟踪（用于手动触发和状态查询）
let lastExecutionTime = null
let lastExecutionResult = null
/** 全局：正在执行的规则任务数（executeAllRules 与 executeSingleRule 共用），用于 409/ALREADY_RUNNING 与 UI；对外仍用 isRunning = runningCount > 0 */
let runningCount = 0
const dirtyRefreshBackoffUntil = new Map() // accountId -> epoch ms

function getTrack2RuntimeOptionsFromEnv() {
  const limitRaw = Number(process.env.TRACK2_FAST_SYNC_LIMIT ?? 500)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 500)) : 500
  const maxPagesRaw = Number(process.env.TRACK2_FAST_SYNC_MAX_SOFT_PAGES ?? 20)
  const maxSoftPages = Number.isFinite(maxPagesRaw) ? Math.max(1, Math.min(Math.floor(maxPagesRaw), 100)) : 20
  const bufferRaw = Number(process.env.TRACK2_FAST_SYNC_BUFFER_SEC ?? 14400)
  const bufferSec = Number.isFinite(bufferRaw) ? Math.max(0, Math.min(Math.floor(bufferRaw), 86400)) : 14400
  return { limit, maxSoftPages, bufferSec }
}

/**
 * Dirty 预检查：若 account 的 fast_dirty=1，则在规则评估前先刷新一次结构快照
 * - 成功：清 fast_dirty，记录 fast_dirty_cleared_at
 * - 失败：保留 dirty，并设置内存退避，避免每分钟打爆
 */
async function refreshStructureIfDirtyBeforeRules(accountId) {
  const now = Date.now()
  const backoffUntil = dirtyRefreshBackoffUntil.get(accountId) || 0
  if (now < backoffUntil) {
    return { attempted: false, skipped: true, reason: 'backoff' }
  }

  const [rows] = await pool.execute(
    `SELECT fast_dirty, UNIX_TIMESTAMP(last_fast_sync_ts) AS last_fast_sync_sec
     FROM structure_sync_status
     WHERE account_id = ?`,
    [accountId]
  )
  const row = rows?.[0]
  const isDirty = Number(row?.fast_dirty ?? 0) === 1
  if (!isDirty) return { attempted: false, skipped: true, reason: 'clean' }

  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    dirtyRefreshBackoffUntil.set(accountId, now + 5 * 60 * 1000)
    logger.warn(`[DirtyPreCheck] account=${accountId} dirty=1 但缺少 FACEBOOK_ACCESS_TOKEN，5分钟后重试`)
    return { attempted: false, skipped: true, reason: 'no_token' }
  }

  const { limit, maxSoftPages, bufferSec } = getTrack2RuntimeOptionsFromEnv()
  const nowSec = Math.floor(now / 1000)
  const threeDaysAgoSec = nowSec - 3 * 24 * 60 * 60
  const lastFastSyncSecRaw = row?.last_fast_sync_sec
  const lastFastSyncSec = lastFastSyncSecRaw != null && Number.isFinite(Number(lastFastSyncSecRaw))
    ? Number(lastFastSyncSecRaw)
    : null
  const sinceSec = lastFastSyncSec != null
    ? Math.max(lastFastSyncSec - bufferSec, threeDaysAgoSec)
    : threeDaysAgoSec

  try {
    const api = new FacebookMarketingAPI(token)
    const result = await fastSyncStructureForAccount(accountId, api, {
      sinceSec,
      limit,
      maxSoftPagesPerEdge: maxSoftPages,
      markDirtyOnChange: false
    })
    if (!result?.ok) {
      dirtyRefreshBackoffUntil.set(accountId, now + 5 * 60 * 1000)
      logger.warn(`[DirtyPreCheck] account=${accountId} 刷新未成功 reason=${result?.reason || 'unknown'}，保留dirty并5分钟后重试`)
      return { attempted: true, ok: false, reason: result?.reason || 'refresh_failed' }
    }
    await pool.execute(
      `UPDATE structure_sync_status
       SET fast_dirty = 0,
           fast_dirty_cleared_at = NOW(),
           updated_at = NOW()
       WHERE account_id = ?`,
      [accountId]
    )
    dirtyRefreshBackoffUntil.delete(accountId)
    logger.info(`[DirtyPreCheck] account=${accountId} 刷新成功，dirty 已清空`)
    return { attempted: true, ok: true, reason: 'refreshed' }
  } catch (err) {
    dirtyRefreshBackoffUntil.set(accountId, now + 5 * 60 * 1000)
    logger.warn(`[DirtyPreCheck] account=${accountId} 刷新异常: ${err.message}，保留dirty并5分钟后重试`)
    return { attempted: true, ok: false, reason: 'error' }
  }
}

/**
 * AdsPolar 风格的 MySQL 锁实现（带超时保险丝）
 * 使用专用连接 + 超时保险丝，等价于给 GET_LOCK 加了 TTL
 * 
 * @param {string} accountId - 广告账户ID
 * @param {Function} ruleLogicFn - 规则执行函数 (accountId) => Promise<void>
 */
async function executeRulesWithLock(accountId, ruleLogicFn) {
  const lockName = `rule:account:${accountId}`
  let connection = null
  
  // 设置一个"保险丝"计时器
  // 如果 5 分钟还没跑完，强制销毁连接，释放锁
  const timeoutHandle = setTimeout(() => {
    if (connection) {
      logger.error(`🚨 [${accountId}] 规则执行超时 (5m)，强制断开连接以释放锁！`)
      connection.destroy() // 💥 物理切断 TCP 连接 -> MySQL 自动释放锁
    }
  }, RULE_LOCK_TIMEOUT_MS)

  try {
    // 1. 获取专用连接
    connection = await pool.getConnection()

    // 2. 尝试获取锁 (0秒等待，拿不到立刻放弃)
    const [rows] = await connection.query(`SELECT GET_LOCK(?, 0) as locked`, [lockName])
    if (!rows[0]?.locked) {
      logger.info(`🔒 [${accountId}] 正在执行中，跳过本次任务`)
      return undefined // 类似 Redis 的 NX (Not Exist)
    }

    // 3. 执行业务逻辑（支持返回结果，供单条规则执行使用）
    logger.info(`✅ [${accountId}] 获取锁成功，开始执行规则...`)
    return await ruleLogicFn(accountId)
  } catch (err) {
    // 如果是 destroy() 导致的错误，忽略它
    if (err.code !== 'PROTOCOL_CONNECTION_LOST') {
      logger.error(`❌ [${accountId}] 规则执行出错:`, err.message)
    }
  } finally {
    // 4. 清理现场
    clearTimeout(timeoutHandle) // 关掉保险丝
    
    if (connection && !connection._destroying) {
      // 主动释放锁
      try {
        await connection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      } catch (e) { 
        // 忽略释放错误（连接可能已被销毁）
      }
      
      // 归还连接
      connection.release()
    }
  }
}

/**
 * 检查规则是否满足冷却期条件
 * @param {Object} rule - 规则对象
 * @returns {boolean} - 是否可以执行
 */
function isRuleCooledDown(rule) {
  // 从未执行过，可以执行
  if (!rule.lastExecutedAt) return true
  
  const now = new Date()
  const lastExec = new Date(rule.lastExecutedAt)
  const diffMinutes = (now - lastExec) / (1000 * 60)
  
  // AdsPolar 模式：15分钟冷却期（跟随数据同步频率）
  return diffMinutes >= 15
}

/**
 * 更新规则的上次执行时间
 * @param {number} ruleId - 规则 ID
 * 
 * 注意：数据库会话时区已设置为 UTC，所以 new Date() 会被正确存储为 UTC 时间
 * MySQL 的 TIMESTAMP 字段会根据会话时区自动转换，这是正确的行为
 */
async function updateRuleLastExecutedAt(ruleId) {
  try {
    // new Date() 创建的是当前 UTC 时间的时间戳
    // 由于数据库会话时区是 UTC，MySQL 会正确存储为 UTC 时间
    await db
      .update(rules)
      .set({ lastExecutedAt: new Date() })
      .where(eq(rules.id, ruleId))
  } catch (error) {
    logger.error(`⚠️ 更新规则 ${ruleId} 的 lastExecutedAt 失败:`, error.message)
  }
}

// ============================================
// M4 动作执行层：按广告仲裁 + 摘要（步骤 1+6）
// ============================================

/**
 * 【RuleEngineDispatcher】汇总该账户下所有可执行规则的匹配结果，供仲裁使用
 * 按账户一次性拉取规则数据并缓存，多规则共用，避免每条规则单独查库（TASKS §2.4）
 *
 * @param {RuleEngine} ruleEngine
 * @param {Array<Object>} allRulesForAccount - 带 _ownerId 的规则列表
 * @param {string} lockedAccountId
 * @returns {Promise<Array<{ rule: Object, matchedAds: Array }>>}
 */
async function collectAllMatchesForAccount(ruleEngine, allRulesForAccount, lockedAccountId) {
  const scanStart = Date.now()
  let loadResult
  try {
    loadResult = await loadDataForAccount(lockedAccountId, allRulesForAccount, ruleEngine)
  } catch (err) {
    logger.error(`   ⚠️ [${lockedAccountId}] RuleEngineDispatcher 加载数据失败:`, err.message)
    loadResult = {
      cache: new Map(),
      targetAdIdsByRuleId: new Map(),
      cacheKeysByRule: new Map(),
      dataQueryCount: 0,
      targetResolutionQueryCount: 0
    }
  }

  const matchesPerRule = []
  for (const rule of allRulesForAccount) {
    let matchedAds = []
    try {
      matchedAds = evaluateRuleWithCache(ruleEngine, rule, loadResult)
      if (!Array.isArray(matchedAds)) matchedAds = []
    } catch (err) {
      logger.error(`   ⚠️ [${lockedAccountId}] 规则 "${rule.ruleName}" 评估异常:`, err.message)
    }
    matchesPerRule.push({ rule, matchedAds })
  }

  const totalEvalMs = Date.now() - scanStart
  const hitCount = matchesPerRule.filter(m => m.matchedAds?.length > 0).length
  logger.info(
    `   📊 [RuleEngineDispatcher] accountId=${lockedAccountId} 本轮回询: 数据${loadResult.dataQueryCount ?? 0}次, 目标解析${loadResult.targetResolutionQueryCount ?? 0}次, 规则${allRulesForAccount.length}条, 命中规则${hitCount}条, 评估耗时${totalEvalMs}ms`
  )
  return matchesPerRule
}

/**
 * 【教学】按 ad_id 仲裁：同一 ad 只保留一个赢家动作（优先级数字小优先，同优先级 ruleId 小者赢）
 * 约定：每 ad 固定一个 matchedAd 来源（用赢家规则对应的那份），执行层始终用同一份
 *
 * @param {Array<{ rule: Object, matchedAds: Array }>} matchesPerRule
 * @returns {Map<string, { winnerRule, winnerAction, matchedAd, suppressedRules: Array }>}
 */
function getExecutionScopeKey(rule, matchedObject, action = null) {
  if (action?.type === 'set_dynamic_budget') {
    const level = (rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()
    if (level === 'campaign') {
      const campaignId = String(matchedObject?.objectId || matchedObject?.campaign_id || '').trim()
      return campaignId ? `budget_campaign:${campaignId}` : null
    }
    const adsetId = String(matchedObject?.objectId || matchedObject?.ad_set_id || matchedObject?.adset_id || '').trim()
    return adsetId ? `budget_adset:${adsetId}` : null
  }
  const level = (rule?.targetLevel || rule?.target_level || 'ad').toLowerCase()
  if (level === 'adset') {
    const adsetId = String(matchedObject?.ad_set_id || matchedObject?.adset_id || '').trim()
    return adsetId ? `status_adset:${adsetId}` : null
  }
  if (level === 'campaign') {
    const campaignId = String(matchedObject?.campaign_id || '').trim()
    return campaignId ? `status_campaign:${campaignId}` : null
  }
  const adId = String(matchedObject?.ad_id || '').trim()
  return adId ? `status_ad:${adId}` : null
}

async function resolveExecutionScopeKey(rule, matchedObject, action = null, api = null) {
  if (action?.type === 'set_dynamic_budget' && api) {
    if (matchedObject?._resolvedDynamicBudgetTargetContext?.ruleId === rule?.id) {
      return matchedObject._resolvedDynamicBudgetTargetContext.cooldownKey || getExecutionScopeKey(rule, matchedObject, action)
    }
    try {
      const context = await resolveBudgetTargetContext(rule, matchedObject, api)
      if (matchedObject && typeof matchedObject === 'object') {
        matchedObject._resolvedDynamicBudgetTargetContext = { ...context, ruleId: rule?.id ?? null }
      }
      return context.cooldownKey || getExecutionScopeKey(rule, matchedObject, action)
    } catch (err) {
      logger.warn(`   [Dispatcher] 规则 ${rule?.id} 动态预算 scope 解析失败，回退静态 scope:`, err.message)
    }
  }
  return getExecutionScopeKey(rule, matchedObject, action)
}

async function arbitrateByScopeKey(matchesPerRule) {
  // 压成「每 (rule, scopeKey) 一个候选动作」
  const byScopeKey = new Map() // scopeKey -> Array<{ rule, matchedAd, candidateAction }>
  const budgetApi = FACEBOOK_ACCESS_TOKEN ? new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN) : null
  for (const { rule, matchedAds } of matchesPerRule) {
    const candidateAction = pickSingleCandidateAction(rule.actions)
    if (!candidateAction) continue
    const priority = getActionPriority(candidateAction.type)
    for (const matchedAd of matchedAds) {
      const scopeKey = await resolveExecutionScopeKey(rule, matchedAd, candidateAction, budgetApi)
      if (!scopeKey) continue
      if (!byScopeKey.has(scopeKey)) byScopeKey.set(scopeKey, [])
      byScopeKey.get(scopeKey).push({ rule, matchedAd, candidateAction, priority })
    }
  }
  // 每个 scopeKey 选赢家：优先级数字小优先，同优先级 ruleId 小者赢
  const result = new Map()
  for (const [scopeKey, candidates] of byScopeKey) {
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return (a.rule.id || 0) - (b.rule.id || 0)
    })
    const winner = candidates[0]
    const suppressedRules = candidates.slice(1).map(c => c.rule)
    result.set(scopeKey, {
      winnerRule: winner.rule,
      winnerAction: winner.candidateAction,
      matchedAd: winner.matchedAd,
      suppressedRules
    })
  }
  return result
}

export function deriveSummaryStatus({
  matchedCount,
  executedCount,
  failedCount,
  skippedCount,
  outsideCount = 0,
  suppressedCount = 0,
  mutedCount = 0
}) {
  const hasMatchedObjects = Number(matchedCount || 0) > 0
  if (!hasMatchedObjects) return { status: 'no_match', skipReason: 'no_match' }
  if (Number(failedCount || 0) > 0 || Number(executedCount || 0) > 0) {
    return { status: 'matched', skipReason: null }
  }
  if (Number(mutedCount || 0) > 0) return { status: 'skipped', skipReason: 'muted' }
  if (Number(outsideCount || 0) > 0) return { status: 'skipped', skipReason: 'outside_execution_window' }
  if (Number(suppressedCount || 0) > 0) return { status: 'skipped', skipReason: 'suppressed_by_priority' }
  if (Number(skippedCount || 0) > 0) return { status: 'skipped', skipReason: 'preflight_all_skipped' }
  return { status: 'skipped', skipReason: 'matched_without_execution' }
}

/**
 * 仲裁后按规则写摘要：同一规则可既有 executed_count/failed_count 又有 skip_details.suppressed_for_ads / outside_execution_window
 *
 * @param {string} runId
 * @param {Array<{ rule: Object, matchedAds: Array }>} matchesPerRule
 * @param {Map<string, { winnerRule, winnerAction, matchedAd, suppressedRules }>} arbitrated
 * @param {Object} executionResultsByScope - scope_key -> { success, fail, skipped }
 * @param {string} accountId
 * @param {Map<number, Array>} ruleToMuted - ruleId -> [{ scope_key, mute_until, mute_reason }]（Smart Mute 已移除，通常为空）
 * @param {Map<number, Array>} ruleToOutsideWindow - ruleId -> [{ scope_key, windows }] 不在执行时间段内的对象
 */
async function writeSummariesAfterArbitration(runId, matchesPerRule, arbitrated, executionResultsByScope, accountId, ruleToMuted = new Map(), ruleToOutsideWindow = new Map()) {
  const ruleToExecuted = new Map()   // ruleId -> { executed, failed, skipped }
  const ruleToSuppressed = new Map() // ruleId -> Array<{ ad_id, winner_rule_id }>
  for (const [scopeKey, meta] of arbitrated) {
    const rid = meta.winnerRule.id
    if (!ruleToExecuted.has(rid)) ruleToExecuted.set(rid, { executed: 0, failed: 0, skipped: 0 })
    const res = executionResultsByScope[scopeKey] || {}
    ruleToExecuted.get(rid).executed += res.success || 0
    ruleToExecuted.get(rid).failed += res.fail || 0
    ruleToExecuted.get(rid).skipped += res.skipped || 0
    for (const r of meta.suppressedRules) {
      const ruleId = r.id
      if (!ruleToSuppressed.has(ruleId)) ruleToSuppressed.set(ruleId, [])
      ruleToSuppressed.get(ruleId).push({ scope_key: scopeKey, winner_rule_id: meta.winnerRule.id })
    }
  }
  for (const { rule, matchedAds } of matchesPerRule) {
    const exec = ruleToExecuted.get(rule.id) || { executed: 0, failed: 0, skipped: 0 }
    const supp = ruleToSuppressed.get(rule.id) || []
    const muted = ruleToMuted.get(rule.id) || []
    const outsideList = ruleToOutsideWindow.get(rule.id) || []
    const totalMatched = matchedAds.length
    const summaryStatus = deriveSummaryStatus({
      matchedCount: totalMatched,
      executedCount: exec.executed,
      failedCount: exec.failed,
      skippedCount: exec.skipped,
      outsideCount: outsideList.length,
      suppressedCount: supp.length,
      mutedCount: muted.length
    })
    const status = summaryStatus.status
    const skipReason = summaryStatus.skipReason
    const skipDetails = muted.length > 0
      ? { mute_until: muted[0]?.mute_until, mute_reason: muted[0]?.mute_reason, scope_keys: muted.map(m => m.scope_key) }
      : (outsideList.length > 0 ? { windows: outsideList[0]?.windows, scope_keys: outsideList.map(o => o.scope_key) } : (supp.length > 0 ? { suppressed_for_scopes: supp } : null))
    await insertRuleExecutionSummary({
      runId,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      accountId,
      userId: rule.userId,
      ownerId: rule._ownerId ?? 0,
      matchedCount: totalMatched,
      executedCount: exec.executed,
      failedCount: exec.failed,
      skippedCount: exec.skipped,
      status,
      summaryScope: 'account',
      skipReason,
      skipDetails,
      errorMessage: null,
      durationMs: 0,
      evaluatedAt: new Date()
    })
  }
}

/**
 * 判断规则是否作用于指定账户（与 getRuleAccountIds 口径一致：仅「有目标」的账户才适用）
 * - target_by_account[accountId] 为非空数组时返回 true；空数组视为该账户无目标，返回 false，避免无谓评估与锁
 */
function ruleAppliesToAccount(rule, accountId) {
  if (rule.accountId === accountId) return true
  const targetAccountIds = rule.targetAccountIds ?? rule.target_account_ids
  if (Array.isArray(targetAccountIds) && targetAccountIds.includes(accountId)) return true
  const targetByAccount = rule.targetByAccount ?? rule.target_by_account
  if (targetByAccount && typeof targetByAccount === 'object' && accountId in targetByAccount) {
    const ids = targetByAccount[accountId]
    return Array.isArray(ids) && ids.length > 0
  }
  return false
}

/** 取规则涉及的所有账户 ID 列表（用于单条规则多账户执行）
 * 优先使用 target_by_account：只返回「有非空目标」的账户，与 ruleAppliesToAccount 口径一致
 */
function getRuleAccountIds(rule) {
  const targetByAccount = rule.targetByAccount ?? rule.target_by_account
  if (targetByAccount && typeof targetByAccount === 'object') {
    const keys = Object.keys(targetByAccount).filter(
      (k) => Array.isArray(targetByAccount[k]) && targetByAccount[k].length > 0
    )
    if (keys.length > 0) return keys
  }
  const targetAccountIds = rule.targetAccountIds ?? rule.target_account_ids
  if (Array.isArray(targetAccountIds) && targetAccountIds.length > 0) return targetAccountIds
  return rule.accountId ? [rule.accountId] : []
}

/**
 * AdsPolar 流水线架构：为单个账户执行规则
 * 账户级锁 + 超时保险丝，彻底解决僵尸锁问题
 *
 * @param {string} accountId - 广告账户ID
 * @param {Object} options - 执行选项
 * @param {boolean} options.force - 是否强制执行（忽略规则级冷却，仅非调度路径有效）
 * @param {string} [options.runId] - 运行批次 ID
 * @param {boolean} [options.fromScheduler=false] - 是否来自「每分钟 Cron」调度；为 true 时使用广告级冷却表与执行时间段，为 false 时（含单条规则执行）不读不写 rule_ad_execution_state
 * @returns {Promise<Object>} 执行统计
 *
 * 调度路径：仅当 fromScheduler=true（* * * * * Cron 调用）时读写 rule_ad_execution_state、做执行时间段检查。
 * 单条规则执行走 executeSingleRule，不调用本函数，故不参与冷却表。
 */
export async function executeRulesForAccount(accountId, options = {}) {
  const { force = false, runId = null, fromScheduler = false } = options
  const enableActionBatch = process.env.ENABLE_ACTION_BATCH === '1' || process.env.ENABLE_ACTION_BATCH === 'true'

  const [mappingActive] = await pool.execute(
    `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1`,
    [accountId]
  )
  if (mappingActive.length === 0) {
    logger.info(`   ⏸️  [${accountId}] 账户映射未启用(is_active≠1)，跳过规则执行`)
    return {
      accountId,
      matched: 0,
      executed: 0,
      skipped: 0,
      errors: 0
    }
  }
  
  // ✅ 如果没有传入 runId，生成新的
  const currentRunId = runId || generateRunId()
  
  // 统计信息
  let accountMatched = 0
  let accountExecuted = 0
  let accountSkipped = 0
  let accountErrors = 0

  // 使用账户级锁执行规则
  await executeRulesWithLock(accountId, async (lockedAccountId) => {
    if (fromScheduler) {
      await refreshStructureIfDirtyBeforeRules(lockedAccountId)
      // TriggerA：规则调度前预检查完成后，刷新该账户动态快照（失败不阻塞执行）
      if (isDynamicScopeFeatureEnabled()) {
        try {
          await refreshDynamicTargetsForAccount(lockedAccountId, { trigger: 'dirty_precheck' })
        } catch (e) {
          logger.warn(`[DynamicScope] trigger=dirty_precheck account=${lockedAccountId} 刷新失败(不阻塞规则执行): ${e.message}`)
        }
      }
    }

    // 1. 从数据库获取所有启用的规则（跳过未绑定任何执行账户的半成品，与原则 A 一致）
    const enabledRulesRaw = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
    const enabledRules = enabledRulesRaw.filter((r) => getRuleExecutionAccountIds(r).length > 0)
    
    // 调度路径（每分钟 Cron）：不做规则级冷却过滤，改用广告级冷却表
    // 非调度路径（如历史/强制）：保留规则级冷却
    const cooledDownRules = fromScheduler
      ? enabledRules
      : (force ? enabledRules : enabledRules.filter(isRuleCooledDown))
    
    // 调试日志：显示规则数量
    if (enabledRules.length === 0) {
      logger.info(`   ⚠️  [${lockedAccountId}] 数据库中没有启用的规则，跳过执行`)
      return
    }
    
    if (cooledDownRules.length === 0 && !fromScheduler) {
      const neverExecuted = enabledRules.filter(r => !r.lastExecutedAt).length
      const inCooldown = enabledRules.length - neverExecuted
      logger.info(`   ⏸️  [${lockedAccountId}] 所有规则都在冷却期内，跳过执行（总规则: ${enabledRules.length}, 冷却中: ${inCooldown}, 从未执行: ${neverExecuted}）`)
      return
    }
    
    if (cooledDownRules.length === 0) return
    
    if (!fromScheduler && enabledRules.length > cooledDownRules.length) {
      const skippedCount = enabledRules.length - cooledDownRules.length
      logger.info(`   📊 [${lockedAccountId}] 冷却期过滤: ${enabledRules.length} 条规则 → ${cooledDownRules.length} 条可执行（跳过 ${skippedCount} 条）`)
    }

    if (cooledDownRules.length > 0) {
      logger.info(`   📋 [${lockedAccountId}] 找到 ${cooledDownRules.length} 条可执行规则`)
    }

    // M4：只处理「作用于本账户」的规则
    const rulesForAccount = cooledDownRules.filter(r => ruleAppliesToAccount(r, lockedAccountId))
    const rulesByUser = {}
    for (const rule of rulesForAccount) {
      const uid = rule.userId
      if (!rulesByUser[uid]) rulesByUser[uid] = []
      rulesByUser[uid].push(rule)
    }

    const ruleEngine = new RuleEngine(null)
    const allRulesForAccount = [] // 有权限的规则（带 _ownerId）

    for (const [userId, userRules] of Object.entries(rulesByUser)) {
      const [userRows] = await pool.execute(
        `SELECT u.id, u.role, u.owner_id FROM users u WHERE u.id = ? AND u.status = 'active'`,
        [userId]
      )
      if (userRows.length === 0) {
        for (const rule of userRules) {
          await insertRuleExecutionSummary({
            runId: currentRunId,
            ruleId: rule.id,
            ruleName: rule.ruleName,
            accountId: lockedAccountId,
            userId: parseInt(userId),
            ownerId: 0,
            status: 'skipped',
            summaryScope: 'account',
            skipReason: 'user_not_found',
            skipDetails: { user_id: parseInt(userId) },
            evaluatedAt: new Date()
          })
        }
        continue
      }
      const user = userRows[0]
      let hasAccess = false
      if (isAdminLikeRole(user.role)) {
        hasAccess = true
      } else {
        const [accRows] = await pool.execute(
          `SELECT 1 FROM account_mappings WHERE owner_id = ? AND is_active = 1 AND fb_account_id = ?`,
          [user.owner_id || 0, lockedAccountId]
        )
        hasAccess = accRows.length > 0
      }
      if (!hasAccess) {
        for (const rule of userRules) {
          await insertRuleExecutionSummary({
            runId: currentRunId,
            ruleId: rule.id,
            ruleName: rule.ruleName,
            accountId: lockedAccountId,
            userId: parseInt(userId),
            ownerId: user.owner_id || 0,
            status: 'skipped',
            summaryScope: 'account',
            skipReason: 'no_permission',
            skipDetails: { user_id: parseInt(userId), account_id: lockedAccountId },
            evaluatedAt: new Date()
          })
        }
        continue
      }
      for (const rule of userRules) {
        allRulesForAccount.push({ ...rule, _ownerId: user.owner_id || 0 })
      }
    }

    if (allRulesForAccount.length === 0) {
      logger.info(`   📋 [${lockedAccountId}] 本账户无有权规则可执行，跳过`)
      return
    }

    logger.info(`   📋 [${lockedAccountId}] M4 汇总 ${allRulesForAccount.length} 条规则，开始评估 → 仲裁 → 执行`)

    // 全量评估 → 按 ad_id 仲裁 → 执行（每 ad 只执行一次赢家动作）
    let matchesPerRule = await collectAllMatchesForAccount(ruleEngine, allRulesForAccount, lockedAccountId)

    // 调度路径：广告级冷却过滤 + 冷却表读写（M5：status 冷却键按层级区分）
    if (fromScheduler) {
      const nowUtc = Date.now()
      const pairs = [] // { ruleId, scopeKey, intervalMin, rule, matchedAd }[]
      const budgetApi = FACEBOOK_ACCESS_TOKEN ? new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN) : null
      for (const { rule, matchedAds } of matchesPerRule) {
        const intervalMin = rule.executionIntervalMinutes ?? rule.execution_interval_minutes ?? 15
        const candidateAction = pickSingleCandidateAction(rule.actions)
        for (const ad of matchedAds || []) {
          const scopeKey = await resolveExecutionScopeKey(rule, ad, candidateAction, budgetApi)
          if (!scopeKey) continue
          pairs.push({ ruleId: rule.id, scopeKey, intervalMin, rule, matchedAd: ad })
        }
      }
      // 按 ruleId 分组批量查冷却表（scope_key）
      const ruleToScopeKeys = new Map()
      for (const p of pairs) {
        if (!ruleToScopeKeys.has(p.ruleId)) ruleToScopeKeys.set(p.ruleId, [])
        ruleToScopeKeys.get(p.ruleId).push(p.scopeKey)
      }
      const stateByRule = new Map() // ruleId -> Map(scopeKey -> last_executed_at)
      for (const [ruleId, scopeKeys] of ruleToScopeKeys) {
        const uniq = [...new Set(scopeKeys)]
        const state = await loadRuleAdExecutionState(ruleId, uniq)
        stateByRule.set(ruleId, state)
      }
      // 过滤：只保留冷却到期的 (rule, ad)
      const dueByRule = new Map() // ruleId -> [matchedAd, ...]
      for (const { ruleId, scopeKey, intervalMin, rule, matchedAd } of pairs) {
        const lastAt = stateByRule.get(ruleId)?.get(scopeKey)
        const diffMin = lastAt ? (nowUtc - lastAt.getTime()) / 60000 : Infinity
        if (diffMin >= intervalMin) {
          if (!dueByRule.has(ruleId)) dueByRule.set(ruleId, [])
          dueByRule.get(ruleId).push(matchedAd)
        }
      }
      matchesPerRule = allRulesForAccount
        .map(rule => ({ rule, matchedAds: dueByRule.get(rule.id) || [] }))
        .filter(m => m.matchedAds.length > 0)
      if (matchesPerRule.length === 0) {
        logger.info(`   ⏸️  [${lockedAccountId}] 广告级冷却：无到期匹配，跳过仲裁与执行`)
        return
      }
    }

    const arbitrated = await arbitrateByScopeKey(matchesPerRule)

    // M4 Pre-Flight 刷新：对 pause/activate 且非 Dry Run 的广告，批量拉取 FB effective_status
    const refreshAdIds = []
    for (const [, meta] of arbitrated) {
      const act = meta.winnerAction?.type
      const isSim = meta.winnerRule?.isSimulation ?? meta.winnerRule?.is_simulation ?? false
      if ((act === 'pause_ad' || act === 'activate_ad') && !isSim) {
        refreshAdIds.push(String(meta.matchedAd?.ad_id || '').trim())
      }
    }
    const validRefreshIds = [...new Set(refreshAdIds.filter(Boolean))]
    if (validRefreshIds.length > 0) {
      const statusMap = await refreshEffectiveStatusForAds(validRefreshIds)
      for (const [, meta] of arbitrated) {
        const adId = String(meta.matchedAd?.ad_id || '').trim()
        if (!adId) continue
        const fresh = statusMap.get(adId)
        if (typeof fresh === 'string' && fresh.trim()) meta.matchedAd.status = fresh
      }
    }

    /**
     * M4/M5: 根据规则 targetLevel 构建状态动作冷却键
     * 格式：status_ad:{adId} | status_adset:{adsetId} | status_campaign:{campaignId}
     */
    const buildStatusCooldownKey = getExecutionScopeKey

    const executionResultsByScope = {}
    const ruleToMuted = new Map()  // 保留结构，Smart Mute 已移除，不再写入
    const ruleToOutsideWindow = new Map()  // ruleId -> [{ ad_id, windows }]
    const stateUpdates = []  // 调度路径：{ ruleId, scopeKey, lastStatus }[]
    const allPendingActions = [] // 收集本账户下所有 PendingAction，供预算合并与后续 Batch 使用
    let budgetApi = null
    const batchStatusPlans = []
    const batchBudgetPlans = [] // 保留声明供 canUseBatchForBudget 块内使用（当前 canUseBatchForBudget=false 不进入）
    for (const [scopeKey, meta] of arbitrated) {
      const adId = String(meta.matchedAd?.ad_id || '').trim()
      // 调度路径：执行时间段检查（文档 §4.2）
      if (fromScheduler) {
        const nowBJ = DateTime.utc().setZone(ZONE_BJ)
        const inWindow = isInExecutionWindow(meta.winnerRule, nowBJ)
        const triggeredRulesForAd = [meta.winnerRule, ...(meta.suppressedRules || [])]
        if (!inWindow) {
          logger.info(`   🕐 [${lockedAccountId}] 对象 ${scopeKey} 不在执行时间段内，跳过执行`)
          executionResultsByScope[scopeKey] = { success: 0, fail: 0, skipped: 1 }
          const list = ruleToOutsideWindow.get(meta.winnerRule.id) || []
          list.push({ scope_key: scopeKey, windows: meta.winnerRule.executionTimeWindows ?? meta.winnerRule.execution_time_windows })
          ruleToOutsideWindow.set(meta.winnerRule.id, list)
          const statusKey = scopeKey
          stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: statusKey, lastStatus: 'outside_window' })
          for (const r of meta.suppressedRules || []) {
            stateUpdates.push({ ruleId: r.id, scopeKey, lastStatus: 'suppressed' })
          }
          continue
        }
        // 在执行时间段内：suppressed 先写入；winner 状态在执行完后按结果写入
        for (const r of meta.suppressedRules || []) {
          stateUpdates.push({ ruleId: r.id, scopeKey, lastStatus: 'suppressed' })
        }
      }

      // M4 3.2 预算幂等：预算类动作在调用方预计算一次 newBudgetCents
      let actionToPass = meta.winnerAction
      const isBudgetAction = actionToPass && ['increase_budget', 'decrease_budget', 'set_budget'].includes(actionToPass.type)
      const isSim = meta.winnerRule?.isSimulation ?? meta.winnerRule?.is_simulation ?? false
      const adsetId = meta.matchedAd?.ad_set_id || meta.matchedAd?.adset_id
      if (isBudgetAction && !isSim && adsetId && FACEBOOK_ACCESS_TOKEN) {
        try {
          if (!budgetApi) budgetApi = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
          const newBudgetCents = await resolveNewBudgetCentsForAction(budgetApi, adsetId, actionToPass)
          actionToPass = { ...actionToPass, _resolvedBudgetCents: newBudgetCents }
        } catch (err) {
          logger.warn(`   ⚠️ [${lockedAccountId}] 预计算预算失败 ad=${adId} adset=${adsetId}:`, err.message)
          // 不挂 _resolvedBudgetCents，执行层会自己 GET+算（退化为一试一次）
        }
      }
      let success = 0
      let fail = 0
      let skipped = 0
      let results = []
      const isStatusAction = actionToPass && ['pause_ad', 'activate_ad'].includes(actionToPass.type)
      // M4: 仅 ad 级状态动作可使用 Batch；adset/campaign 走逐条执行
      const winnerTargetLevel = (meta.winnerRule?.targetLevel || meta.winnerRule?.target_level || 'ad').toLowerCase()
      const isAdLevelStatusAction = isStatusAction && winnerTargetLevel === 'ad'
      const canUseBatchForStatus = enableActionBatch && fromScheduler && isAdLevelStatusAction && !isSim
      if (canUseBatchForStatus) {
        const adStatus = String(meta.matchedAd?.status || '').toUpperCase()
        const skipPause = actionToPass.type === 'pause_ad' && ['PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(adStatus)
        const skipActivateDone = actionToPass.type === 'activate_ad' && adStatus === 'ACTIVE'
        const skipActivateForbidden = actionToPass.type === 'activate_ad' && ['ARCHIVED', 'DELETED'].includes(adStatus)
        const preflightSkipped = skipPause || skipActivateDone || skipActivateForbidden
        if (preflightSkipped) {
          const reason = skipPause
            ? 'already_paused'
            : (skipActivateDone ? 'already_active' : 'cannot_activate')
          // 目标状态已达成：跳过执行，但更新冷却时钟（避免每分钟重复检查）
          // 安全：下次 Cron 走到冷却未到期分支时不会再次重置时钟
          executionResultsByScope[scopeKey] = { success: 0, fail: 0, skipped: 1 }
          accountMatched++
          accountExecuted++
          const cooldownKey = buildStatusCooldownKey(meta.winnerRule, meta.matchedAd)
          stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: cooldownKey, lastStatus: 'success' })
          await writeBatchStatusAuditLog({
            runId: currentRunId,
            accountId: lockedAccountId,
            ownerId: meta.winnerRule._ownerId ?? 0,
            rule: meta.winnerRule,
            matchedAd: meta.matchedAd,
            actionType: actionToPass.type,
            status: 'skipped',
            errorMessage: `目标已达成（status=${adStatus}）`,
            apiRequest: JSON.stringify({ preFlight: true, status: adStatus }),
            apiResponse: JSON.stringify({ skipped: true, reason })
          })
          continue
        }
        batchStatusPlans.push({
          scopeKey,
          adId,
          rule: meta.winnerRule,
          matchedAd: meta.matchedAd,
          ownerId: meta.winnerRule._ownerId ?? 0,
          actionType: actionToPass.type,
          cooldownKey: buildStatusCooldownKey(meta.winnerRule, meta.matchedAd)
        })
        allPendingActions.push({
          kind: 'status',
          op: actionToPass.type === 'pause_ad' ? 'pause' : 'activate',
          targetLevel: winnerTargetLevel,
          accountId: lockedAccountId,
          targetObjectId: adId,
          ruleId: meta.winnerRule.id,
          runId: currentRunId
        })
        continue
      }
      const canUseBatchForBudget = false // 预算改为逐条 GET→预计算→POST，不再 Batch；状态类仍用 Batch
      if (canUseBatchForBudget) {
        try {
          if (!budgetApi) budgetApi = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
          const intervalMin = meta.winnerRule.executionIntervalMinutes ?? meta.winnerRule.execution_interval_minutes ?? 15
          const adsetId = meta.matchedAd?.ad_set_id || meta.matchedAd?.adset_id
          if (!adsetId) {
            executionResultsByScope[scopeKey] = { success: 0, fail: 1, skipped: 0 }
            accountMatched++
            accountExecuted++
            accountErrors++
            stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: buildStatusCooldownKey(meta.winnerRule, meta.matchedAd), lastStatus: 'fail' })
            await writeBatchStatusAuditLog({
              runId: currentRunId,
              accountId: lockedAccountId,
              ownerId: meta.winnerRule._ownerId ?? 0,
              rule: meta.winnerRule,
              matchedAd: meta.matchedAd,
              actionType: actionToPass.type,
              actionPayload: actionToPass,
              status: 'fail',
              errorMessage: 'adset_id 不存在，无法调整预算',
              apiRequest: null,
              apiResponse: JSON.stringify({ error: 'missing_adset_id' })
            })
            continue
          }

          const adsetDetail = await budgetApi.getAdsetBudgetDetail(adsetId)
          const isABO = adsetDetail && ((adsetDetail.daily_budget || 0) > 0 || (adsetDetail.lifetime_budget || 0) > 0)
          let scope = 'adset'
          let nodeId = adsetId
          let isDaily = true
          let currentCents = 0
          if (isABO) {
            currentCents = (adsetDetail.daily_budget || 0) > 0 ? adsetDetail.daily_budget : adsetDetail.lifetime_budget
            isDaily = (adsetDetail.daily_budget || 0) > 0
          } else {
            const campaignId = meta.matchedAd?.campaign_id || null
            if (!campaignId) {
              executionResultsByScope[scopeKey] = { success: 0, fail: 1, skipped: 0 }
              accountMatched++
              accountExecuted++
              accountErrors++
              stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: buildStatusCooldownKey(meta.winnerRule, meta.matchedAd), lastStatus: 'fail' })
              await writeBatchStatusAuditLog({
                runId: currentRunId,
                accountId: lockedAccountId,
                ownerId: meta.winnerRule._ownerId ?? 0,
                rule: meta.winnerRule,
                matchedAd: meta.matchedAd,
                actionType: actionToPass.type,
                actionPayload: actionToPass,
                status: 'fail',
                errorMessage: 'CBO 广告系列缺少 campaign_id，无法调整系列预算',
                apiRequest: null,
                apiResponse: JSON.stringify({ error: 'missing_campaign_id' })
              })
              continue
            }
            const campaignDetail = await budgetApi.getCampaignBudgetDetail(campaignId)
            scope = 'campaign'
            nodeId = campaignId
            currentCents = (campaignDetail.daily_budget || 0) > 0 ? campaignDetail.daily_budget : campaignDetail.lifetime_budget
            isDaily = (campaignDetail.daily_budget || 0) > 0
          }

          const cooldownKey = scope === 'adset' ? `budget_adset:${nodeId}` : `budget_campaign:${nodeId}`
          if (intervalMin > 0) {
            const due = await isCooldownDue(meta.winnerRule.id, cooldownKey, intervalMin)
            if (!due) {
              // 冷却未到期：跳过执行，不更新 rule_ad_execution_state（避免重置冷却时钟）
              executionResultsByScope[scopeKey] = { success: 0, fail: 0, skipped: 1 }
              accountMatched++
              accountExecuted++
              await writeBatchStatusAuditLog({
                runId: currentRunId,
                accountId: lockedAccountId,
                ownerId: meta.winnerRule._ownerId ?? 0,
                rule: meta.winnerRule,
                matchedAd: meta.matchedAd,
                actionType: actionToPass.type,
                actionPayload: actionToPass,
                status: 'skipped',
                errorMessage: '预算冷却未到期',
                apiRequest: JSON.stringify({ preFlight: true, cooldownKey, reason: 'cooldown_not_reached' }),
                apiResponse: JSON.stringify({ skipped: true, reason: 'cooldown_not_reached' })
              })
              continue
            }
          }

          const newBudgetCents = actionToPass.type === 'set_budget'
            ? computeNewBudgetCentsOnce(currentCents, actionToPass)
            : ((actionToPass._resolvedBudgetCents != null && Number.isInteger(actionToPass._resolvedBudgetCents))
                ? actionToPass._resolvedBudgetCents
                : computeNewBudgetCentsOnce(currentCents, actionToPass))
          if (currentCents === newBudgetCents) {
            // 预算已达目标：跳过执行，但更新冷却时钟（避免每分钟重复 GET 预算）
            // 安全：下次 Cron 走到 L1098 时冷却未到期 → 不会再次重置时钟
            executionResultsByScope[scopeKey] = { success: 0, fail: 0, skipped: 1 }
            accountMatched++
            accountExecuted++
            stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: cooldownKey, lastStatus: 'success' })
            await writeBatchStatusAuditLog({
              runId: currentRunId,
              accountId: lockedAccountId,
              ownerId: meta.winnerRule._ownerId ?? 0,
              rule: meta.winnerRule,
              matchedAd: meta.matchedAd,
              actionType: actionToPass.type,
              actionPayload: { ...actionToPass, _resolvedBudgetCents: newBudgetCents },
              status: 'skipped',
              errorMessage: '目标已达成（budget_already_at_target）',
              apiRequest: JSON.stringify({ preFlight: true, currentCents, newBudgetCents, reason: 'budget_already_at_target' }),
              apiResponse: JSON.stringify({ skipped: true, reason: 'budget_already_at_target' })
            })
            continue
          }

          const budgetField = isDaily ? 'daily_budget' : 'lifetime_budget'
          batchBudgetPlans.push({
            adId,
            rule: meta.winnerRule,
            matchedAd: meta.matchedAd,
            ownerId: meta.winnerRule._ownerId ?? 0,
            actionType: actionToPass.type,
            actionPayload: { ...actionToPass, _resolvedBudgetCents: newBudgetCents },
            cooldownKey,
            request: {
              method: 'POST',
              relative_url: `${nodeId}`,
              body: `${budgetField}=${Math.round(newBudgetCents)}`
            }
          })
          allPendingActions.push({
            kind: 'budget',
            scope,
            accountId: lockedAccountId,
            nodeId: String(nodeId),
            isDaily,
            newBudgetCents: Math.round(newBudgetCents),
            sourceRuleId: meta.winnerRule.id,
            runId: currentRunId,
            rawAction: actionToPass
          })
          continue
        } catch (err) {
          executionResultsByScope[scopeKey] = { success: 0, fail: 1, skipped: 0 }
          accountMatched++
          accountExecuted++
          accountErrors++
          stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: buildStatusCooldownKey(meta.winnerRule, meta.matchedAd), lastStatus: 'fail' })
          await writeBatchStatusAuditLog({
            runId: currentRunId,
            accountId: lockedAccountId,
            ownerId: meta.winnerRule._ownerId ?? 0,
            rule: meta.winnerRule,
            matchedAd: meta.matchedAd,
            actionType: actionToPass.type,
            actionPayload: actionToPass,
            status: 'fail',
            errorMessage: err.message,
            apiRequest: null,
            apiResponse: JSON.stringify({
              error: err.message,
              ...(err?.facebookError?.error ? { fb_error: err.facebookError.error } : {}),
              ...(err?.response?.data?.error ? { fb_error: err.response.data.error } : {})
            })
          })
          continue
        }
      }
      try {
        results = await executeActionsForAd({
          rule: meta.winnerRule,
          matchedAd: meta.matchedAd,
          accountId: lockedAccountId,
          ownerId: meta.winnerRule._ownerId ?? 0,
          runId: currentRunId,
          actionsOverride: [actionToPass]
        })
        for (const r of results) {
          if (r.status === 'success') success++
          else if (r.status === 'fail') fail++
          else skipped++
        }
        // 收集 PendingAction（仅 data，用于预算合并与 Batch 规划，当前不改变执行路径）
        if (Array.isArray(results.pendingActions) && results.pendingActions.length > 0) {
          allPendingActions.push(...results.pendingActions)
        }
        accountMatched++
        accountExecuted++
        accountErrors += fail
      } catch (err) {
        fail = 1
        accountErrors++
        logger.error(`   ❌ [${lockedAccountId}] ad ${adId} 执行失败:`, err.message)
      }
      executionResultsByScope[scopeKey] = { success, fail, skipped }
      if (fromScheduler) {
        // 仅当有实际执行（success 或 fail）时才更新冷却表
        // 全 skipped（如冷却未到期/预算已达目标/Pre-Flight跳过）不更新冷却时钟，避免冷却被无限重置
        if (success > 0 || fail > 0) {
          const statusForCooldown = fail > 0 ? 'fail' : 'success'
          const cooldownKey = (Array.isArray(results) && results[0]?.cooldownKey) ? results[0].cooldownKey : buildStatusCooldownKey(meta.winnerRule, meta.matchedAd, actionToPass)
          stateUpdates.push({ ruleId: meta.winnerRule.id, scopeKey: cooldownKey, lastStatus: statusForCooldown })
        }
      }
    }

    if (batchStatusPlans.length > 0) {
      try {
        const batchApi = new FacebookMarketingAPI(FACEBOOK_ACCESS_TOKEN)
        const requests = batchStatusPlans.map((plan) => ({
          method: 'POST',
          relative_url: `${plan.adId}`,
          body: plan.actionType === 'pause_ad' ? 'status=PAUSED' : 'status=ACTIVE'
        }))
        const batchResults = await batchApi.batchRequests(requests, { priority: 'action', label: 'actions_batch' })
        for (let i = 0; i < batchStatusPlans.length; i++) {
          const plan = batchStatusPlans[i]
          const res = batchResults[i]
          const ok = Number(res?.code || 0) >= 200 && Number(res?.code || 0) < 300 && !res?.body?.error
          if (ok) {
            logFbActionSuccess({
              runId: currentRunId,
              ruleId: plan.rule.id,
              accountId: lockedAccountId,
              objectType: 'ad',
              objectId: String(plan.adId),
              adId: String(plan.adId),
              actionType: plan.actionType,
              httpStatus: Number(res?.code || 0) || 200
            })
          } else {
            logFbActionFailure({
              context: {
                runId: currentRunId,
                ruleId: plan.rule.id,
                accountId: lockedAccountId,
                objectType: 'ad',
                objectId: String(plan.adId),
                adId: String(plan.adId),
                actionType: plan.actionType,
                requestPreview: JSON.stringify(requests[i]),
                responsePreview: JSON.stringify(res?.body || null)
              },
              error: {
                message: res?.body?.error?.message || `Batch code=${res?.code || 0}`,
                response: {
                  status: Number(res?.code || 0) || null,
                  data: res?.body || null
                }
              }
            })
          }
          executionResultsByScope[plan.scopeKey] = { success: ok ? 1 : 0, fail: ok ? 0 : 1, skipped: 0 }
          accountMatched++
          accountExecuted++
          if (!ok) accountErrors++
          stateUpdates.push({ ruleId: plan.rule.id, scopeKey: plan.cooldownKey, lastStatus: ok ? 'success' : 'fail' })
          await writeBatchStatusAuditLog({
            runId: currentRunId,
            accountId: lockedAccountId,
            ownerId: plan.ownerId,
            rule: plan.rule,
            matchedAd: plan.matchedAd,
            actionType: plan.actionType,
            status: ok ? 'success' : 'fail',
            errorMessage: ok ? null : (res?.body?.error?.message || `Batch code=${res?.code || 0}`),
            apiRequest: JSON.stringify(requests[i]),
            apiResponse: JSON.stringify(res?.body || res?.raw || null)
          })
        }
      } catch (err) {
        logger.error(`   ❌ [${lockedAccountId}] Batch 状态动作执行失败:`, err.message)
        logFbActionFailure({
          context: {
            runId: currentRunId,
            ruleId: null,
            accountId: lockedAccountId,
            objectType: 'ad',
            objectId: null,
            adId: null,
            actionType: 'batch_status_action',
            requestPreview: 'batchRequests'
          },
          error: err
        })
        for (const plan of batchStatusPlans) {
          executionResultsByScope[plan.scopeKey] = { success: 0, fail: 1, skipped: 0 }
          accountMatched++
          accountExecuted++
          accountErrors++
          stateUpdates.push({ ruleId: plan.rule.id, scopeKey: plan.cooldownKey, lastStatus: 'fail' })
          await writeBatchStatusAuditLog({
            runId: currentRunId,
            accountId: lockedAccountId,
            ownerId: plan.ownerId,
            rule: plan.rule,
            matchedAd: plan.matchedAd,
            actionType: plan.actionType,
            status: 'fail',
            errorMessage: err.message,
            apiRequest: null,
            apiResponse: JSON.stringify({ error: err.message })
          })
        }
      }
    }

    // 预算 PendingAction 去重合并与覆盖日志（不改变执行路径，仅增强可观测性）
    const { merged: mergedPendingActions, budgetMergeLogs } = mergeBudgetPendingActions(allPendingActions)
    if (budgetMergeLogs.length > 0) {
      for (const logMeta of budgetMergeLogs) {
        logger.info('budget_merge', {
          accountId: logMeta.accountId,
          scope: logMeta.scope,
          nodeId: logMeta.nodeId,
          keptRuleId: logMeta.keptRuleId,
          overwrittenRuleIds: logMeta.overwrittenRuleIds
        })
      }
    }

    await writeSummariesAfterArbitration(currentRunId, matchesPerRule, arbitrated, executionResultsByScope, lockedAccountId, ruleToMuted, ruleToOutsideWindow)

    // 调度路径：写入规则×广告冷却表；不更新 rules.last_executed_at（冷却由冷却表负责）
    if (fromScheduler && stateUpdates.length > 0) {
      await upsertRuleAdExecutionStateBatch(stateUpdates)
    }
    // 非调度路径：评估即冷却，更新规则级 last_executed_at
    if (!fromScheduler) {
      for (const rule of allRulesForAccount) {
        await updateRuleLastExecutedAt(rule.id)
      }
    }

    const noMatchCount = matchesPerRule.filter(m => !m.matchedAds || m.matchedAds.length === 0).length
    accountSkipped += noMatchCount
    logger.info(`   ✅ [${lockedAccountId}] M4 完成: 仲裁 ${arbitrated.size} 个广告, 无匹配规则 ${noMatchCount} 条`)
  })

  return {
    accountId,
    matched: accountMatched,
    executed: accountExecuted,
    skipped: accountSkipped,
    errors: accountErrors
  }
}

/**
 * 单条规则手动执行（复用账户级锁，force 忽略冷却期）
 * 多账户规则：按规则涉及账户逐个加锁执行 evaluateRule(rule, accountId)，再汇总写一条摘要。
 * @param {Object} rule - 规则对象（含 id, accountId, ruleName, userId, conditions, actions, target_by_account 等）
 * @param {Object} options - { force, runId, ownerId }，ownerId 必填（用于审计日志）
 * @returns {Promise<Object>} { rule_id, account_id, matched_count, executed_count, failed_count, status, run_id } 或 null（锁占用）
 */
export async function executeSingleRule(rule, options = {}) {
  const { force = true, runId = generateRunId(), ownerId } = options
  if (ownerId == null) {
    throw new Error('executeSingleRule 需要 options.ownerId')
  }
  runningCount++
  try {
    const ruleEngine = new RuleEngine(null)
    const ruleToEval = { ...rule, enabled: true }
    const accountIds = getRuleAccountIds(rule)
    const ruleStartTime = Date.now()
    const aggregated = {
      matchedCount: 0,
      executedCount: 0,
      failedCount: 0,
      status: 'no_match',
      skipReason: null,
      skipDetails: null,
      errorMessage: null,
      lockSkippedAccounts: []
    }
    const perAccountSummaries = []

    for (const accountId of accountIds) {
      const [amActive] = await pool.execute(
        `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1`,
        [accountId]
      )
      if (amActive.length === 0) {
        perAccountSummaries.push({
          runId,
          ruleId: rule.id,
          ruleName: rule.ruleName,
          accountId,
          userId: rule.userId,
          ownerId,
          matchedCount: 0,
          executedCount: 0,
          failedCount: 0,
          skippedCount: 1,
          status: 'skipped',
          summaryScope: 'account',
          skipReason: 'account_inactive',
          skipDetails: { fb_account_id: accountId, note: 'account_mappings.is_active=0' },
          errorMessage: null,
          durationMs: 0,
          evaluatedAt: new Date()
        })
        continue
      }

      const oneResult = await executeRulesWithLock(accountId, async (lockedAccountId) => {
        const summary = {
          runId,
          ruleId: rule.id,
          ruleName: rule.ruleName,
          accountId: lockedAccountId,
          userId: rule.userId,
          ownerId,
          matchedCount: 0,
          executedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          status: null,
          summaryScope: 'account',
          skipReason: null,
          skipDetails: null,
          errorMessage: null,
          durationMs: 0,
          evaluatedAt: new Date()
        }
        let matchedAds = []
        try {
          // 单条执行与调度执行统一走 Dispatcher：
          // 目标集合来源与口径保持一致（含 use_dynamic_scope=1 时从 rule_matched_objects 读取）
          const loadResult = await loadDataForAccount(lockedAccountId, [ruleToEval], ruleEngine)
          matchedAds = evaluateRuleWithCache(ruleEngine, ruleToEval, loadResult)
        } catch (err) {
          summary.status = 'error'
          summary.skipReason = 'error'
          summary.errorMessage = sanitizeErrorMessage(err.message)
          summary.durationMs = Date.now() - ruleStartTime
          return {
            matched_count: 0,
            executed_count: 0,
            failed_count: 0,
            status: 'error',
            summary
          }
        }
        if (!Array.isArray(matchedAds)) matchedAds = []
        summary.matchedCount = matchedAds.length
        logger.info(`   📋 规则 "${rule.ruleName}" [${lockedAccountId}] 匹配 ${matchedAds.length} 个广告`)
        if (matchedAds.length > 0) {
          const nowBJ = DateTime.utc().setZone(ZONE_BJ)
          const inWindow = isInExecutionWindow(rule, nowBJ)
          if (!inWindow) {
            summary.status = 'skipped'
            summary.skipReason = 'outside_execution_window'
            summary.skipDetails = {
              windows: rule.executionTimeWindows ?? rule.execution_time_windows
            }
            summary.durationMs = Date.now() - ruleStartTime
            return {
              matched_count: summary.matchedCount,
              executed_count: 0,
              failed_count: 0,
              status: summary.status,
              summary
            }
          }
          const candAction = pickSingleCandidateAction(rule.actions)
          const act = candAction?.type
          const isSim = rule.isSimulation ?? rule.is_simulation ?? false
          if ((act === 'pause_ad' || act === 'activate_ad') && !isSim) {
            const adIds = matchedAds.map(m => String(m?.ad_id || '').trim()).filter(Boolean)
            if (adIds.length > 0) {
              logger.info(`   🔄 Pre-Flight 刷新 ${adIds.length} 个广告 status...`)
              const statusMap = await refreshEffectiveStatusForAds([...new Set(adIds)])
              for (const m of matchedAds) {
                const fresh = statusMap.get(String(m.ad_id))
                if (typeof fresh === 'string' && fresh.trim()) m.status = fresh
              }
            }
          }
          try {
            logger.info(`   🚀 开始执行动作 (${(candAction && candAction.type) || 'unknown'})...`)
            const execStats = await executeActionsForRule({
              rule,
              matchedAds,
              accountId: lockedAccountId,
              ownerId,
              runId
            })
            summary.executedCount = execStats.successCount || 0
            summary.failedCount = execStats.failCount || 0
            summary.skippedCount = execStats.skippedCount || 0
            if (execStats.skipReason === 'muted' && execStats.skipDetails) {
              summary.status = 'skipped'
              summary.skipReason = 'muted'
              summary.skipDetails = execStats.skipDetails
            } else {
              const statusResult = deriveSummaryStatus({
                matchedCount: summary.matchedCount,
                executedCount: summary.executedCount,
                failedCount: summary.failedCount,
                skippedCount: summary.skippedCount
              })
              summary.status = summary.failedCount > 0 ? 'error' : statusResult.status
              summary.skipReason = summary.skipReason || (summary.failedCount > 0 ? 'error' : statusResult.skipReason)
            }
          } catch (execErr) {
            summary.status = 'error'
            summary.skipReason = 'error'
            summary.failedCount = matchedAds.length
            summary.errorMessage = sanitizeErrorMessage(execErr.message)
          }
        } else {
          summary.status = 'no_match'
          summary.skipReason = 'no_match'
        }
        summary.durationMs = Date.now() - ruleStartTime
        return {
          matched_count: summary.matchedCount,
          executed_count: summary.executedCount || 0,
          failed_count: summary.failedCount || 0,
          status: summary.status,
          summary
        }
      })

      if (oneResult === undefined) {
        aggregated.lockSkippedAccounts.push(accountId)
        continue
      }
      perAccountSummaries.push(oneResult.summary)
      aggregated.matchedCount += oneResult.matched_count || 0
      aggregated.executedCount += oneResult.executed_count || 0
      aggregated.failedCount += oneResult.failed_count || 0
      if (oneResult.status === 'error') aggregated.errorMessage = (aggregated.errorMessage || '') + `[${accountId}] ${oneResult.summary?.errorMessage || oneResult.status}; `
      if (aggregated.status === 'no_match' && oneResult.status !== 'no_match') aggregated.status = oneResult.status
      else if (oneResult.status === 'error') aggregated.status = 'error'
      else if (oneResult.status === 'matched' || oneResult.status === 'skipped') aggregated.status = oneResult.status
    }
    for (const s of perAccountSummaries) {
      await insertRuleExecutionSummary(s)
    }
    const summary = {
      runId,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      accountId: accountIds.length === 1 ? accountIds[0] : 'multi',
      userId: rule.userId,
      ownerId,
      matchedCount: aggregated.matchedCount,
      executedCount: aggregated.executedCount,
      failedCount: aggregated.failedCount,
      skippedCount: perAccountSummaries.reduce((sum, s) => sum + Number(s?.skippedCount || 0), 0),
      status: aggregated.status,
      summaryScope: 'rollup',
      skipReason: aggregated.skipReason ?? (aggregated.lockSkippedAccounts.length ? 'lock_skipped' : null),
      skipDetails: aggregated.lockSkippedAccounts.length ? { lockSkippedAccounts: aggregated.lockSkippedAccounts } : aggregated.skipDetails,
      errorMessage: aggregated.errorMessage,
      durationMs: Date.now() - ruleStartTime,
      evaluatedAt: new Date()
    }
    await insertRuleExecutionSummary(summary)
    await updateRuleLastExecutedAt(rule.id)
    return {
      rule_id: rule.id,
      account_id: accountIds.length === 1 ? accountIds[0] : undefined,
      matched_count: aggregated.matchedCount,
      executed_count: aggregated.executedCount,
      failed_count: aggregated.failedCount,
      status: aggregated.status,
      run_id: runId
    }
  } finally {
    runningCount = Math.max(0, runningCount - 1)
  }
}

/**
 * 启动定时任务（AdsPolar 流水线架构）
 * - 采用 AdsPolar 模式：数据同步完成后触发规则执行（链式反应）
 * - 每 15 分钟执行一次数据同步，同步完成后立即触发规则执行
 * - 账户级锁 + 超时保险丝，彻底解决僵尸锁问题
 * - 零空转：只有数据更新了，规则才执行
 */
export function startCronJob() {
  const enableTrack2FastSync = process.env.ENABLE_TRACK2_FAST_SYNC === '1' || process.env.ENABLE_TRACK2_FAST_SYNC === 'true'
  const enableUnifiedStructureBatch = process.env.ENABLE_UNIFIED_STRUCTURE_BATCH === '1' || process.env.ENABLE_UNIFIED_STRUCTURE_BATCH === 'true'
  const track2AccountWhitelist = String(process.env.TRACK2_FAST_SYNC_ACCOUNT_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const track2ConcurrencyRaw = Number(process.env.TRACK2_FAST_SYNC_CONCURRENCY ?? 3)
  const track2Concurrency = Number.isFinite(track2ConcurrencyRaw) ? Math.max(1, Math.min(Math.floor(track2ConcurrencyRaw), 10)) : 3
  const track2LimitRaw = Number(process.env.TRACK2_FAST_SYNC_LIMIT ?? 500)
  const track2Limit = Number.isFinite(track2LimitRaw) ? Math.max(1, Math.min(Math.floor(track2LimitRaw), 500)) : 500
  const track2MaxPagesRaw = Number(process.env.TRACK2_FAST_SYNC_MAX_SOFT_PAGES ?? 20)
  const track2MaxSoftPages = Number.isFinite(track2MaxPagesRaw) ? Math.max(1, Math.min(Math.floor(track2MaxPagesRaw), 100)) : 20
  const track2BufferRaw = Number(process.env.TRACK2_FAST_SYNC_BUFFER_SEC ?? 14400)
  const track2BufferSec = Number.isFinite(track2BufferRaw) ? Math.max(0, Math.min(Math.floor(track2BufferRaw), 86400)) : 14400
  const track2UsageSkipRaw = Number(process.env.TRACK2_FAST_SYNC_USAGE_SKIP_THRESHOLD ?? 85)
  const track2UsageSkipThreshold = Number.isFinite(track2UsageSkipRaw)
    ? Math.max(1, Math.min(Math.floor(track2UsageSkipRaw), 99))
    : 85
  const track2MergedUpsert = process.env.TRACK2_FAST_SYNC_MERGED_UPSERT !== '0' && process.env.TRACK2_FAST_SYNC_MERGED_UPSERT !== 'false'

  logger.info('')
  logger.info('='.repeat(50))
  logger.info('⏰ 启动定时任务服务（AdsPolar 流水线架构）')
  logger.info('📅 任务列表:')
  logger.info('  1. 统一心跳: 每 15 分钟 (Cron: */15 * * * *) [仅数据同步 + 归档，规则由「每分钟 Cron」驱动]')
  logger.info('     - 数据同步: 根据账户时区自动选择 Today/last_3d/last_7d/last_14d')
  logger.info('     - 双窗口归档: ≥02:00 ARCHIVED，≥12:00 FINALIZED')
  logger.info('     - 规则执行: 不再由心跳触发，改由「每分钟规则 Cron」统一驱动')
  logger.info('  2. 规则执行: 每分钟 (Cron: * * * * *) [广告级冷却 + 执行时间段，rule_ad_execution_state]')
  logger.info('  3. 账户列表同步: 每小时 (Cron: 0 * * * *) [从 FB 同步账户到 DB]')
  logger.info(`  4. Track2 Fast Sync: 每小时 3 次 (Cron: 7,27,52 * * * *) [flag=${enableTrack2FastSync ? 'on' : 'off'}, 并发=${track2Concurrency}, 白名单=${track2AccountWhitelist.length}, bufferSec=${track2BufferSec}, usageSkip>=${track2UsageSkipThreshold}%, mergedUpsert=${track2MergedUpsert ? 'on' : 'off'}]`)
  logger.info(`  5. Track1 结构轮转（近3天）: 每小时 :12 (Cron: 12 * * * *) [每次 6 账户，账户并发 5，usage 高跳过，unifiedBatch=${enableUnifiedStructureBatch ? 'on' : 'off'}]`)
  logger.info('  6. 热表清理: 每日 04:00 (Cron: 0 4 * * *) [删除 ad_snapshots 超过 2 天的快照]')
  logger.info('  7. 历史表清理: 每日 04:30 (Cron: 30 4 * * *) [rule_matched_objects_history 30 天、structure_ads_history/rule_history 60 天，分批+sleep]')
  logger.info('  8. 定时任务调度: 每分钟 (Cron: * * * * *) [scheduled_tasks 表，独立互斥锁]')
  logger.info('  9. 夜间滑动窗口: 每15分钟 UTC 15-23 (Cron: */15 * * * *) [方案A：覆盖 Asia 凌晨，防新广告盲视]')
  logger.info('')
  logger.info('🔒 锁机制: 账户级锁（rule:account:xxx）+ 5分钟超时保险丝')
  logger.info('⚡ 优势: 零空转、高并发、无僵尸锁')
  logger.info('='.repeat(50))
  logger.info('')

  // 规则执行：每分钟执行（文档：执行频率与执行时间 — 适配方案 §4.1）
  const ruleCronLimit = pLimit(4)
  cron.schedule('* * * * *', async () => {
    if (runningCount > 0) return
    try {
      const [rows] = await pool.execute(
        `SELECT DISTINCT fb_account_id FROM account_mappings WHERE is_active = 1 ORDER BY fb_account_id`
      )
      const accountIds = (rows || []).map(r => r.fb_account_id).filter(Boolean)
      if (accountIds.length === 0) return
      await Promise.all(
        accountIds.map(accountId =>
          ruleCronLimit(() => executeRulesForAccount(accountId, { fromScheduler: true }))
        )
      )
    } catch (err) {
      logger.error('❌ 每分钟规则 Cron 失败:', err.message)
    }
  })

  // 1. 统一心跳：每 15 分钟（仅数据同步 + 归档，不触发规则）
  // 1. 统一心跳：每 15 分钟（仅数据同步 + 归档；规则执行由「每分钟 Cron」驱动）
  cron.schedule('*/15 * * * *', async () => {
    try {
      const syncResult = await unifiedHeartbeatSync()
      if (syncResult && syncResult.syncedAccountIds && syncResult.syncedAccountIds.length > 0) {
        logger.info('')
        logger.info('='.repeat(50))
        logger.info('✅ 数据同步完成（规则由每分钟 Cron 独立驱动）')
        logger.info(`📋 有数据更新的账户: ${syncResult.syncedAccountIds.length} 个`)
        logger.info('='.repeat(50))
        logger.info('')
      } else {
        if (syncResult && syncResult.skipped) {
          logger.info(`⚠️  统一心跳被跳过（原因: ${syncResult.skipReason}）`)
        } else {
          logger.info('⚠️  没有账户有数据更新')
        }
      }
    } catch (error) {
      logger.error('❌ 统一心跳同步失败:', error.message)
    }
  })

  // ==========================================
  // 🆕 方案A：夜间滑动窗口高频同步
  // 覆盖 UTC 15:00-23:00（Asia 时区凌晨 00:00-06:00）
  // 解决凌晨新广告盲视：通过 filterActiveAds + 嗅探修复确保新广告及时被发现
  // 独立于心跳，有自己的 DB 锁（sync:sliding_window），不干扰心跳运行
  // ==========================================
  cron.schedule('*/15 * * * *', async () => {
    const utcHour = new Date().getUTCHours()
    if (utcHour < 15 || utcHour > 23) return

    // 检查 Token 熔断器
    const breakerStatus = getCircuitBreakerStatus()
    if (breakerStatus?.isLocked) {
      logger.info('[夜间滑动窗口] 跳过：Token 熔断中')
      return
    }

    // 检查 API 使用率（避免在配额紧张时火上浇油）
    const usage = getLastUsageRate()
    const nightWindowUsageSkipThreshold = 85  // 比 Track2 的阈值略低，优先保证夜间覆盖
    if (usage != null && Number.isFinite(Number(usage)) && Number(usage) >= nightWindowUsageSkipThreshold) {
      logger.info(`[夜间滑动窗口] 跳过：API 使用率 ${Number(usage)}% >= ${nightWindowUsageSkipThreshold}%`)
      return
    }

    try {
      logger.info('')
      logger.info('='.repeat(50))
      logger.info('🌙 夜间滑动窗口同步（方案A：新广告盲视修复）')
      logger.info(`⏰ UTC 时间: ${new Date().toISOString()}`)
      logger.info('='.repeat(50))

      const result = await syncAllAccountsSlidingWindow(7, true)

      if (result?.success) {
        const todayTotal = result.totalTodayCount ?? 0
        const dailyTotal = result.totalDailyStatsCount ?? 0
        logger.info(`✅ 夜间滑动窗口完成: ${result.successCount ?? 0}/${result.totalAccounts ?? 0} 账户`)
        logger.info(`   - Today 快照: ${todayTotal} 条`)
        logger.info(`   - 按日回补: ${dailyTotal} 条`)
      }
    } catch (error) {
      logger.error('❌ 夜间滑动窗口同步失败:', error.message)
    }
  })

  // 4. Track2 Fast Sync（灰度）：每小时 :07/:27/:52 执行（避开 :45 热数据同步）
  // 默认关闭（ENABLE_TRACK2_FAST_SYNC=false）。可配白名单账户，避免直接全量。
  cron.schedule('7,27,52 * * * *', async () => {
    if (!enableTrack2FastSync) return

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      logger.warn('[Track2 FastSync] 跳过：FACEBOOK_ACCESS_TOKEN 缺失')
      return
    }
    const breakerStatus = getCircuitBreakerStatus()
    if (breakerStatus?.isLocked) {
      logger.info('[Track2 FastSync] 跳过：Token 熔断中')
      return
    }
    const usage = getLastUsageRate()
    if (usage != null && Number.isFinite(Number(usage)) && Number(usage) >= track2UsageSkipThreshold) {
      logger.info(`[Track2 FastSync] 跳过：API 使用率 ${Number(usage)}% >= ${track2UsageSkipThreshold}%`)
      return
    }

    try {
      const [rows] = await pool.execute(
        `SELECT DISTINCT fb_account_id FROM account_mappings WHERE is_active = 1 ORDER BY fb_account_id`
      )
      let accountIds = (rows || []).map(r => String(r.fb_account_id || '').trim()).filter(Boolean)
      if (track2AccountWhitelist.length > 0) {
        const whiteSet = new Set(track2AccountWhitelist)
        accountIds = accountIds.filter(id => whiteSet.has(id))
      }
      if (accountIds.length === 0) {
        logger.info('[Track2 FastSync] 本轮无可执行账户，跳过')
        return
      }

      const api = new FacebookMarketingAPI(token)
      const accountLimit = pLimit(track2Concurrency)
      const nowSec = Math.floor(Date.now() / 1000)
      const threeDaysAgoSec = nowSec - 3 * 24 * 60 * 60

      logger.info(`[Track2 FastSync] 开始：accounts=${accountIds.length}, concurrency=${track2Concurrency}, limit=${track2Limit}, maxSoftPages=${track2MaxSoftPages}`)

      const results = await Promise.all(accountIds.map((accountId) =>
        accountLimit(async () => {
          let sinceSec = threeDaysAgoSec
          let lastFastSyncSec = null
          try {
            const [statusRows] = await pool.execute(
              `SELECT COALESCE(UNIX_TIMESTAMP(last_fast_sync_ts), UNIX_TIMESTAMP(last_success_at)) AS last_fast_sync_sec
               FROM structure_sync_status
               WHERE account_id = ?`,
              [accountId]
            )
            const lastFastSyncSecRaw = statusRows[0]?.last_fast_sync_sec
            lastFastSyncSec = lastFastSyncSecRaw != null && Number.isFinite(Number(lastFastSyncSecRaw))
              ? Number(lastFastSyncSecRaw)
              : null
            if (lastFastSyncSec != null) {
              sinceSec = Math.max(lastFastSyncSec - track2BufferSec, threeDaysAgoSec)
            }
          } catch (err) {
            logger.warn(`[Track2 FastSync] account=${accountId} 读取上次同步时间失败，回退3天窗口: ${err.message}`)
          }

          logger.info(
            `[Track2 FastSync] account=${accountId} nowSec=${nowSec} threeDaysAgoSec=${threeDaysAgoSec} `
            + `lastFastSyncSec=${lastFastSyncSec ?? 'null'} bufferSec=${track2BufferSec} sinceSec=${sinceSec}`
          )

          try {
            if (track2MergedUpsert) {
              const collected = await collectFastSyncDataForAccount(accountId, api, {
                sinceSec,
                limit: track2Limit,
                maxSoftPagesPerEdge: track2MaxSoftPages
              })
              if (!collected?.ok) {
                return { accountId, ok: false, reason: collected?.reason || 'collect_failed', synced_ads: 0, collected: null }
              }
              return {
                accountId,
                ok: true,
                reason: null,
                synced_ads: Array.isArray(collected.ads) ? collected.ads.length : 0,
                collected
              }
            }

            const result = await fastSyncStructureForAccount(accountId, api, {
              sinceSec,
              limit: track2Limit,
              maxSoftPagesPerEdge: track2MaxSoftPages
            })
            return { accountId, ok: !!result?.ok, reason: result?.reason || null, synced_ads: result?.synced_ads || 0, collected: null }
          } catch (err) {
            logger.warn(`[Track2 FastSync] account=${accountId} 执行失败: ${err.message}`)
            return { accountId, ok: false, reason: 'error', synced_ads: 0, collected: null }
          }
        })
      ))

      if (track2MergedUpsert) {
        const collectedPayloads = results.map(r => r.collected).filter(Boolean)
        if (collectedPayloads.length > 0) {
          const mergedResult = await applyMergedFastSyncPayload(collectedPayloads, { markDirtyOnChange: true, chunkSize: 300 })
          logger.info(
            `[Track2 FastSync] mergedUpsert 完成：accounts=${mergedResult.accounts}, campaigns=${mergedResult.campaigns}, adsets=${mergedResult.adsets}, ads=${mergedResult.ads}, dirtyMarked=${mergedResult.dirtyMarked}`
          )
        }
      }

      const successCount = results.filter(r => r.ok).length
      const lockBusyCount = results.filter(r => r.reason === 'lock_busy').length
      const adsTouched = results.reduce((sum, r) => sum + (Number(r.synced_ads) || 0), 0)
      logger.info(`[Track2 FastSync] 完成：success=${successCount}/${results.length}, lock_busy=${lockBusyCount}, synced_ads=${adsTouched}`)
    } catch (err) {
      logger.error('[Track2 FastSync] 任务失败:', err.message)
    }
  })

  // 6. 每小时同步一次账户列表
  cron.schedule('0 * * * *', async () => {
    logger.info('')
    logger.info('='.repeat(50))
    logger.info('🔄 开始定时同步账户列表（FB → DB）')
    logger.info('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    logger.info('='.repeat(50))
    try {
      const result = await syncAccountsFromFacebook()
      if (result.success) {
        logger.info(`✅ 账户列表同步完成，共 ${result.totalAccounts} 个账户`)
        logger.info(`   新增: ${result.newAccounts}，更新: ${result.updatedAccounts}`)
      } else {
        logger.error('❌ 账户列表同步失败:', result.error)
      }
    } catch (error) {
      logger.error('❌ 账户列表同步失败:', error.message)
    }
    logger.info('='.repeat(50))
    logger.info('')
  })

  // 8. 每日 04:00 热表清理（TASKS §1.7：删除 ad_snapshots 超过 2 天的快照）
  cron.schedule('0 4 * * *', async () => {
    try {
      const result = await cleanupAdSnapshots()
      if (result.deleted > 0) {
        logger.info(`[热表清理] 完成，删除 ${result.deleted} 条`)
      }
    } catch (err) {
      logger.warn('[热表清理] 失败:', err.message)
    }
  })

  // 9. 每日 04:30 历史表清理（方案 §6：rule_matched_objects_history 30 天、structure_ads_history / rule_history 60 天，分批 DELETE + 批间 sleep）
  const enableHistoryCleanup = process.env.ENABLE_HISTORY_CLEANUP !== '0' && process.env.ENABLE_HISTORY_CLEANUP !== 'false'
  const retentionDaysMatched = Number(process.env.HISTORY_RETENTION_DAYS_MATCHED) || 30
  const retentionDaysAds = Number(process.env.HISTORY_RETENTION_DAYS_ADS) || 60
  const retentionDaysRule = Number(process.env.HISTORY_RETENTION_DAYS_RULE) || 60
  cron.schedule('30 4 * * *', async () => {
    if (!enableHistoryCleanup) return
    try {
      const result = await runNightlyHistoryCleanup({
        retentionDaysMatched,
        retentionDaysAds,
        retentionDaysRule
      })
      if (result.totalDeleted > 0) {
        logger.info(`[历史表清理] 完成，rule_matched_objects_history=${result.matchedDeleted}, structure_ads_history=${result.adsDeleted}, rule_history=${result.ruleDeleted}, scheduled_tasks=${result.scheduledCleaned ?? 0}`)
      }
    } catch (err) {
      logger.warn('[历史表清理] 失败:', err.message)
    }
  })

  // 7. Track1 结构轮转（近3天）：每小时 :12 执行，每次最多 6 个账户（P1，让路 P0；usage 高/熔断时跳过；账户并发 5）
  // 通过环境变量 PAUSE_STRUCTURE_SYNC=1 可暂停，便于补数/限流恢复后再开启
  cron.schedule('12 * * * *', async () => {
    if (process.env.PAUSE_STRUCTURE_SYNC === '1' || process.env.PAUSE_STRUCTURE_SYNC === 'true') {
      logger.info('[结构轮转] 已暂停（PAUSE_STRUCTURE_SYNC=1），跳过')
      return
    }
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) return
    try {
      const api = new FacebookMarketingAPI(token)
      const result = await runHourlyStructureFullRotation(api, {
        maxAccounts: 6,
        accountConcurrency: 5,
        useUnifiedBatch: enableUnifiedStructureBatch,
        unifiedLimit: track2Limit,
        unifiedMaxSoftPages: track2MaxSoftPages
      })
      if (result.skipped) {
        logger.info(`[结构轮转] 本轮跳过: ${result.reason}`)
      } else if (result.synced > 0) {
        logger.info(`[结构轮转] 本轮完成: ${result.synced} 个账户`)
        // 结构同步完成后执行完整性自愈，确保 structure_ads → structure_campaigns/adsets 关系链闭合
        try {
          const healResult = await healStructureIntegrity()
          if (healResult.campaignsHealed > 0 || healResult.adsetsHealed > 0) {
            logger.info(`[结构自愈] 修复: campaigns=${healResult.campaignsHealed}, adsets=${healResult.adsetsHealed}`)
          }
          if (healResult.errors.length > 0) {
            logger.warn(`[结构自愈] 异常: ${healResult.errors.join('; ')}`)
          }
        } catch (healErr) {
          logger.warn('[结构自愈] 自愈过程异常:', healErr.message)
        }
      }
    } catch (err) {
      logger.warn('[结构轮转] 失败:', err.message)
    }
  })

  // [临时禁用] 8. 定时任务调度 — scheduledTaskService.js 有语法错误待修复
  // cron.schedule('* * * * *', async () => {
  //   if (isScheduledTaskRunning()) {
  //     return
  //   }
  //   try {
  //     const result = await executeDueScheduledTasks()
  //     if (result.skippedDueToLock) return
  //     if (result.executed > 0 || result.errors > 0) {
  //       logger.info(
  //         `[ScheduledTask Cron] 本次处理 ${result.executed + result.skipped + result.errors} 条，` +
  //         `执行 ${result.executed}，跳过 ${result.skipped}，失败 ${result.errors}`
  //       )
  //     }
  //   } catch (err) {
  //     logger.error('[ScheduledTask Cron] 异常:', err.message)
  //   }
  // })

  logger.info('✅ 定时任务已启动（定时任务模块临时禁用）')
}

/**
 * 停止定时任务（如果需要）
 * 注意：AdsPolar 模式使用账户级锁，不需要释放全局锁
 */
export async function stopCronJob() {
  // AdsPolar 模式：使用账户级锁，不需要释放全局锁
  // 账户级锁会在连接断开时自动释放（超时保险丝机制）
  logger.info('⏸️  定时任务已停止')
}

/**
 * 已移除：规则改由「每分钟 Cron」统一驱动，不再提供「立即运行所有规则」入口（文档：执行频率与执行时间 — 适配方案 §7）
 */
export async function manualExecute(_force = true, _options = {}) {
  logger.info('⚠️  manualExecute 已废弃（规则由每分钟 Cron 驱动），忽略调用')
}

export async function executeAllRules(_options = {}) {
  logger.info('⚠️  executeAllRules 已废弃（规则由每分钟 Cron 驱动），忽略调用')
}

export function getCronStatus() {
  return {
    isRunning: runningCount > 0,
    lastExecutionTime,
    lastExecutionResult
  }
}

/**
 * 手动触发数据同步任务（用于测试）
 */
export async function manualSyncToday() {
  logger.info('🔧 手动触发 Today 数据同步')
  try {
    const result = await syncAllAccountsTodayStats()
    logger.info(`✅ 手动同步完成，共 ${result.totalAccounts} 个账户，同步 ${result.totalSyncedCount} 条记录`)
    return result
  } catch (error) {
    logger.error('❌ 手动同步失败:', error.message)
    throw error
  }
}

/**
 * 手动触发冷数据落盘（用于测试）
 * 注意：使用强制模式（forceAll=true），绕过时区窗口和跳过检查，确保立即补齐缺失数据
 */
export async function manualArchive() {
  logger.info('🔧 手动触发冷数据落盘（强制模式）')
  try {
    // 使用 forceAll=true 强制归档，绕过时区窗口和跳过检查
    // 这样可以确保即使已有部分记录，也会执行完整性检查并补齐缺失
    const result = await archiveAllAccountsDailyStats(null, true)
    logger.info(`✅ 手动落盘完成，共 ${result.totalAccounts} 个账户，归档 ${result.totalArchivedCount} 条记录`)
    return result
  } catch (error) {
    logger.error('❌ 手动落盘失败:', error.message)
    throw error
  }
}

/**
 * 手动触发热表清理（删除 ad_snapshots 超过 2 天的快照，TASKS §1.7）
 */
export async function manualCleanupAdSnapshots() {
  logger.info('🔧 手动触发热表清理（ad_snapshots）')
  try {
    const result = await cleanupAdSnapshots()
    logger.info(`✅ 热表清理完成，删除 ${result.deleted} 条`)
    return result
  } catch (error) {
    logger.error('❌ 热表清理失败:', error.message)
    throw error
  }
}

const HISTORY_CLEANUP_BATCH_SIZE = 10000
const HISTORY_CLEANUP_SLEEP_MS = 500

/**
 * 历史表分批清理（方案 §6：rule_matched_objects_history / structure_ads_history / rule_history）
 * 每批 DELETE LIMIT 10000，批间 sleep 500ms，避免占满磁盘 IO 影响凌晨同步。
 * @param {{ retentionDaysMatched?: number, retentionDaysAds?: number, retentionDaysRule?: number }}
 * @returns {{ matchedDeleted: number, adsDeleted: number, ruleDeleted: number, totalDeleted: number }}
 */
export async function runNightlyHistoryCleanup(opts = {}) {
  const retentionMatched = Number(opts.retentionDaysMatched) || 30
  const retentionAds = Number(opts.retentionDaysAds) || 60
  const retentionRule = Number(opts.retentionDaysRule) || 60
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  let matchedDeleted = 0
  let adsDeleted = 0
  let ruleDeleted = 0

  // rule_matched_objects_history: refreshed_at
  while (true) {
    const [res] = await pool.execute(
      `DELETE FROM rule_matched_objects_history WHERE refreshed_at < NOW() - INTERVAL ? DAY LIMIT ${HISTORY_CLEANUP_BATCH_SIZE}`,
      [retentionMatched]
    )
    const n = res?.affectedRows ?? 0
    matchedDeleted += n
    if (n < HISTORY_CLEANUP_BATCH_SIZE) break
    await sleep(HISTORY_CLEANUP_SLEEP_MS)
  }

  // structure_ads_history: changed_at
  while (true) {
    const [res] = await pool.execute(
      `DELETE FROM structure_ads_history WHERE changed_at < NOW() - INTERVAL ? DAY LIMIT ${HISTORY_CLEANUP_BATCH_SIZE}`,
      [retentionAds]
    )
    const n = res?.affectedRows ?? 0
    adsDeleted += n
    if (n < HISTORY_CLEANUP_BATCH_SIZE) break
    await sleep(HISTORY_CLEANUP_SLEEP_MS)
  }

  // rule_history: changed_at
  while (true) {
    const [res] = await pool.execute(
      `DELETE FROM rule_history WHERE changed_at < NOW() - INTERVAL ? DAY LIMIT ${HISTORY_CLEANUP_BATCH_SIZE}`,
      [retentionRule]
    )
    const n = res?.affectedRows ?? 0
    ruleDeleted += n
    if (n < HISTORY_CLEANUP_BATCH_SIZE) break
    await sleep(HISTORY_CLEANUP_SLEEP_MS)
  }

  // scheduled_tasks: 清理 90 天前已禁用的 once 类型任务（方案 R2#7）
  let scheduledCleaned = 0
  while (true) {
    const [res] = await pool.execute(
      `DELETE FROM scheduled_tasks WHERE enabled = 0 AND schedule_type = 'once' AND updated_at < NOW() - INTERVAL 90 DAY LIMIT ${HISTORY_CLEANUP_BATCH_SIZE}`
    )
    const n = res?.affectedRows ?? 0
    scheduledCleaned += n
    if (n < HISTORY_CLEANUP_BATCH_SIZE) break
    await sleep(HISTORY_CLEANUP_SLEEP_MS)
  }

  return {
    matchedDeleted,
    adsDeleted,
    ruleDeleted,
    scheduledCleaned,
    totalDeleted: matchedDeleted + adsDeleted + ruleDeleted + scheduledCleaned
  }
}

/**
 * 手动触发账户列表同步（从 FB API 同步到 DB）
 */
export async function manualSyncAccounts() {
  logger.info('🔧 手动触发账户列表同步（FB → DB）')
  try {
    const result = await syncAccountsFromFacebook()
    if (result.success) {
      logger.info(`✅ 账户同步完成，共 ${result.totalAccounts} 个账户`)
      logger.info(`   新增: ${result.newAccounts}，更新: ${result.updatedAccounts}`)
    } else {
      logger.error('❌ 账户同步失败:', result.error)
    }
    return result
  } catch (error) {
    logger.error('❌ 账户同步失败:', error.message)
    throw error
  }
}

/**
 * 手动触发统一心跳同步（用于测试）
 * 包含：数据同步 + 双窗口归档 + 规则执行（AdsPolar 流水线）
 */
export async function manualUnifiedHeartbeat() {
  logger.info('🔧 手动触发统一心跳同步（数据同步 + 双窗口归档 + 规则执行）')
  try {
    // 执行数据同步
    const result = await unifiedHeartbeatSync()
    logger.info(`✅ 统一心跳同步完成`)
    logger.info(`   账户总数: ${result.totalAccounts}`)
    logger.info(`   同步账户: ${result.syncedAccounts}`)
    logger.info(`   归档账户: ${result.archivedAccounts}`)
    logger.info(`   对账账户: ${result.finalizedAccounts}`)
    logger.info(`   耗时: ${result.durationMs}ms`)
    
    // AdsPolar 事件驱动优化：规则执行已在数据同步时触发（顺手触发模式）
    // 这里不再需要批量触发，因为每个账户同步完成后已经立即触发了规则执行
    if (result && result.syncedAccountIds && result.syncedAccountIds.length > 0) {
      logger.info('')
      logger.info('='.repeat(50))
      logger.info('✅ 数据同步完成（规则执行已在同步时触发，AdsPolar 事件驱动模式）')
      logger.info(`📋 有数据更新的账户: ${result.syncedAccountIds.length} 个`)
      logger.info('='.repeat(50))
      logger.info('')
      
      // 注意：规则执行已在数据同步时通过事件驱动模式触发
      // 这里不再批量执行，避免重复执行和资源浪费
    } else {
      if (result && result.skipped) {
        logger.info(`⚠️  统一心跳被跳过（原因: ${result.skipReason}），跳过规则执行`)
      } else {
        logger.info('⚠️  没有账户有数据更新，跳过规则执行（零空转）')
      }
    }
    
    return result
  } catch (error) {
    logger.error('❌ 统一心跳同步失败:', error.message)
    throw error
  }
}