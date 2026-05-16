// RuleEngineDispatcher：多规则一轮扫描仅按时间窗口去重查库，且判定结果与「用同一份数据逐条评估」一致（TASKS §2.4）
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockQueryRuleData = vi.fn()
const mockQueryRuleDataByLevel = vi.fn()
const mockGetAccountTimezone = vi.fn()
const mockPoolExecute = vi.fn()

vi.mock('../services/ruleDataService.js', () => ({
  queryRuleData: (...args) => mockQueryRuleData(...args),
  queryRuleDataByLevel: (...args) => mockQueryRuleDataByLevel(...args),
  getAccountTimezone: (...args) => mockGetAccountTimezone(...args)
}))

vi.mock('../db/connection.js', () => ({
  default: { execute: (...args) => mockPoolExecute(...args) }
}))

import { RuleEngine } from '../index.js'
import { loadDataForAccount, evaluateRuleWithCache } from '../services/ruleEngineDispatcher.js'

describe('RuleEngineDispatcher', () => {
  let ruleEngine
  const accountId = 'act_test'

  beforeEach(() => {
    process.env.RULE_LEVEL_EXECUTION_V2 = '1'
    ruleEngine = new RuleEngine(null)
    mockGetAccountTimezone.mockResolvedValue('UTC')
    mockQueryRuleData.mockReset()
    mockQueryRuleDataByLevel.mockReset()
    mockPoolExecute.mockReset()
  })

  it('同一账户多条规则、同一 time_window 时，仅执行 1 次核心数据查询', async () => {
    const sharedData = [
      { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null },
      { ad_id: 'ad_2', ad_name: 'B', ad_set_id: 'as_1', status: 'ACTIVE', spend: 5, link_clicks: 0, cpc: null, roas: null, purchases: 0, mute_until: null, mute_reason: null }
    ]
    mockQueryRuleData.mockResolvedValue({ data: sharedData })

    const rules = [
      { id: 1, ruleName: 'R1', enabled: true, targetLevel: 'ad', targetIds: ['ad_1', 'ad_2'], conditions: [{ metric: 'spend', operator: 'gt', value: 8, time_window: 'today' }], logicOperator: 'AND' },
      { id: 2, ruleName: 'R2', enabled: true, targetLevel: 'ad', targetIds: ['ad_1', 'ad_2'], conditions: [{ metric: 'link_clicks', operator: 'eq', value: 0, time_window: 'today' }], logicOperator: 'AND' }
    ]

    const loadResult = await loadDataForAccount(accountId, rules, ruleEngine)
    expect(loadResult.dataQueryCount).toBe(1)
    expect(mockQueryRuleData).toHaveBeenCalledTimes(1)
  })

  it('使用缓存评估结果与 evaluateRuleWithData 一致', async () => {
    const sharedData = [
      { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null },
      { ad_id: 'ad_2', ad_name: 'B', ad_set_id: 'as_1', status: 'ACTIVE', spend: 5, link_clicks: 0, cpc: null, roas: null, purchases: 0, mute_until: null, mute_reason: null }
    ]
    mockQueryRuleData.mockResolvedValue({ data: sharedData })

    const rule = { id: 1, ruleName: 'R1', enabled: true, targetLevel: 'ad', targetIds: ['ad_1', 'ad_2'], conditions: [{ metric: 'spend', operator: 'gt', value: 8, time_window: 'today' }], logicOperator: 'AND' }
    const rules = [rule]

    const loadResult = await loadDataForAccount(accountId, rules, ruleEngine)
    const matchedByCache = evaluateRuleWithCache(ruleEngine, rule, loadResult)
    const matchedByData = ruleEngine.evaluateRuleWithData(rule, sharedData)
    expect(matchedByCache.length).toBe(matchedByData.length)
    expect(matchedByCache.length).toBe(1)
    expect(matchedByCache[0].ad_id).toBe('ad_1')
    expect(matchedByData[0].ad_id).toBe('ad_1')
  })

  it('use_dynamic_scope=0 且 targetIds 为空时应跳过，避免扩大到全账户', async () => {
    const rule = {
      id: 99,
      ruleName: 'empty manual target',
      enabled: true,
      useDynamicScope: false,
      targetLevel: 'ad',
      targetIds: [],
      conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(mockQueryRuleData).not.toHaveBeenCalled()
    expect(matched).toEqual([])
  })

  it('use_dynamic_scope=1 时应优先使用快照目标（覆盖 targetIds）', async () => {
    mockPoolExecute.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM rule_matched_objects')) {
        return [[{ object_id: 'ad_1' }]]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    mockQueryRuleData.mockResolvedValue({
      data: [
        { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null }
      ]
    })

    const rule = {
      id: 3,
      ruleName: 'R3',
      enabled: true,
      useDynamicScope: true,
      targetLevel: 'ad',
      targetIds: ['ad_2'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(matched.length).toBe(1)
    expect(matched[0].ad_id).toBe('ad_1')
  })

  it('targetIds 为 act:id 时应按当前账户隔离目标', async () => {
    mockQueryRuleData.mockResolvedValue({
      data: [
        { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null },
        { ad_id: 'ad_2', ad_name: 'B', ad_set_id: 'as_2', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null }
      ]
    })

    const rule = {
      id: 4,
      ruleName: 'R4',
      enabled: true,
      targetLevel: 'ad',
      targetIds: ['act_test:ad_1', 'act_other:ad_2'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(matched.length).toBe(1)
    expect(matched[0].ad_id).toBe('ad_1')
  })

  it('use_dynamic_scope=1 且快照目标为空时不得使用 union 全量数据', () => {
    const rule = {
      id: 9001,
      ruleName: 'DynEmpty',
      enabled: true,
      useDynamicScope: true,
      conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }],
      logicOperator: 'AND'
    }
    const cacheKey = 'ad:today'
    const loadResult = {
      cacheKeysByRule: new Map([[rule.id, cacheKey]]),
      cache: new Map([[cacheKey, [{ ad_id: 'should_not_see', spend: 100, link_clicks: 0 }]]]),
      targetObjectIdsByRuleId: new Map([[rule.id, []]]),
      targetAdIdsByRuleId: new Map([[rule.id, []]])
    }
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)
    expect(matched.length).toBe(0)
  })

  it('动态快照查询异常时应 fail-closed 且不抛 ReferenceError', async () => {
    mockPoolExecute.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM rule_matched_objects')) {
        throw new Error('snapshot query failed')
      }
      if (String(sql).includes('FROM ad_snapshots s')) {
        return [[{ ad_id: 'ad_should_not_be_used' }]]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    mockQueryRuleDataByLevel.mockResolvedValue({ data: [] })

    const rule = {
      id: 9010,
      ruleName: 'DynFailClosed',
      enabled: true,
      useDynamicScope: true,
      targetLevel: 'campaign',
      targetIds: ['cmp_1'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }],
      logicOperator: 'AND'
    }

    await expect(loadDataForAccount(accountId, [rule], ruleEngine)).resolves.toBeTruthy()
    expect(mockQueryRuleDataByLevel).toHaveBeenCalledTimes(0)
  })

  it('campaign 规则应调用 queryRuleDataByLevel 且按 level 缓存', async () => {
    process.env.RULE_LEVEL_EXECUTION_V2 = '1'
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }]])
    mockQueryRuleDataByLevel.mockResolvedValue({
      data: [
        {
          campaign_id: 'cmp_1',
          spend: 12,
          purchases: 2,
          link_clicks: 10
        }
      ]
    })

    const rule = {
      id: 5,
      ruleName: 'R5',
      enabled: true,
      targetLevel: 'campaign',
      targetIds: ['cmp_1'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 10, time_window: 'today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(mockQueryRuleData).toHaveBeenCalledTimes(0)
    expect(mockQueryRuleDataByLevel).toHaveBeenCalledTimes(1)
    expect(loadResult.cacheKeysByRule.get(rule.id)).toBe('campaign:today')
    expect(matched.length).toBe(1)
  })

  it('RULE_LEVEL_EXECUTION_V2=0 时 campaign 规则应回退 ad 级查询', async () => {
    process.env.RULE_LEVEL_EXECUTION_V2 = '0'
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }]])
    mockQueryRuleData.mockResolvedValue({
      data: [
        {
          ad_id: 'ad_1',
          ad_name: 'A',
          ad_set_id: 'as_1',
          campaign_id: 'cmp_1',
          spend: 12,
          purchases: 2,
          link_clicks: 10
        }
      ]
    })

    const rule = {
      id: 6,
      ruleName: 'R6',
      enabled: true,
      targetLevel: 'campaign',
      targetIds: ['cmp_1'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 10, time_window: 'today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(mockQueryRuleDataByLevel).toHaveBeenCalledTimes(0)
    expect(mockQueryRuleData).toHaveBeenCalledTimes(1)
    expect(loadResult.cacheKeysByRule.get(rule.id)).toBe('ad:today')
    expect(matched.length).toBe(1)
  })

  it('新时间窗口应参与缓存键并正常查询', async () => {
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }]])
    mockQueryRuleData.mockResolvedValue({
      data: [
        { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 8, link_clicks: 2, purchases: 1 }
      ]
    })
    const rule = {
      id: 7,
      ruleName: 'R7',
      enabled: true,
      targetLevel: 'ad',
      targetIds: ['ad_1'],
      conditions: [{ metric: 'spend', operator: 'gt', value: 1, time_window: 'last_5_days_excluding_today' }],
      logicOperator: 'AND'
    }

    const loadResult = await loadDataForAccount(accountId, [rule], ruleEngine)
    const matched = evaluateRuleWithCache(ruleEngine, rule, loadResult)

    expect(mockQueryRuleData).toHaveBeenCalledTimes(1)
    expect(loadResult.cacheKeysByRule.get(rule.id)).toBe('ad:last_5_days_excluding_today')
    expect(matched.length).toBe(1)
  })
})
