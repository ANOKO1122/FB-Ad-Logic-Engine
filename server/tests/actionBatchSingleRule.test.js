import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  mockBatchRequests,
  mockPauseAd,
  mockActivateAd
} = vi.hoisted(() => ({
  mockBatchRequests: vi.fn(),
  mockPauseAd: vi.fn(),
  mockActivateAd: vi.fn()
}))

vi.mock('../index.js', () => {
  process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'fake-token-for-test'
  return {
    FacebookMarketingAPI: vi.fn().mockImplementation(function () {
      return {
        batchRequests: mockBatchRequests,
        pauseAd: mockPauseAd,
        activateAd: mockActivateAd
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

import { executeActionsForRule } from '../services/actionExecutorService.js'

describe('优化一：单规则状态动作 Batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.FACEBOOK_ACCESS_TOKEN = 'fake-token-for-test'
    process.env.ENABLE_ACTION_BATCH = '1'
  })

  it('手动单规则 pause_ad 命中 2 个广告时走 actions_batch', async () => {
    mockBatchRequests.mockResolvedValueOnce([
      { code: 200, body: { success: true }, raw: { code: 200 } },
      { code: 200, body: { success: true }, raw: { code: 200 } }
    ])

    const rule = {
      id: 101,
      ruleName: 'manual-batch-pause',
      actions: [{ type: 'pause_ad' }],
      isSimulation: false
    }
    const matchedAds = [
      { ad_id: '1201', ad_name: 'ad-1', status: 'ACTIVE' },
      { ad_id: '1202', ad_name: 'ad-2', status: 'ACTIVE' }
    ]

    const result = await executeActionsForRule({
      rule,
      matchedAds,
      accountId: 'act_999',
      ownerId: 1,
      runId: 'run-batch-1'
    })

    expect(mockBatchRequests).toHaveBeenCalledTimes(1)
    const [requests, options] = mockBatchRequests.mock.calls[0]
    expect(options).toEqual({ priority: 'action', label: 'actions_batch' })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual({
      method: 'POST',
      relative_url: '1201',
      body: 'status=PAUSED'
    })
    expect(requests[1]).toEqual({
      method: 'POST',
      relative_url: '1202',
      body: 'status=PAUSED'
    })

    expect(mockPauseAd).not.toHaveBeenCalled()
    expect(result.successCount).toBe(2)
    expect(result.failCount).toBe(0)
    expect(result.skippedCount).toBe(0)
  })

  it('pre-flight 已达成的广告跳过，其余广告进入 batch', async () => {
    mockBatchRequests.mockResolvedValueOnce([
      { code: 200, body: { success: true }, raw: { code: 200 } }
    ])

    const rule = {
      id: 102,
      ruleName: 'manual-batch-partial',
      actions: [{ type: 'pause_ad' }],
      isSimulation: false
    }
    const matchedAds = [
      { ad_id: '2201', ad_name: 'ad-paused', status: 'PAUSED' },
      { ad_id: '2202', ad_name: 'ad-active', status: 'ACTIVE' }
    ]

    const result = await executeActionsForRule({
      rule,
      matchedAds,
      accountId: 'act_888',
      ownerId: 2,
      runId: 'run-batch-2'
    })

    expect(mockBatchRequests).toHaveBeenCalledTimes(1)
    const [requests] = mockBatchRequests.mock.calls[0]
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      method: 'POST',
      relative_url: '2202',
      body: 'status=PAUSED'
    })

    expect(result.successCount).toBe(1)
    expect(result.failCount).toBe(0)
    expect(result.skippedCount).toBe(1)
  })
})
