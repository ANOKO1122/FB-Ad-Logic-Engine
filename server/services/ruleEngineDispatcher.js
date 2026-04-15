// 规则引擎调度器：按账户一次性拉取规则数据，多规则共用缓存，避免每条规则单独查库
// 对应 TASKS §2.4、DEV_PLAN 4.6「合并同类项：RuleEngineDispatcher」

import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { queryRuleData, getAccountTimezone } from './ruleDataService.js'
import { _internals as dynamicScopeInternals } from './dynamicScopeService.js'

/**
 * 解析单条规则的目标广告 ID 列表（与 index.js RuleEngine.evaluateRule 口径一致）
 * @param {string} accountId
 * @param {Object} rule - 含 targetLevel/target_level, targetIds/target_ids
 * @param {Set<string>} allAdIdsInAccount - 若已预先拉取「账户下全部 ad_id」，传入；否则 null
 * @returns {Promise<{ targetAdIds: string[], queryCount: number }>} 本规则目标 ad_id 列表及本步产生的查询次数（0 或 1）
 */
async function resolveTargetAdIdsForRule(accountId, rule, allAdIdsInAccount = null) {
  const ruleTargetLevel = rule.targetLevel || rule.target_level
  const targetByAccount = rule.targetByAccount ?? rule.target_by_account
  const useDynamicScope = Boolean(rule.useDynamicScope ?? rule.use_dynamic_scope)
  let ruleTargetIds = []
  let explicitEmptyForAccount = false
  if (targetByAccount && typeof targetByAccount === 'object' && accountId in targetByAccount) {
    const arr = targetByAccount[accountId]
    ruleTargetIds = Array.isArray(arr) ? arr.map(id => String(id)).filter(Boolean) : []
    explicitEmptyForAccount = true
  } else {
    const raw = rule.targetIds || rule.target_ids || []
    const withAccount = raw.filter(id => String(id).startsWith(accountId + ':'))
    if (withAccount.length > 0) {
      ruleTargetIds = withAccount.map(s => String(s).split(':').slice(1).join(':')).filter(Boolean)
    } else {
      ruleTargetIds = raw.map(id => String(id)).filter(Boolean)
    }
  }
  let targetAdIds = []
  let queryCount = 0

  if (useDynamicScope) {
    try {
      const [rows] = await pool.execute(
        `SELECT object_id
         FROM rule_matched_objects
         WHERE account_id = ?
           AND rule_id = ?
           AND object_type = 'ad'`,
        [accountId, rule.id]
      )
      targetAdIds = rows.map(row => String(row.object_id || '')).filter(Boolean)
      queryCount = 1
      return { targetAdIds, queryCount }
    } catch (err) {
      // 动态快照读失败：不得回退到「全账户广告」，否则会把圈外广告纳入评估（与 use_dynamic_scope 语义冲突）
      logger.warn(
        `   [Dispatcher] 规则 ${rule.id} 读取动态快照失败，本规则本轮跳过评估（fail-closed）:`,
        err.message
      )
      return { targetAdIds: [], queryCount: 0 }
    }
  }

  if (ruleTargetLevel && ruleTargetIds.length > 0) {
    if (ruleTargetLevel === 'ad') {
      targetAdIds = ruleTargetIds
    } else {
      try {
        const filterColumn = ruleTargetLevel === 'adset' ? 'adset_id' : 'campaign_id'
        const placeholders = ruleTargetIds.map(() => '?').join(',')
        const [rows] = await pool.execute(
          `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND ${filterColumn} IN (${placeholders})`,
          [accountId, ...ruleTargetIds.map(id => String(id))]
        )
        targetAdIds = rows.map(row => String(row.ad_id || '')).filter(Boolean)
        queryCount = 1
      } catch (err) {
        logger.warn(`   [Dispatcher] 规则 ${rule.id} 解析 ${ruleTargetLevel} 目标失败:`, err.message)
      }
    }
  } else if (explicitEmptyForAccount && ruleTargetIds.length === 0) {
    targetAdIds = []
  } else {
    if (allAdIdsInAccount != null) {
      targetAdIds = [...allAdIdsInAccount]
    } else {
      try {
        const [rows] = await pool.execute(
          `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ?`,
          [accountId]
        )
        targetAdIds = rows.map(row => String(row.ad_id || '')).filter(Boolean)
        queryCount = 1
      } catch (err) {
        logger.warn(`   [Dispatcher] 查询账户 ${accountId} 全部广告失败:`, err.message)
      }
    }
  }

  // 关闭动态时：目标 = target_ids/target_by_account − exclude_ids，与动态规则口径一致
  const rawExclude = rule.excludeIds ?? rule.exclude_ids
  if (!useDynamicScope && rawExclude && typeof rawExclude === 'object' && targetAdIds.length > 0) {
    try {
      const excludeSet = await dynamicScopeInternals.expandExcludeIdsToAdLevel(accountId, rawExclude)
      if (excludeSet.size > 0) {
        const before = targetAdIds.length
        targetAdIds = targetAdIds.filter(id => !excludeSet.has(String(id)))
        if (targetAdIds.length < before) {
          logger.debug(`   [Dispatcher] 规则 ${rule.id} 排除 ${before - targetAdIds.length} 个后剩余 ${targetAdIds.length} 个目标`)
        }
      }
    } catch (err) {
      logger.warn(`   [Dispatcher] 规则 ${rule.id} 展开 exclude_ids 失败，未应用排除:`, err.message)
    }
  }

  return { targetAdIds, queryCount }
}

