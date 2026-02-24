/**
 * M4 3.2 预算幂等 — 验证 3：传 _resolvedBudgetCents 时不再调用 getAdsetBudget
 *
 * 【教学】为什么要 mock？
 * - 被测代码会调 Facebook API 和写库，单测不能真发请求、不能依赖真实 DB。
 * - 用 vi.mock 替换掉「外部依赖」，只断言「调用次数」和「参数」，验证幂等逻辑。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted 让 mock 在 vi.mock 工厂执行前就存在，工厂内才能引用
const { mockGetAdsetBudget, mockGetAdsetBudgetDetail, mockUpdateAdsetBudget } = vi.hoisted(() => ({
  mockGetAdsetBudget: vi.fn(),
  mockGetAdsetBudgetDetail: vi.fn(),
  mockUpdateAdsetBudget: vi.fn()
}))

vi.mock('../index.js', () => {
  process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'fake-token-for-test'
  return {
    FacebookMarketingAPI: vi.fn().mockImplementation(function () {
      return {
        getAdsetBudget: mockGetAdsetBudget,
        getAdsetBudgetDetail: mockGetAdsetBudgetDetail,
        updateAdsetBudget: mockUpdateAdsetBudget
      }
    })
  }
})

vi.mock('../db/drizzle.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    })
  }
}))

vi.mock('../db/schema.js', () => ({ automationLogs: {} }))
vi.mock('../db/connection.js', () => ({ default: {} }))

// 被测模块在 mock 之后 import（Token 已在 mock 工厂内设置）
import { executeActionsForAd } from '../services/actionExecutorService.js'

const baseRule = {
  id: 1,
  ruleName: 'test',
  actions: [{ type: 'decrease_budget', value: 10 }],
  isSimulation: false
}
const baseMatchedAd = {
  ad_id: '120239056609970760',
  ad_name: 'test-ad',
  ad_set_id: '120239056609970760_set'
}

describe('M4 3.2 预算幂等 — 验证 3', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdsetBudget.mockResolvedValue(1000)
    // 智能路由：先查 AdSet 明细判断 ABO/CBO；ABO 时返回有预算
    mockGetAdsetBudgetDetail.mockResolvedValue({ daily_budget: 1000, lifetime_budget: 0 })
    mockUpdateAdsetBudget.mockResolvedValue(true)
    process.env.FACEBOOK_ACCESS_TOKEN = 'fake-token-for-test'
  })

  it('未传 _resolvedBudgetCents 时会调用 getAdsetBudgetDetail 再调用 updateAdsetBudget', async () => {
    await executeActionsForAd({
      rule: baseRule,
      matchedAd: baseMatchedAd,
      accountId: 'act_123',
      ownerId: 1
    })
    expect(mockGetAdsetBudgetDetail).toHaveBeenCalledTimes(1)
    expect(mockUpdateAdsetBudget).toHaveBeenCalledTimes(1)
    // updateAdsetBudget(adsetId, newBudgetCents, isDaily)：ABO 且 daily_budget>0 时 isDaily=true
    expect(mockUpdateAdsetBudget).toHaveBeenCalledWith(baseMatchedAd.ad_set_id, 900, true)
  })

  it('传入 _resolvedBudgetCents 时仍会调用 getAdsetBudgetDetail（判断 ABO），再调用 updateAdsetBudget 且传该值(分)', async () => {
    const actionWithResolved = { type: 'decrease_budget', value: 10, _resolvedBudgetCents: 900 }
    await executeActionsForAd({
      rule: baseRule,
      matchedAd: baseMatchedAd,
      accountId: 'act_123',
      ownerId: 1,
      actionsOverride: [actionWithResolved]
    })
    expect(mockGetAdsetBudgetDetail).toHaveBeenCalledTimes(1)
    expect(mockUpdateAdsetBudget).toHaveBeenCalledTimes(1)
    // updateAdsetBudget(adsetId, newBudgetCents, isDaily)：ABO 且 daily_budget>0 时 isDaily=true
    expect(mockUpdateAdsetBudget).toHaveBeenCalledWith(baseMatchedAd.ad_set_id, 900, true)
  })
})
