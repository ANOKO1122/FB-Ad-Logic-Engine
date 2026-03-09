import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockGetAdsetBudgetDetail, mockUpdateAdsetBudget, mockIsCooldownDue } = vi.hoisted(() => ({
  mockGetAdsetBudgetDetail: vi.fn(),
  mockUpdateAdsetBudget: vi.fn(),
  mockIsCooldownDue: vi.fn()
}))

vi.mock('../index.js', () => {
  process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'fake-token-for-test'
  return {
    FacebookMarketingAPI: vi.fn().mockImplementation(function () {
      return {
        getAdsetBudgetDetail: mockGetAdsetBudgetDetail,
        updateAdsetBudget: mockUpdateAdsetBudget
      }
    })
  }
})

vi.mock('../services/ruleExecutionStateService.js', () => ({
  isCooldownDue: mockIsCooldownDue
}))

vi.mock('../db/drizzle.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    })
  }
}))

vi.mock('../db/schema.js', () => ({ automationLogs: {} }))
vi.mock('../db/connection.js', () => ({ default: {} }))

import { executeActionsForAd } from '../services/actionExecutorService.js'

const baseMatchedAd = {
  ad_id: '120239056609970760',
  ad_name: 'test-ad',
  ad_set_id: '120239056609970760_set'
}

describe('预算 Pre-Flight 跳过原因细分', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsCooldownDue.mockResolvedValue(true)
    mockUpdateAdsetBudget.mockResolvedValue(true)
    process.env.FACEBOOK_ACCESS_TOKEN = 'fake-token-for-test'
  })

  it('increase: current > max 时 skipped 原因为 above_max_cap', async () => {
    mockGetAdsetBudgetDetail.mockResolvedValue({ daily_budget: 9000, lifetime_budget: 0 })
    const rule = {
      id: 1,
      ruleName: 'increase-above-max',
      actions: [{ type: 'increase_budget', value: 10, max_daily_budget: 7000 }],
      isSimulation: false
    }

    const results = await executeActionsForAd({
      rule,
      matchedAd: baseMatchedAd,
      accountId: 'act_123',
      ownerId: 1
    })

    expect(results[0].status).toBe('skipped')
    expect(results[0].errorMessage).toContain('above_max_cap')
    expect(mockUpdateAdsetBudget).not.toHaveBeenCalled()
  })

  it('decrease: current <= min 时 skipped 原因为 below_min_floor', async () => {
    mockGetAdsetBudgetDetail.mockResolvedValue({ daily_budget: 1000, lifetime_budget: 0 })
    const rule = {
      id: 2,
      ruleName: 'decrease-below-min',
      actions: [{ type: 'decrease_budget', value: 10, min_daily_budget: 3000 }],
      isSimulation: false
    }

    const results = await executeActionsForAd({
      rule,
      matchedAd: baseMatchedAd,
      accountId: 'act_123',
      ownerId: 1
    })

    expect(results[0].status).toBe('skipped')
    expect(results[0].errorMessage).toContain('below_min_floor')
    expect(mockUpdateAdsetBudget).not.toHaveBeenCalled()
  })

  it('set_budget: current == target 时 skipped 原因为 budget_already_at_target', async () => {
    mockGetAdsetBudgetDetail.mockResolvedValue({ daily_budget: 5000, lifetime_budget: 0 })
    const rule = {
      id: 3,
      ruleName: 'set-budget-equal',
      actions: [{ type: 'set_budget', value: 50, value_unit: 'usd' }],
      isSimulation: false
    }

    const results = await executeActionsForAd({
      rule,
      matchedAd: baseMatchedAd,
      accountId: 'act_123',
      ownerId: 1
    })

    expect(results[0].status).toBe('skipped')
    expect(results[0].errorMessage).toContain('budget_already_at_target')
    expect(mockUpdateAdsetBudget).not.toHaveBeenCalled()
  })
})
