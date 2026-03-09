import { describe, it, expect } from 'vitest'
import { _internals } from '../services/dynamicScopeService.js'

describe('DynamicScopeService helpers', () => {
  it('getRuleTargetAccountIds 优先使用 target_by_account 的非空账户', () => {
    const rule = {
      account_id: 'act_primary',
      target_account_ids: JSON.stringify(['act_primary', 'act_secondary']),
      target_by_account: JSON.stringify({
        act_secondary: ['1201'],
        act_third: []
      })
    }

    const accountIds = _internals.getRuleTargetAccountIds(rule)
    expect(accountIds).toEqual(['act_secondary'])
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