/**
 * 按账户一次性加载规则数据并缓存（每轮扫描仅按「时区 + 按时间窗口去重」查库）
 * @param {string} accountId
 * @param {Array<Object>} rules - 该账户下待评估规则（含 conditions, targetLevel, targetIds 等）
 * @param {Object} ruleEngine - RuleEngine 实例，用于 getTimeWindowFromConditions / getCustomRangeFromConditions
 * @returns {Promise<{ timezoneName: string, cache: Map<string, Array>, targetAdIdsByRuleId: Map<number, string[]>, dataQueryCount: number, targetResolutionQueryCount: number }>}
 */
export async function loadDataForAccount(accountId, rules, ruleEngine) {
  const timezoneName = await getAccountTimezone(accountId)
  const targetAdIdsByRuleId = new Map()
  let targetResolutionQueryCount = 0
  let allAdIdsInAccount = null

  // 若存在「未指定 target」的规则，先拉一次「账户下全部 ad_id」复用
  const needsAllAdIds = rules.some(r => {
    const level = r.targetLevel || r.target_level
    const ids = r.targetIds || r.target_ids || []
    return !level || !Array.isArray(ids) || ids.length === 0
  })
  if (needsAllAdIds) {
    try {
      const [rows] = await pool.execute(
        `SELECT s.ad_id FROM ad_snapshots s
         INNER JOIN (SELECT ad_id, MAX(synced_at) as max_synced_at FROM ad_snapshots WHERE account_id = ? GROUP BY ad_id) t
         ON s.ad_id = t.ad_id AND s.synced_at = t.max_synced_at WHERE s.account_id = ?`,
        [accountId, accountId]
      )
      allAdIdsInAccount = new Set(rows.map(row => String(row.ad_id || '')).filter(Boolean))
      targetResolutionQueryCount += 1
    } catch (err) {
      logger.warn(`   [Dispatcher] 查询账户 ${accountId} 全部广告失败:`, err.message)
    }
  }

  const unionAdIdsSet = new Set()
  const cacheKeysByRule = new Map() // ruleId -> cacheKey

  for (const rule of rules) {
    const { targetAdIds, queryCount } = await resolveTargetAdIdsForRule(accountId, rule, allAdIdsInAccount)
    targetResolutionQueryCount += queryCount
    targetAdIdsByRuleId.set(rule.id, targetAdIds)
    targetAdIds.forEach(id => unionAdIdsSet.add(id))
  }

  const unionAdIds = [...unionAdIdsSet]
  if (unionAdIds.length === 0) {
    return {
      timezoneName,
      cache: new Map(),
      targetAdIdsByRuleId,
      dataQueryCount: 0,
      targetResolutionQueryCount
    }
  }

  // 收集各规则使用的 (time_window, custom_range) 并去重
  const logicOpByRule = new Map()
  const keyToParams = new Map() // cacheKey -> { timeWindow, customRange }
  for (const rule of rules) {
    const logicOp = rule.logicOperator ?? rule.logic_operator ?? 'AND'
    logicOpByRule.set(rule.id, logicOp)
    let timeWindow = 'today'
    let customRange = null
    try {
      timeWindow = ruleEngine.getTimeWindowFromConditions(rule.conditions, logicOp) || 'today'
      customRange = timeWindow === 'custom_range' ? ruleEngine.getCustomRangeFromConditions(rule.conditions, logicOp) : null
    } catch (e) {
      logger.warn(`   [Dispatcher] 规则 ${rule.id} 时间窗口解析失败:`, e.message)
    }
    const cacheKey = timeWindow + (customRange ? `:${JSON.stringify(customRange)}` : '')
    cacheKeysByRule.set(rule.id, cacheKey)
    if (!keyToParams.has(cacheKey)) keyToParams.set(cacheKey, { timeWindow, customRange })
  }

  const cache = new Map()
  let dataQueryCount = 0
  for (const [cacheKey, { timeWindow, customRange }] of keyToParams) {
    try {
      const result = await queryRuleData(accountId, unionAdIds, timeWindow, timezoneName, customRange)
      const data = result?.data ?? result
      cache.set(cacheKey, Array.isArray(data) ? data : [])
      dataQueryCount += 1
    } catch (err) {
      logger.warn(`   [Dispatcher] queryRuleData(${timeWindow}) 失败:`, err.message)
      cache.set(cacheKey, [])
    }
  }

  return {
    timezoneName,
    cache,
    targetAdIdsByRuleId,
    cacheKeysByRule,
    dataQueryCount,
    targetResolutionQueryCount
  }
}

