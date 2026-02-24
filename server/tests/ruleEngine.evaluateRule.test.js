// evaluateRule 真实链路测试：确保 logicOperator（驼峰）正确传入 OR 语义
// cron 执行时规则来自 Drizzle，返回 rule.logicOperator 而非 rule.logic_operator
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

// 在 mock 之后导入，确保使用 mock 的依赖
import { RuleEngine } from '../index.js'

describe('evaluateRule 真实链路（logicOperator 驼峰）', () => {
  let ruleEngine
  let mockApi

  beforeEach(() => {
    mockApi = {
      pauseAd: vi.fn(),
      activateAd: vi.fn(),
      getAdsetBudget: vi.fn(),
      updateAdsetBudget: vi.fn()
    }
    ruleEngine = new RuleEngine(mockApi)

    mockGetAccountTimezone.mockResolvedValue('UTC')
    mockQueryRuleData.mockResolvedValue({
      data: [
        {
          ad_id: 'ad_1',
          ad_name: 'Test Ad',
          ad_set_id: 'adset_1',
          spend: 0.5,
          cpc: 1.0,
          link_clicks: 5,
          roas: 1.2
        }
      ]
    })
    // 无 targetIds 时查询账户下所有广告，返回 ad_1
    mockPoolExecute.mockResolvedValue([[{ ad_id: 'ad_1' }]])
  })

  it('rule.logicOperator（驼峰）为 OR 时，仅满足第二条件也应匹配', async () => {
    const rule = {
      enabled: true,
      conditions: [
        { metric: 'spend', operator: 'gt', value: 0.8 },
        { metric: 'cpc', operator: 'gt', value: 0.8 }
      ],
      logicOperator: 'OR',
      targetLevel: null,
      targetIds: []
    }
    const matched = await ruleEngine.evaluateRule(rule, 'act_test')
    expect(matched.length).toBe(1)
    expect(matched[0].ad_id).toBe('ad_1')
  })
})
