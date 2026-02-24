/**
 * M4 3.3 Pre-Flight 检查 — Vitest 单元测试
 *
 * 【教学】Pre-Flight 是什么？
 * - 一句话比喻：像「起飞前检查」，在真正调用 FB API 之前，先用本地 status 判断目标是否已达成。
 * - 为什么要学：节省 API 调用配额、避免无意义操作、提升执行速度。
 * - 面试怎么问：「你们怎么避免重复暂停已经暂停的广告？」
 *   答：Pre-Flight 检查——执行前先看 ad_snapshots.status，目标已达成则 skip，不发 API。
 *
 * 验收标准：
 * 1. pause_ad 动作：若 matchedAd.status 为 PAUSED/DISABLED/ARCHIVED/DELETED，跳过不调 FB API
 * 2. activate_ad 动作：若 matchedAd.status 为 ACTIVE，跳过；若为 ARCHIVED/DELETED，跳过且记不可激活
 * 3. 其他状态正常调用 API
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted 让 mock 在 vi.mock 工厂执行前就存在
const { mockPauseAd, mockActivateAd, mockGetAdsetBudget, mockGetAdsetBudgetDetail, mockUpdateAdsetBudget } = vi.hoisted(() => ({
  mockPauseAd: vi.fn(),
  mockActivateAd: vi.fn(),
  mockGetAdsetBudget: vi.fn(),
  mockGetAdsetBudgetDetail: vi.fn(),
  mockUpdateAdsetBudget: vi.fn()
}))

vi.mock('../index.js', () => {
  process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'fake-token-for-test'
  return {
    FacebookMarketingAPI: vi.fn().mockImplementation(function () {
      return {
        pauseAd: mockPauseAd,
        activateAd: mockActivateAd,
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

// 被测模块在 mock 之后 import
import { executeActionsForAd } from '../services/actionExecutorService.js'

describe('M4 3.3 Pre-Flight 检查', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPauseAd.mockResolvedValue(true)
    mockActivateAd.mockResolvedValue(true)
    mockGetAdsetBudgetDetail.mockResolvedValue({ daily_budget: 1000, lifetime_budget: 0 })
    process.env.FACEBOOK_ACCESS_TOKEN = 'fake-token-for-test'
  })

  // ===== pause_ad Pre-Flight =====
  describe('pause_ad Pre-Flight', () => {
    const pauseRule = {
      id: 1,
      ruleName: 'test-pause',
      actions: [{ type: 'pause_ad' }],
      isSimulation: false
    }

    it('广告已 PAUSED 时跳过，不调用 pauseAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'PAUSED' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('广告已 DISABLED 时跳过，不调用 pauseAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'DISABLED' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('广告已 ARCHIVED 时跳过，不调用 pauseAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ARCHIVED' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('广告已 DELETED 时跳过，不调用 pauseAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'DELETED' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('广告为 ACTIVE 时正常调用 pauseAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ACTIVE' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).toHaveBeenCalledTimes(1)
      expect(mockPauseAd).toHaveBeenCalledWith('123')
      expect(results[0].status).toBe('success')
    })

    it('FB API 返回 already 错误时记 skipped（容错）', async () => {
      mockPauseAd.mockRejectedValueOnce(new Error('This ad is already paused'))
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ACTIVE' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).toHaveBeenCalledTimes(1)
      expect(results[0].status).toBe('skipped')
      expect(results[0].errorMessage).toContain('already')
    })
  })

  // ===== activate_ad Pre-Flight =====
  describe('activate_ad Pre-Flight', () => {
    const activateRule = {
      id: 2,
      ruleName: 'test-activate',
      actions: [{ type: 'activate_ad' }],
      isSimulation: false
    }

    it('广告已 ACTIVE 时跳过，不调用 activateAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ACTIVE' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('广告为 ARCHIVED 时跳过且记不可激活', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ARCHIVED' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
      expect(results[0].errorMessage).toContain('不可激活')
    })

    it('广告为 DELETED 时跳过且记不可激活', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'DELETED' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
      expect(results[0].errorMessage).toContain('不可激活')
    })

    it('广告为 PAUSED 时正常调用 activateAd API', async () => {
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'PAUSED' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).toHaveBeenCalledTimes(1)
      expect(mockActivateAd).toHaveBeenCalledWith('123')
      expect(results[0].status).toBe('success')
    })

    it('FB API 返回 already 错误时记 skipped（容错）', async () => {
      mockActivateAd.mockRejectedValueOnce(new Error('This ad is already active'))
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'PAUSED' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).toHaveBeenCalledTimes(1)
      expect(results[0].status).toBe('skipped')
      expect(results[0].errorMessage).toContain('already')
    })
  })

  // ===== Dry Run 模式下 Pre-Flight 同样生效 =====
  describe('Dry Run 模式 Pre-Flight', () => {
    it('Dry Run 模式下 pause_ad 对已 PAUSED 广告也跳过', async () => {
      const pauseRule = {
        id: 1,
        ruleName: 'test-pause-dryrun',
        actions: [{ type: 'pause_ad' }],
        isSimulation: true
      }
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'PAUSED' }
      const results = await executeActionsForAd({
        rule: pauseRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockPauseAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })

    it('Dry Run 模式下 activate_ad 对已 ACTIVE 广告也跳过', async () => {
      const activateRule = {
        id: 2,
        ruleName: 'test-activate-dryrun',
        actions: [{ type: 'activate_ad' }],
        isSimulation: true
      }
      const matchedAd = { ad_id: '123', ad_name: 'test', status: 'ACTIVE' }
      const results = await executeActionsForAd({
        rule: activateRule,
        matchedAd,
        accountId: 'act_123',
        ownerId: 1
      })
      expect(mockActivateAd).not.toHaveBeenCalled()
      expect(results[0].status).toBe('skipped')
    })
  })
})
