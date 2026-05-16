import { describe, expect, it } from 'vitest'
import { deriveSummaryStatus } from '../services/cronService.js'

describe('deriveSummaryStatus', () => {
  it('matchedCount=0 时返回 no_match', () => {
    const result = deriveSummaryStatus({
      matchedCount: 0,
      executedCount: 0,
      failedCount: 0,
      skippedCount: 0
    })
    expect(result).toEqual({ status: 'no_match', skipReason: 'no_match' })
  })

  it('有命中且仅 skipped 时返回 skipped + preflight_all_skipped', () => {
    const result = deriveSummaryStatus({
      matchedCount: 3,
      executedCount: 0,
      failedCount: 0,
      skippedCount: 3
    })
    expect(result).toEqual({ status: 'skipped', skipReason: 'preflight_all_skipped' })
  })

  it('有命中且有执行/失败时返回 matched', () => {
    const result = deriveSummaryStatus({
      matchedCount: 1,
      executedCount: 1,
      failedCount: 0,
      skippedCount: 0
    })
    expect(result).toEqual({ status: 'matched', skipReason: null })
  })
})
