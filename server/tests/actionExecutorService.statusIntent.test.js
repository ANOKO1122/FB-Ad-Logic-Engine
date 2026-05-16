import { describe, it, expect } from 'vitest'
import { computeDynamicBudgetCents, resolveBudgetTargetContext, resolveStatusActionIntent } from '../services/actionExecutorService.js'

describe('actionExecutorService status intent', () => {
  it('campaign 规则应将 pause_ad 解释为 campaign 级暂停', () => {
    const intent = resolveStatusActionIntent(
      { targetLevel: 'campaign' },
      { type: 'pause_ad' },
      { campaign_id: 'cmp_1', campaign_name: 'C1' }
    )
    expect(intent.resolvedStatusTargetLevel).toBe('campaign')
    expect(intent.resolvedStatusOp).toBe('pause')
    expect(intent.resolvedObjectId).toBe('cmp_1')
    expect(intent.resolvedObjectName).toBe('C1')
  })

  it('adset 规则应将 activate_ad 解释为 adset 级激活', () => {
    const intent = resolveStatusActionIntent(
      { target_level: 'adset' },
      { type: 'activate_ad' },
      { ad_set_id: 'as_1', adset_name: 'AS-1' }
    )
    expect(intent.resolvedStatusTargetLevel).toBe('adset')
    expect(intent.resolvedStatusOp).toBe('activate')
    expect(intent.resolvedObjectId).toBe('as_1')
    expect(intent.resolvedObjectName).toBe('AS-1')
  })
})

describe('computeDynamicBudgetCents', () => {
  it('应按指标 × 倍率计算美分并应用上下限', () => {
    const result = computeDynamicBudgetCents(
      { purchases: 3 },
      { type: 'set_dynamic_budget', metric: 'purchases', multiplier: 30 }
    )
    expect(result.ok).toBe(true)
    expect(result.finalBudgetCents).toBe(9000)

    const minResult = computeDynamicBudgetCents(
      { purchases: 3 },
      { type: 'set_dynamic_budget', metric: 'purchases', multiplier: 30, min_daily_budget: 10000 }
    )
    expect(minResult.finalBudgetCents).toBe(10000)

    const maxResult = computeDynamicBudgetCents(
      { purchases: 3 },
      { type: 'set_dynamic_budget', metric: 'purchases', multiplier: 30, max_daily_budget: 8000 }
    )
    expect(maxResult.finalBudgetCents).toBe(8000)
  })

  it('指标为 null 或非正数时应返回跳过原因', () => {
    const nullResult = computeDynamicBudgetCents(
      { purchases_avg_after_create: null },
      { type: 'set_dynamic_budget', metric: 'purchases_avg_after_create', multiplier: 30 }
    )
    expect(nullResult.ok).toBe(false)
    expect(nullResult.reason).toBe('dynamic_metric_missing')

    const zeroResult = computeDynamicBudgetCents(
      { purchases: 0 },
      { type: 'set_dynamic_budget', metric: 'purchases', multiplier: 30 }
    )
    expect(zeroResult.ok).toBe(false)
    expect(zeroResult.reason).toBe('dynamic_metric_invalid')
  })
})

describe('resolveBudgetTargetContext', () => {
  it('campaign 层 CBO 应路由到广告系列预算', async () => {
    const api = {
      getCampaignBudgetDetail: async () => ({ daily_budget: 2000, lifetime_budget: 0 }),
      getAdsetBudgetDetail: async () => {
        throw new Error('不应查询广告组预算')
      }
    }

    const result = await resolveBudgetTargetContext(
      { targetLevel: 'campaign' },
      { objectId: 'cmp_1', aggregationTrace: { children: [{ adsetId: 'as_1' }] } },
      api
    )

    expect(result.ok).toBe(true)
    expect(result.budgetNodeType).toBe('campaign')
    expect(result.budgetNodeId).toBe('cmp_1')
    expect(result.currentCents).toBe(2000)
    expect(result.cooldownKey).toBe('budget_campaign:cmp_1')
  })

  it('campaign 层 ABO 且只有一个子广告组时应路由到该广告组预算', async () => {
    const api = {
      getCampaignBudgetDetail: async () => ({ daily_budget: 0, lifetime_budget: 0 }),
      getAdsetBudgetDetail: async (adsetId) => {
        expect(adsetId).toBe('as_1')
        return { daily_budget: 500, lifetime_budget: 0 }
      }
    }

    const result = await resolveBudgetTargetContext(
      { targetLevel: 'campaign' },
      { objectId: 'cmp_1', aggregationTrace: { children: [{ adsetId: 'as_1' }, { adsetId: 'as_1' }] } },
      api
    )

    expect(result.ok).toBe(true)
    expect(result.budgetNodeType).toBe('adset')
    expect(result.budgetNodeId).toBe('as_1')
    expect(result.currentCents).toBe(500)
    expect(result.cooldownKey).toBe('budget_adset:as_1')
  })

  it('campaign 层 ABO 且存在多个子广告组时应安全跳过', async () => {
    const api = {
      getCampaignBudgetDetail: async () => ({ daily_budget: 0, lifetime_budget: 0 }),
      getAdsetBudgetDetail: async () => {
        throw new Error('多广告组 ABO 不应任选一个广告组')
      }
    }

    const result = await resolveBudgetTargetContext(
      { targetLevel: 'campaign' },
      { objectId: 'cmp_1', aggregationTrace: { children: [{ adsetId: 'as_1' }, { adsetId: 'as_2' }] } },
      api
    )

    expect(result.ok).toBe(false)
    expect(result.severity).toBe('skipped')
    expect(result.reason).toBe('campaign_abo_multiple_adsets_requires_adset_level')
    expect(result.cooldownKey).toBe('budget_campaign:cmp_1')
  })
})
