// 定时任务服务 - AdsPolar 流水线架构
// 采用 AdsPolar 模式：数据同步完成后触发规则执行（链式反应）
// 账户级锁 + 超时保险丝，彻底解决僵尸锁问题
import cron from 'node-cron'
import logger from '../utils/logger.js'
import { db } from '../db/drizzle.js'
import { rules } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import pool from '../db/connection.js'
import { RuleEngine, FacebookMarketingAPI } from '../index.js'
import { 
  syncAllAccountsTodayStats,
  syncAllAccountsSlidingWindow,
  archiveAllAccountsDailyStats,
  unifiedHeartbeatSync,
  cleanupAdSnapshots
} from './ingestorService.js'
import { executeActionsForRule, executeActionsForAd, resolveNewBudgetCentsForAction } from './actionExecutorService.js'
import { pickSingleCandidateAction, getActionPriority } from '../utils/actionPriority.js'
import { loadDataForAccount, evaluateRuleWithCache } from './ruleEngineDispatcher.js'

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
import { syncAccountsFromFacebook } from './accountSyncService.js'
import { runHourlyStructureFullRotation } from './structureSyncService.js'
import { 
  insertRuleExecutionSummary, 
  sanitizeErrorMessage, 
  generateRunId 
} from './ruleExecutionSummaryService.js'

// ============================================
// AdsPolar 账户级锁机制（带超时保险丝）
// ============================================
// 锁超时时间：5分钟（如果规则执行超过5分钟，强制断开连接释放锁）
const RULE_LOCK_TIMEOUT_MS = 5 * 60 * 1000

// 执行状态跟踪（用于手动触发和状态查询）
let lastExecutionTime = null
let lastExecutionResult = null
/** 全局：正在执行的规则任务数（executeAllRules 与 executeSingleRule 共用），用于 409/ALREADY_RUNNING 与 UI；对外仍用 isRunning = runningCount > 0 */
let runningCount = 0

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
function arbitrateByAdId(matchesPerRule) {
  // 压成「每 (rule, ad) 一个候选动作」
  const byAdId = new Map() // ad_id -> Array<{ rule, matchedAd, candidateAction }>
  for (const { rule, matchedAds } of matchesPerRule) {
    const candidateAction = pickSingleCandidateAction(rule.actions)
    if (!candidateAction) continue
    const priority = getActionPriority(candidateAction.type)
    for (const matchedAd of matchedAds) {
      const adId = String(matchedAd.ad_id)
      if (!byAdId.has(adId)) byAdId.set(adId, [])
      byAdId.get(adId).push({ rule, matchedAd, candidateAction, priority })
    }
  }
  // 每个 ad 选赢家：优先级数字小优先，同优先级 ruleId 小者赢
  const result = new Map()
  for (const [adId, candidates] of byAdId) {
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return (a.rule.id || 0) - (b.rule.id || 0)
    })
    const winner = candidates[0]
    const suppressedRules = candidates.slice(1).map(c => c.rule)
    result.set(adId, {
      winnerRule: winner.rule,
      winnerAction: winner.candidateAction,
      matchedAd: winner.matchedAd,
      suppressedRules
    })
  }
  return result
}

/**
 * 仲裁后按规则写摘要：同一规则可既有 executed_count/failed_count 又有 skip_details.suppressed_for_ads
 *
 * @param {string} runId
 * @param {Array<{ rule: Object, matchedAds: Array }>} matchesPerRule
 * @param {Map<string, { winnerRule, winnerAction, matchedAd, suppressedRules }>} arbitrated
 * @param {Object} executionResultsByAd - ad_id -> { success, fail }
 * @param {string} accountId
 */
