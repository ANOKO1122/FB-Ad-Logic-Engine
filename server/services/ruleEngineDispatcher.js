// 规则引擎调度器：按账户一次性拉取规则数据，多规则共用缓存，避免每条规则单独查库
// 对应 TASKS §2.4、DEV_PLAN 4.6「合并同类项：RuleEngineDispatcher」

import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { queryRuleData, queryRuleDataByLevel, getAccountTimezone } from './ruleDataService.js'
import { _internals as dynamicScopeInternals } from './dynamicScopeService.js'

function isRuleLevelExecutionV2Enabled() {
  const raw = String(process.env.RULE_LEVEL_EXECUTION_V2 ?? '0').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

function normalizeTimeWindowAlias(raw) {
  if (raw === 'last_3d') return 'last_3_days'
  if (raw === 'last_3d_excluding_today') return 'last_3_days_excluding_today'
  if (raw === 'last_5d') return 'last_5_days'
  if (raw === 'last_5d_excluding_today') return 'last_5_days_excluding_today'
  if (raw === 'last_7d') return 'last_7_days'
  if (raw === 'last_7d_excluding_today') return 'last_7_days_excluding_today'
  if (raw === 'last_30d') return 'last_30_days'
  return raw
}

/**
 * 解析单条规则的目标广告 ID 列表（与 index.js RuleEngine.evaluateRule 口径一致）
 * @param {string} accountId
 * @param {Object} rule - 含 targetLevel/target_level, targetIds/target_ids
 * @param {Set<string>} allAdIdsInAccount - 若已预先拉取「账户下全部 ad_id」，传入；否则 null
 * @returns {Promise<{ targetLevel: string, targetObjectIds: string[], targetAdIds: string[], queryCount: number }>}
 */
async function resolveTargetAdIdsForRule(accountId, rule, allAdIdsInAccount = null) {
  const ruleTargetLevel = (rule.targetLevel || rule.target_level || 'ad').toLowerCase()
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
    const resolvedObjectType = (ruleTargetLevel || 'ad').toLowerCase()
    try {
      // M2 typed snapshot: 按规则 targetLevel 读取快照，不再写死 object_type='ad'
      const [rows] = await pool.execute(
        `SELECT object_id
         FROM rule_matched_objects
         WHERE account_id = ?
           AND rule_id = ?
           AND object_type = ?`,
        [accountId, rule.id, resolvedObjectType]
      )
      const targetObjectIds = rows.map(row => String(row.object_id || '')).filter(Boolean)
      queryCount = 1
      if (resolvedObjectType === 'ad') {
        return { targetLevel: resolvedObjectType, targetObjectIds, targetAdIds: targetObjectIds, queryCount }
      }
      // Phase B: 通过 structure_ads 将 campaign/adset 对象 ID 展开为子广告 ID
      // V2=1 优先用 queryRuleDataByLevel() 做同层聚合评估，使用 targetObjectIds
      // V2=0 兼容分支使用展开出的 targetAdIds 执行 ad 级评估，避免静默空集
      let expandedAdIds = []
      if (targetObjectIds.length > 0) {
        const filterColumn = resolvedObjectType === 'adset' ? 'adset_id' : 'campaign_id'
        const placeholders = targetObjectIds.map(() => '?').join(',')
        const [adRows] = await pool.execute(
          `SELECT DISTINCT ad_id FROM structure_ads WHERE account_id = ? AND ${filterColumn} IN (${placeholders})`,
          [accountId, ...targetObjectIds.map(id => String(id))]
        )
        expandedAdIds = adRows.map(row => String(row.ad_id || '')).filter(Boolean)
        queryCount += 1
      }
      return { targetLevel: resolvedObjectType, targetObjectIds, targetAdIds: expandedAdIds, queryCount }
    } catch (err) {
      // 动态快照读失败：不得回退到「全账户广告」，否则会把圈外广告纳入评估（与 use_dynamic_scope 语义冲突）
      logger.warn(
        `   [Dispatcher] 规则 ${rule.id} 读取动态快照失败，本规则本轮跳过评估（fail-closed）:`,
        err.message
      )
      return { targetLevel: resolvedObjectType, targetObjectIds: [], targetAdIds: [], queryCount: 0 }
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
    logger.warn(
      `   [Dispatcher] 规则 ${rule.id} use_dynamic_scope=0 但目标对象为空，跳过本规则评估（避免扩大到整个广告账户）`
    )
    targetAdIds = []
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

  const targetObjectIds = ruleTargetLevel === 'ad' ? targetAdIds : ruleTargetIds
  return { targetLevel: ruleTargetLevel, targetObjectIds, targetAdIds, queryCount }
}

/**
 * 按账户一次性加载规则数据并缓存（每轮扫描仅按「时区 + 按时间窗口去重」查库）
 * @param {string} accountId
 * @param {Array<Object>} rules - 该账户下待评估规则（含 conditions, targetLevel, targetIds 等）
 * @param {Object} ruleEngine - RuleEngine 实例，用于 getTimeWindowFromConditions / getCustomRangeFromConditions
 * @returns {Promise<{ timezoneName: string, cache: Map<string, Array>, targetObjectIdsByRuleId: Map<number, string[]>, targetAdIdsByRuleId: Map<number, string[]>, dataQueryCount: number, targetResolutionQueryCount: number }>}
 */
export async function loadDataForAccount(accountId, rules, ruleEngine) {
  const enableLevelExecution = isRuleLevelExecutionV2Enabled()
  const timezoneName = await getAccountTimezone(accountId)
  const targetObjectIdsByRuleId = new Map()
  const targetAdIdsByRuleId = new Map()
  const targetLevelByRuleId = new Map()
  let targetResolutionQueryCount = 0
  let allAdIdsInAccount = null

  // 安全策略：手动范围为空时 fail-closed，不再把空 target 解释为「全账户」。
  // 因此这里不再为了空目标预拉全账户广告，避免事故规则产生全量候选集。
  const needsAllAdIds = false
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
    const { targetLevel, targetObjectIds, targetAdIds, queryCount } = await resolveTargetAdIdsForRule(accountId, rule, allAdIdsInAccount)
    const effectiveLevel = enableLevelExecution ? targetLevel : 'ad'
    targetResolutionQueryCount += queryCount
    targetLevelByRuleId.set(rule.id, effectiveLevel)
    targetObjectIdsByRuleId.set(rule.id, effectiveLevel === 'ad' ? targetAdIds : targetObjectIds)
    targetAdIdsByRuleId.set(rule.id, targetAdIds)
    if (effectiveLevel === 'ad') {
      targetAdIds.forEach(id => unionAdIdsSet.add(id))
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
      timeWindow = normalizeTimeWindowAlias(ruleEngine.getTimeWindowFromConditions(rule.conditions, logicOp) || 'today')
      customRange = timeWindow === 'custom_range' ? ruleEngine.getCustomRangeFromConditions(rule.conditions, logicOp) : null
    } catch (e) {
      logger.warn(`   [Dispatcher] 规则 ${rule.id} 时间窗口解析失败:`, e.message)
    }
    const targetLevel = targetLevelByRuleId.get(rule.id) || (rule.targetLevel || rule.target_level || 'ad').toLowerCase()
    const cacheKey = `${targetLevel}:${timeWindow}` + (customRange ? `:${JSON.stringify(customRange)}` : '')
    cacheKeysByRule.set(rule.id, cacheKey)
    if (!keyToParams.has(cacheKey)) keyToParams.set(cacheKey, { targetLevel, timeWindow, customRange })
  }

  const cache = new Map()
  let dataQueryCount = 0
  for (const [cacheKey, { targetLevel, timeWindow, customRange }] of keyToParams) {
    try {
      let result
      if (targetLevel === 'ad') {
        const unionAdIds = [...unionAdIdsSet]
        if (unionAdIds.length === 0) {
          cache.set(cacheKey, [])
          continue
        }
        result = await queryRuleData(accountId, unionAdIds, timeWindow, timezoneName, customRange)
      } else {
        const ruleIdsForKey = rules
          .filter((r) => cacheKeysByRule.get(r.id) === cacheKey)
          .map((r) => r.id)
        const objectIds = [...new Set(ruleIdsForKey.flatMap((id) => targetObjectIdsByRuleId.get(id) || []))]
        if (objectIds.length === 0) {
          cache.set(cacheKey, [])
          continue
        }
        result = await queryRuleDataByLevel(accountId, objectIds, targetLevel, timeWindow, timezoneName, customRange)
      }
      const data = result?.data ?? result
      cache.set(cacheKey, Array.isArray(data) ? data : [])
      dataQueryCount += 1
    } catch (err) {
      logger.warn({
        message: `   [Dispatcher] queryRuleData(${timeWindow}) 失败`,
        errorMessage: err.message,
        code: err.code,
        sqlMessage: err.sqlMessage,
        errno: err.errno,
        sqlState: err.sqlState,
        stack: err.stack?.split('\n').slice(0, 4).join('\n')
      })
      cache.set(cacheKey, [])
    }
  }

  return {
    timezoneName,
    cache,
    targetObjectIdsByRuleId,
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
  const enableLevelExecution = isRuleLevelExecutionV2Enabled()
  const cacheKey = loadResult.cacheKeysByRule?.get(rule.id)
  if (cacheKey == null) return []
  const fullData = loadResult.cache.get(cacheKey) || []
  const targetLevel = enableLevelExecution
    ? (rule.targetLevel || rule.target_level || 'ad').toLowerCase()
    : 'ad'
  const targetIds = loadResult.targetObjectIdsByRuleId?.get(rule.id) || []
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
  let ruleDataArray = fullData
  if (filterSet) {
    if (targetLevel === 'ad') {
      ruleDataArray = fullData.filter(row => filterSet.has(String(row?.ad_id || '')))
    } else if (targetLevel === 'adset') {
      ruleDataArray = fullData.filter(row => filterSet.has(String(row?.ad_set_id || row?.adset_id || '')))
    } else if (targetLevel === 'campaign') {
      ruleDataArray = fullData.filter(row => filterSet.has(String(row?.campaign_id || '')))
    }
  }
  return ruleEngine.evaluateRuleWithData(rule, ruleDataArray)
}
