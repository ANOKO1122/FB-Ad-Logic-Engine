import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockPauseAd,
  mockPoolExecute,
  mockInsertValues,
  mockLogger
} = vi.hoisted(() => ({
  mockPauseAd: vi.fn(),
  mockPoolExecute: vi.fn(),
  mockInsertValues: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

vi.mock('../index.js', () => {
  process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'fake-token-for-test'
  return {
    FacebookMarketingAPI: vi.fn().mockImplementation(function () {
      return {
        pauseAd: mockPauseAd
      }
    })
  }
})

vi.mock('../db/drizzle.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues
    })
  }
}))

vi.mock('../db/schema.js', () => ({ automationLogs: {} }))
vi.mock('../db/connection.js', () => ({
  default: {
    execute: mockPoolExecute
  }
}))

import { executeActionsForAd } from '../services/actionExecutorService.js'

describe('executeActionsForAd 审计日志结构化错误', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.FACEBOOK_ACCESS_TOKEN = 'fake-token-for-test'
    mockPauseAd.mockResolvedValue(undefined)
    mockPoolExecute.mockImplementation(async (sql) => {
      if (String(sql).includes('structure_sync_status')) {
        return [[{ last_heartbeat_data_update_at: new Date().toISOString() }]]
      }
      if (String(sql).includes('FROM ad_snapshots')) {
        return [[{ status: 'ACTIVE' }]]
      }
      return [[]]
    })
    mockInsertValues.mockRejectedValue({
      message: "Unknown column 'explanation' in 'field list'",
      code: 'ER_BAD_FIELD_ERROR',
      errno: 1054,
      sqlState: '42S22',
      sqlMessage: "Unknown column 'explanation' in 'field list'"
    })
  })

  it('审计写入失败时记录可定位的结构化字段', async () => {
    const result = await executeActionsForAd({
      rule: {
        id: 1202,
        ruleName: 'test-audit-log',
        targetLevel: 'ad',
        actions: [{ type: 'pause_ad' }],
        isSimulation: false
      },
      matchedAd: {
        ad_id: '12345',
        ad_name: 'ad-test',
        status: 'ACTIVE'
      },
      accountId: 'act_1',
      ownerId: 9,
      runId: 'run_1'
    })

    expect(result[0].status).toBe('success')
    const failureCall = mockLogger.error.mock.calls.find(([msg]) => msg === '⚠️ 写入审计日志失败')
    expect(failureCall).toBeTruthy()
    expect(failureCall[1]).toMatchObject({
      operation: 'automation_logs.insert',
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22'
    })
    expect(String(failureCall[1].sqlMessage || '')).toContain('explanation')
  })

  it('campaign 目标且 ad_id 为空时旧字段 adId 应写入空字符串', async () => {
    mockInsertValues.mockResolvedValue([{ insertId: 1 }])

    await executeActionsForAd({
      rule: {
        id: 1203,
        ruleName: 'test-campaign-audit-adid-fallback',
        targetLevel: 'campaign',
        actions: [{ type: 'pause_ad' }],
        isSimulation: true
      },
      matchedAd: {
        ad_id: null,
        ad_name: null,
        objectType: 'campaign',
        objectId: 'cmp_123',
        objectName: 'Campaign X',
        campaign_id: 'cmp_123',
        status: 'ACTIVE'
      },
      accountId: 'act_2',
      ownerId: 9,
      runId: 'run_2'
    })

    expect(mockInsertValues).toHaveBeenCalled()
    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.adId).toBe('')
    expect(payload.objectType).toBe('campaign')
    expect(payload.objectId).toBe('cmp_123')
  })
})

