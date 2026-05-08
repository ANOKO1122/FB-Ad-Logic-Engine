import { describe, it, expect } from 'vitest'
import { resolveStatusActionIntent } from '../services/actionExecutorService.js'

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