/**
 * 使用已加载的缓存评估单条规则（无 DB 调用）
 * @param {Object} ruleEngine - RuleEngine 实例
 * @param {Object} rule
 * @param {Object} loadResult - loadDataForAccount 的返回值
 * @returns {Array<Object>} matchedAds（与 evaluateRule 一致）
 */
export function evaluateRuleWithCache(ruleEngine, rule, loadResult) {
  if (!rule.enabled) return []
  const cacheKey = loadResult.cacheKeysByRule?.get(rule.id)
  if (cacheKey == null) return []
  const fullData = loadResult.cache.get(cacheKey) || []
  const targetIds = loadResult.targetAdIdsByRuleId.get(rule.id) || []
  const useDyn = Boolean(rule.useDynamicScope ?? rule.use_dynamic_scope)
  // 动态筛选：目标仅以 rule_matched_objects 为准。快照为空时不得用「本批 union」全量数据评估，
  // 否则同账户多规则一轮扫描时会把其它规则圈内的广告误纳入本条规则（名称条件被绕过）。
  if (useDyn && targetIds.length === 0) {
    if (fullData.length > 0) {
      logger.warn(
        `   [Dispatcher] 规则 ${rule.id} use_dynamic_scope=1 但快照目标为空，跳过本规则评估（避免误用 union=${fullData.length} 条），见 DYNAMIC_SCOPE_EMPTY_SKIP_UNION`
      )
    }
    return ruleEngine.evaluateRuleWithData(rule, [])
  }
  const filterSet = targetIds.length > 0 ? new Set(targetIds) : null
  const ruleDataArray = filterSet
    ? fullData.filter(row => filterSet.has(String(row?.ad_id || '')))
    : fullData
  return ruleEngine.evaluateRuleWithData(rule, ruleDataArray)
}