async function writeSummariesAfterArbitration(runId, matchesPerRule, arbitrated, executionResultsByAd, accountId, ruleToMuted = new Map()) {
  const ruleToExecuted = new Map()   // ruleId -> { executed, failed }
  const ruleToSuppressed = new Map() // ruleId -> Array<{ ad_id, winner_rule_id }>
  for (const [adId, meta] of arbitrated) {
    const rid = meta.winnerRule.id
    if (!ruleToExecuted.has(rid)) ruleToExecuted.set(rid, { executed: 0, failed: 0 })
    const res = executionResultsByAd[adId] || {}
    ruleToExecuted.get(rid).executed += res.success || 0
    ruleToExecuted.get(rid).failed += res.fail || 0
    for (const r of meta.suppressedRules) {
      const ruleId = r.id
      if (!ruleToSuppressed.has(ruleId)) ruleToSuppressed.set(ruleId, [])
      ruleToSuppressed.get(ruleId).push({ ad_id: adId, winner_rule_id: meta.winnerRule.id })
    }
  }
  for (const { rule, matchedAds } of matchesPerRule) {
    const exec = ruleToExecuted.get(rule.id) || { executed: 0, failed: 0 }
    const supp = ruleToSuppressed.get(rule.id) || []
    const muted = ruleToMuted.get(rule.id) || []
    const totalMatched = matchedAds.length
    const status = supp.length > 0 && (exec.executed + exec.failed) === 0 && muted.length === 0 ? 'skipped' : (exec.executed + exec.failed > 0 ? 'matched' : muted.length > 0 ? 'skipped' : 'no_match')
    const skipReason = muted.length > 0 ? 'muted' : (supp.length > 0 ? 'suppressed_by_priority' : (totalMatched === 0 ? 'no_match' : null))
    const skipDetails = muted.length > 0 ? { mute_until: muted[0]?.mute_until, mute_reason: muted[0]?.mute_reason, ad_ids: muted.map(m => m.ad_id) } : (supp.length > 0 ? { suppressed_for_ads: supp } : null)
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
      skippedCount: 0,
      status,
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
 * - target_by_account[accountId] 为非空数组时返回 true；空数组视为该账户无目标，返回 false，避免无谓评估
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
 * @param {boolean} options.force - 是否强制执行（忽略冷却期）
 * @returns {Promise<Object>} 执行统计
 * 
 * 注意：此函数已导出，供事件驱动模式使用（数据同步完成后立即触发规则）
 */
export async function executeRulesForAccount(accountId, options = {}) {
  const { force = false, runId = null } = options
  
  // ✅ 如果没有传入 runId（事件触发场景），生成新的
  const currentRunId = runId || generateRunId()
  
  // 统计信息
  let accountMatched = 0
  let accountExecuted = 0
  let accountSkipped = 0
  let accountErrors = 0

  // 使用账户级锁执行规则
  await executeRulesWithLock(accountId, async (lockedAccountId) => {
    // 1. 从数据库获取所有启用的规则
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
    
    // 2. 过滤出满足冷却期条件的规则（强制模式下跳过冷却期检查）
    const cooledDownRules = force 
      ? enabledRules 
      : enabledRules.filter(isRuleCooledDown)
    
    // 调试日志：显示规则数量
    if (enabledRules.length === 0) {
      logger.info(`   ⚠️  [${lockedAccountId}] 数据库中没有启用的规则，跳过执行`)
      return
    }
    
    if (cooledDownRules.length === 0) {
      // 调试日志：显示冷却期过滤详情
      const neverExecuted = enabledRules.filter(r => !r.lastExecutedAt).length
      const inCooldown = enabledRules.length - neverExecuted
      logger.info(`   ⏸️  [${lockedAccountId}] 所有规则都在冷却期内，跳过执行（总规则: ${enabledRules.length}, 冷却中: ${inCooldown}, 从未执行: ${neverExecuted}）`)
      return // 没有到期的规则，静默退出
    }
    
    // 调试日志：显示冷却期过滤结果
    if (enabledRules.length > cooledDownRules.length) {
      const skippedCount = enabledRules.length - cooledDownRules.length
      logger.info(`   📊 [${lockedAccountId}] 冷却期过滤: ${enabledRules.length} 条规则 → ${cooledDownRules.length} 条可执行（跳过 ${skippedCount} 条）`)
    }

    // 调试日志：显示可执行规则数量
    if (cooledDownRules.length > 0) {
      logger.info(`   📋 [${lockedAccountId}] 找到 ${cooledDownRules.length} 条可执行规则`)
    }

    // M4：只处理「作用于本账户」的规则（单账户 rule.account_id 或 多账户 target_account_ids / target_by_account）
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
            skipReason: 'user_not_found',
            skipDetails: { user_id: parseInt(userId) },
            evaluatedAt: new Date()
          })
        }
        continue
      }
      const user = userRows[0]
      let hasAccess = false
      if (user.role === 'admin') {
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
    const matchesPerRule = await collectAllMatchesForAccount(ruleEngine, allRulesForAccount, lockedAccountId)
    const arbitrated = arbitrateByAdId(matchesPerRule)

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
      for (const [adId, meta] of arbitrated) {
        const fresh = statusMap.get(String(adId))
        if (typeof fresh === 'string' && fresh.trim()) meta.matchedAd.status = fresh
      }
    }

    const executionResultsByAd = {}
    const ruleToMuted = new Map()  // M4 Smart Mute: ruleId -> [{ ad_id, mute_until, mute_reason }]
    let budgetApi = null  // M4 3.2 预算幂等：按需创建，预计算 newBudgetCents 时只 GET 一次
    for (const [adId, meta] of arbitrated) {
      const mu = meta.matchedAd?.mute_until
      if (mu != null && new Date() < new Date(mu)) {
        logger.info(`   🔇 [${lockedAccountId}] 广告 ${adId} 处于 mute 期 (until ${mu})，跳过`)
        const list = ruleToMuted.get(meta.winnerRule.id) || []
        list.push({ ad_id: adId, mute_until: mu, mute_reason: meta.matchedAd?.mute_reason || null })
        ruleToMuted.set(meta.winnerRule.id, list)
        executionResultsByAd[adId] = { success: 0, fail: 0 }
        continue
      }
      // M4 3.2 预算幂等：预算类动作在调用方预计算一次 newBudgetCents，传 action 副本 _resolvedBudgetCents，重试时执行层不再 GET
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
      try {
        const results = await executeActionsForAd({
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
        }
        accountMatched++
        accountExecuted++
        accountErrors += fail
      } catch (err) {
        fail = 1
        accountErrors++
        logger.error(`   ❌ [${lockedAccountId}] ad ${adId} 执行失败:`, err.message)
      }
      executionResultsByAd[adId] = { success, fail }
    }

    await writeSummariesAfterArbitration(currentRunId, matchesPerRule, arbitrated, executionResultsByAd, lockedAccountId, ruleToMuted)

    // 评估即冷却：本轮被评估的规则都更新 last_executed_at
    for (const rule of allRulesForAccount) {
      await updateRuleLastExecutedAt(rule.id)
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

    for (const accountId of accountIds) {
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
          skipReason: null,
          skipDetails: null,
          errorMessage: null,
          durationMs: 0,
          evaluatedAt: new Date()
        }
        let matchedAds = []
        try {
          matchedAds = await ruleEngine.evaluateRule(ruleToEval, lockedAccountId)
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
            if (execStats.skipReason === 'muted' && execStats.skipDetails) {
              summary.status = 'skipped'
              summary.skipReason = 'muted'
              summary.skipDetails = execStats.skipDetails
            } else {
              summary.status = (execStats.failCount || 0) > 0 ? 'error' : 'matched'
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
      aggregated.matchedCount += oneResult.matched_count || 0
      aggregated.executedCount += oneResult.executed_count || 0
      aggregated.failedCount += oneResult.failed_count || 0
      if (oneResult.status === 'error') aggregated.errorMessage = (aggregated.errorMessage || '') + `[${accountId}] ${oneResult.summary?.errorMessage || oneResult.status}; `
      if (aggregated.status === 'no_match' && oneResult.status !== 'no_match') aggregated.status = oneResult.status
      else if (oneResult.status === 'error') aggregated.status = 'error'
      else if (oneResult.status === 'matched' || oneResult.status === 'skipped') aggregated.status = oneResult.status
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
      skippedCount: 0,
      status: aggregated.status,
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
 * 执行所有账户的规则（用于手动触发或批量执行）
 * AdsPolar 模式：账户级并发，每个账户独立锁
 * 
 * @param {Object} options - 执行选项
 * @param {boolean} options.force - 是否强制执行（忽略冷却期）
 * @param {Array<string>} options.accountIds - 指定账户ID列表（可选，不指定则执行所有账户）
 * @param {number} options.ownerId - 负责人ID（可选）；传入时只执行该负责人下的账户（用于非 admin 用户「立即运行所有规则」）
 */
export async function executeAllRules(options = {}) {
  const { force = false, accountIds = null, ownerId = null } = options

  if (runningCount > 0) {
    logger.info('⚠️  规则正在执行中，跳过本次 executeAllRules（由路由返回 409）')
    return
  }

  runningCount++
  const runId = generateRunId()
  logger.info(`🆔 本次规则执行 run_id: ${runId}`)
  const startTime = Date.now()

  try {
    // 1. 获取目标账户列表
    let targetAccountIds = accountIds
    if (!targetAccountIds) {
      // 优化：先查询所有启用的规则，分析哪些账户需要执行
      const enabledRules = await db
        .select()
        .from(rules)
        .where(eq(rules.enabled, true))
      
      // 获取所有规则指定的账户ID（去重）
      const ruleAccountIds = [...new Set(
        enabledRules
          .map(rule => rule.accountId)
          .filter(id => id != null)
      )]
      
      if (ruleAccountIds.length > 0) {
        // 如果规则指定了账户，只在这些账户上执行（性能优化）
        const placeholders = ruleAccountIds.map(() => '?').join(',')
        const [rows] = await pool.execute(
          `SELECT DISTINCT fb_account_id FROM account_mappings 
           WHERE is_active = 1 AND fb_account_id IN (${placeholders})`,
          ruleAccountIds
        )
        targetAccountIds = rows.map(row => row.fb_account_id)
        logger.info(`📊 规则分析: ${enabledRules.length} 条规则，${ruleAccountIds.length} 个指定账户，${targetAccountIds.length} 个活跃账户需要执行`)
      } else {
        // 如果规则没有指定账户，在所有账户上执行
        const [rows] = await pool.execute(
          `SELECT DISTINCT fb_account_id FROM account_mappings WHERE is_active = 1`
        )
        targetAccountIds = rows.map(row => row.fb_account_id)
        logger.info(`📊 规则分析: ${enabledRules.length} 条规则，未指定账户，在所有 ${targetAccountIds.length} 个账户上执行`)
      }
    }

    if (targetAccountIds.length === 0) {
      logger.info('⚠️  没有找到活跃账户，跳过规则执行')
      return
    }

    // 方案B：非 admin 只跑自己负责人下的账户
    if (ownerId != null) {
      const placeholders = targetAccountIds.map(() => '?').join(',')
      const [rows] = await pool.execute(
        `SELECT fb_account_id FROM account_mappings 
         WHERE is_active = 1 AND owner_id = ? AND fb_account_id IN (${placeholders})`,
        [ownerId, ...targetAccountIds]
      )
      targetAccountIds = rows.map(row => row.fb_account_id)
      logger.info(`📋 按负责人过滤: owner_id=${ownerId}，执行 ${targetAccountIds.length} 个账户`)
    }

    if (targetAccountIds.length === 0) {
      logger.info('⚠️  该负责人下没有活跃账户，跳过规则执行')
      return
    }

    logger.info('')
    logger.info('='.repeat(50))
    logger.info(`🔄 开始执行${force ? '【强制】' : '定时'}规则任务（AdsPolar 账户级锁模式）`)
    logger.info('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    logger.info('📊 数据源: 数据库（ad_snapshots + daily_stats）')
    logger.info(`📋 目标账户: ${targetAccountIds.length} 个`)
    logger.info('='.repeat(50))

    // 2. 并发执行所有账户的规则（账户级锁保证不会冲突）
    const results = await Promise.allSettled(
      targetAccountIds.map(accountId => executeRulesForAccount(accountId, { force, runId }))
    )

    // 3. 统计结果
    let totalMatched = 0
    let totalExecuted = 0
    let totalSkipped = 0
    let totalErrors = 0

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const stats = result.value
        totalMatched += stats.matched
        totalExecuted += stats.executed
        totalSkipped += stats.skipped
        totalErrors += stats.errors
      } else {
        logger.error(`❌ 账户 ${targetAccountIds[index]} 规则执行失败:`, result.reason?.message)
        totalErrors++
      }
    })

    const duration = Date.now() - startTime
    logger.info('')
    logger.info('='.repeat(50))
    logger.info(`✅ 规则执行完成（AdsPolar 账户级锁模式）`)
    logger.info(`📊 统计:`)
    logger.info(`   - 匹配广告: ${totalMatched} 个`)
    logger.info(`   - 执行规则: ${totalExecuted} 条（有匹配广告）`)
    logger.info(`   - 跳过规则: ${totalSkipped} 条（无匹配广告）`)
    logger.info(`   - 错误: ${totalErrors} 次`)
    logger.info(`⏱️  耗时: ${duration}ms`)
    logger.info('='.repeat(50))
    logger.info('')

    lastExecutionTime = new Date()
    lastExecutionResult = { 
      totalMatched, 
      totalExecuted, 
      totalSkipped, 
      totalErrors, 
      durationMs: duration 
    }
  } catch (error) {
    logger.error('❌ 规则执行失败:', error)
    logger.error('❌ 错误堆栈:', error.stack)
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
  logger.info('')
  logger.info('='.repeat(50))
  logger.info('⏰ 启动定时任务服务（AdsPolar 流水线架构）')
  logger.info('📅 任务列表:')
  logger.info('  1. 统一心跳: 每 15 分钟 (Cron: */15 * * * *) [数据同步 → 规则执行]')
  logger.info('     - 数据同步: 根据账户时区自动选择 Today/last_3d/last_7d/last_14d')
  logger.info('     - 双窗口归档: ≥02:00 ARCHIVED，≥12:00 FINALIZED')
  logger.info('     - 规则执行: 数据同步完成后触发（账户级锁，并发执行）')
  logger.info('  2. 账户列表同步: 每小时 (Cron: 0 * * * *) [从 FB 同步账户到 DB]')
  logger.info('  3. 结构全量轮转: 每小时 (Cron: 5 * * * *) [默认 6 账户，并发 1，usage 高跳过]')
  logger.info('  4. 热表清理: 每日 04:00 (Cron: 0 4 * * *) [删除 ad_snapshots 超过 2 天的快照]')
  logger.info('')
  logger.info('🔒 锁机制: 账户级锁（rule:account:xxx）+ 5分钟超时保险丝')
  logger.info('⚡ 优势: 零空转、高并发、无僵尸锁')
  logger.info('='.repeat(50))
  logger.info('')

  // 1. 统一心跳：每 15 分钟执行一次（AdsPolar 流水线架构）
  // 数据同步完成后，立即触发规则执行（链式反应）
  cron.schedule('*/15 * * * *', async () => {
    try {
      // 执行数据同步
      const syncResult = await unifiedHeartbeatSync()
      
      // AdsPolar 事件驱动优化：规则执行已在数据同步时触发（顺手触发模式）
      // 这里不再需要批量触发，因为每个账户同步完成后已经立即触发了规则执行
      // 保留此逻辑作为兜底机制（如果事件驱动失败，可以手动触发）
      if (syncResult && syncResult.syncedAccountIds && syncResult.syncedAccountIds.length > 0) {
        logger.info('')
        logger.info('='.repeat(50))
        logger.info('✅ 数据同步完成（规则执行已在同步时触发，AdsPolar 事件驱动模式）')
        logger.info(`📋 有数据更新的账户: ${syncResult.syncedAccountIds.length} 个`)
        logger.info('='.repeat(50))
        logger.info('')
        
        // 注意：规则执行已在数据同步时通过事件驱动模式触发
        // 这里不再批量执行，避免重复执行和资源浪费
        // 如果需要批量执行，可以使用 executeAllRules({ accountIds: syncResult.syncedAccountIds })
      } else {
        if (syncResult && syncResult.skipped) {
          logger.info(`⚠️  统一心跳被跳过（原因: ${syncResult.skipReason}），跳过规则执行`)
        } else {
          logger.info('⚠️  没有账户有数据更新，跳过规则执行（零空转）')
        }
      }
    } catch (error) {
      logger.error('❌ 统一心跳同步失败:', error.message)
    }
  })

  // 6. 每小时同步一次账户列表（从 FB API 同步到 account_mappings）
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

  // 7. 每小时结构全量轮转（P1，让路 P0；usage 高/熔断时本小时跳过；并发 1）
  cron.schedule('5 * * * *', async () => {
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) return
    try {
      const api = new FacebookMarketingAPI(token)
      const result = await runHourlyStructureFullRotation(api)
      if (result.skipped) {
        logger.info(`[结构轮转] 本小时跳过: ${result.reason}`)
      } else if (result.synced > 0) {
        logger.info(`[结构轮转] 本小时完成: ${result.synced} 个账户`)
      }
    } catch (err) {
      logger.warn('[结构轮转] 失败:', err.message)
    }
  })

  logger.info('✅ 定时任务已启动')
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
 * 手动触发规则执行（用于测试 / 规则页「立即运行所有规则」）
 * @param {boolean} force - 是否强制执行（忽略冷却期），默认 true
 * @param {Object} options - 可选
 * @param {number} options.ownerId - 传入时只执行该负责人下的账户（非 admin 用户传 req.user.owner_id）
 */
export async function manualExecute(force = true, options = {}) {
  const { ownerId } = options
  logger.info(`🔧 手动触发规则执行（${force ? '强制模式' : '正常模式'}${ownerId != null ? `，仅负责人 ${ownerId} 的账户` : ''}）`)
  await executeAllRules({ force, ownerId: ownerId ?? null })
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