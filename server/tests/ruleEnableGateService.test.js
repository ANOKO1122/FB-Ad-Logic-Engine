import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/connection.js', () => ({
  default: {
    execute: vi.fn().mockResolvedValue([[{ 1: 1 }]])
  }
}))

vi.mock('../services/dynamicScopeService.js', () => ({
  isDynamicScopeFeatureEnabled: () => true
}))

import { assertRuleReadyToEnable } from '../services/ruleEnableGateService.js'

describe('ruleEnableGateService', () => {
  it('启用校验应拒绝非 ad 层使用 purchases_avg_after_create 条件', async () => {
    const result = await assertRuleReadyToEnable({
      enabled: true,
      accountId: 'act_1',
      targetLevel: 'campaign',
      targetAccountIds: ['act_1'],
      useDynamicScope: false,
      conditions: {
        version: 2,
        groups: [{
          operator: 'AND',
          conditions: [{ metric: 'purchases_avg_after_create', operator: 'gt', value: 0, time_window: 'last_7_days' }]
        }]
      },
      actions: [{ type: 'pause_ad' }]
    }, { isAdmin: true, ownerId: null })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('INVALID_CONDITIONS')
  })

  it('启用校验应按真实 targetLevel 校验 set_dynamic_budget 指标', async () => {
    const result = await assertRuleReadyToEnable({
      enabled: true,
      accountId: 'act_1',
      targetLevel: 'campaign',
      targetAccountIds: ['act_1'],
      useDynamicScope: false,
      conditions: [{ metric: 'purchases', operator: 'gt', value: 0 }],
      actions: [{
        type: 'set_dynamic_budget',
        metric: 'purchases_avg_after_create',
        multiplier: 6
      }]
    }, { isAdmin: true, ownerId: null })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('INVALID_ACTIONS')
  })
})
