// RuleEngineDispatcher：多规则一轮扫描仅按时间窗口去重查库，且判定结果与「用同一份数据逐条评估」一致（TASKS §2.4）
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockQueryRuleData = vi.fn()
const mockGetAccountTimezone = vi.fn()
const mockPoolExecute = vi.fn()

vi.mock('../services/ruleDataService.js', () => ({
  queryRuleData: (...args) => mockQueryRuleData(...args),
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
    ruleEngine = new RuleEngine(null)
    mockGetAccountTimezone.mockResolvedValue('UTC')
    mockQueryRuleData.mockReset()
    mockPoolExecute.mockReset()
  })

  it('同一账户多条规则、同一 time_window 时，仅执行 1 次核心数据查询', async () => {
    const sharedData = [
      { ad_id: 'ad_1', ad_name: 'A', ad_set_id: 'as_1', status: 'ACTIVE', spend: 10, link_clicks: 5, cpc: 2, roas: 1.5, purchases: 2, mute_until: null, mute_reason: null },
      { ad_id: 'ad_2', ad_name: 'B', ad_set_id: 'as_1', status: 'ACTIVE', spend: 5, link_clicks: 0, cpc: null, roas: null, purchases: 0, mute_until: null, mute_reason: null }
    ]
    mockQueryRuleData.mockResolvedValue({ data: sharedData })
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }, { ad_id: 'ad_2' }]])

    const rules = [
      { id: 1, ruleName: 'R1', enabled: true, targetLevel: null, targetIds: [], conditions: [{ metric: 'spend', operator: 'gt', value: 8, time_window: 'today' }], logicOperator: 'AND' },
      { id: 2, ruleName: 'R2', enabled: true, targetLevel: null, targetIds: [], conditions: [{ metric: 'link_clicks', operator: 'eq', value: 0, time_window: 'today' }], logicOperator: 'AND' }
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
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }, { ad_id: 'ad_2' }]])

    const rule = { id: 1, ruleName: 'R1', enabled: true, targetLevel: null, targetIds: [], conditions: [{ metric: 'spend', operator: 'gt', value: 8, time_window: 'today' }], logicOperator: 'AND' }
    const rules = [rule]

    const loadResult = await loadDataForAccount(accountId, rules, ruleEngine)
    const matchedByCache = evaluateRuleWithCache(ruleEngine, rule, loadResult)
    const matchedByData = ruleEngine.evaluateRuleWithData(rule, sharedData)
    expect(matchedByCache.length).toBe(matchedByData.length)
    expect(matchedByCache.length).toBe(1)
    expect(matchedByCache[0].ad_id).toBe('ad_1')
    expect(matchedByData[0].ad_id).toBe('ad_1')
  })
})
