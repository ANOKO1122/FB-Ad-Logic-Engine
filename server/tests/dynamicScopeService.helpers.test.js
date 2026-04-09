import { describe, it, expect } from 'vitest'
import { _internals, previewDynamicScope } from '../services/dynamicScopeService.js'

describe('DynamicScopeService helpers', () => {
  it('getRuleTargetAccountIds 合并 target_by_account 非空 key 与 target_account_ids、account_id', () => {
    const rule = {
      account_id: 'act_primary',
      target_account_ids: JSON.stringify(['act_primary', 'act_secondary']),
      target_by_account: JSON.stringify({
        act_secondary: ['1201'],
        act_third: []
      })
    }

    const accountIds = _internals.getRuleTargetAccountIds(rule)
    expect(accountIds).toEqual(['act_primary', 'act_secondary'])
  })

  it('getRuleTargetAccountIds 在仅 target_account_ids 含某户且该户不在 target_by_account keys 时仍包含该户', () => {
    const rule = {
      account_id: 'act_old',
      target_account_ids: ['act_832525359903650', 'act_old'],
      target_by_account: JSON.stringify({
        act_old: ['ad_1']
      })
    }
    expect(_internals.getRuleTargetAccountIds(rule)).toEqual([
      'act_832525359903650',
      'act_old'
    ])
  })

  it('getRuleTargetAccountIds 对 act_act_ 形式做归一化去重', () => {
    const rule = {
      account_id: 'act_act_999',
      target_account_ids: ['act_999']
    }
    expect(_internals.getRuleTargetAccountIds(rule)).toEqual(['act_999'])
  })

  it('getRuleTargetAccountIds 在无 target_by_account 时回退 target_account_ids', () => {
    const rule = {
      account_id: 'act_primary',
      target_account_ids: ['act_primary', 'act_secondary']
    }

    const accountIds = _internals.getRuleTargetAccountIds(rule)
    expect(accountIds).toEqual(['act_primary', 'act_secondary'])
  })

  it('getScopedTargetIdsForAccount 能正确解析 act:id 并隔离到账户', () => {
    const rule = {
      target_ids: ['act_a:ad_1', 'act_b:ad_2', 'ad_legacy']
    }

    const aIds = _internals.getScopedTargetIdsForAccount(rule, 'act_a')
    const bIds = _internals.getScopedTargetIdsForAccount(rule, 'act_b')

    expect(aIds).toEqual(['ad_1'])
    expect(bIds).toEqual(['ad_2'])
  })
})

describe('previewDynamicScope', () => {
  it('returns object_ids, count and optional per_account; invalid scopeFilters yield per_account error', async () => {
    const result = await previewDynamicScope(['act_123'], {
      scopeFilters: {},
      excludeIds: null,
      targetLevel: 'ad'
    })
    expect(result).toHaveProperty('object_ids')
    expect(result).toHaveProperty('count')
    expect(Array.isArray(result.object_ids)).toBe(true)
    expect(result.count).toBe(result.object_ids.length)
    expect(result.object_ids).toHaveLength(0)
    expect(result.per_account).toBeDefined()
    expect(result.per_account.act_123).toBeDefined()
    expect(result.per_account.act_123.status).toBe('ERROR_FILTER_INVALID')
    expect(result.per_account.act_123.errorMsg).toBeDefined()
  })

  it('normalizes accountIds and excludeIds; object_ids items are act_xxx:id when present', async () => {
    const result = await previewDynamicScope('act_a, act_b', {
      scopeFilters: {},
      excludeIds: { ad_ids: [], adset_ids: [], campaign_ids: [] }
    })
    expect(result.object_ids).toHaveLength(0)
    expect(result.count).toBe(0)
    expect(result.per_account).toBeDefined()
    expect(Object.keys(result.per_account)).toContain('act_a')
    expect(Object.keys(result.per_account)).toContain('act_b')
    result.object_ids.forEach((id) => expect(id).toMatch(/^act_\d+:\d+$/))
  })
})
