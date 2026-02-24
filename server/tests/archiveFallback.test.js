import { describe, it, expect, vi, beforeEach } from 'vitest'

// 这个测试专门验证：
// - archiveDailyStats 在 ROW_NUMBER() 不可用时，会走 queryLastSnapshotCompatible
// - 当 data_date 查不到数据时，会走 synced_at 兜底，并带 compat meta（mode/ads）
// - 同时会输出 warn 日志（用于长期观测）

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

// 重要：先 mock，再 import 目标模块（ESM 下需要在 import 前完成 mock）
vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

// mock 数据库连接池
const mockExecute = vi.fn()
vi.mock('../db/connection.js', () => ({
  default: {
    execute: mockExecute
  }
}))

describe('archiveDailyStats 回退口径对齐', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('data_date 优先命中时返回 compat meta= data_date，且不触发 synced_at 兜底 warn', async () => {
    const { archiveDailyStats } = await import('../services/ingestorService.js')

    // 1) 主查询 ROW_NUMBER() 抛错 → 触发回退
    // 2) 回退第一步 data_date 查询返回 2 行（同一广告同一 synced_at 并列），应按 id 取最大并去重为 1 行
    // 3) INSERT daily_stats 返回 affectedRows
    mockExecute
      .mockRejectedValueOnce(new Error('ROW_NUMBER() is not supported')) // 主查询抛错，触发兼容
      .mockResolvedValueOnce([[{
        id: 1,
        account_id: 'act_test',
        ad_id: 'ad_1',
        ad_name: 'ad',
        ad_set_id: null,
        owner_id: 1,
        spend: 10,
        purchases: 1,
        link_clicks: 5,
        unique_link_clicks: 3,
        purchase_value: 20,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0,
        ucpc: null,
        cpa: null,
        actions: null
      }, {
        id: 2, // 并列时取更大的 id
        account_id: 'act_test',
        ad_id: 'ad_1',
        ad_name: 'ad',
        ad_set_id: null,
        owner_id: 1,
        spend: 11,
        purchases: 1,
        link_clicks: 5,
        unique_link_clicks: 3,
        purchase_value: 20,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0,
        ucpc: null,
        cpa: null,
        actions: null
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // 写 daily_stats

    const res = await archiveDailyStats(null, 'UTC', new Date('2026-02-11T00:00:00.000Z'))

    expect(res.success).toBe(true)
    expect(res.compat).toBeTruthy()
    expect(res.compat.mode).toBe('data_date')
    expect(res.compat.ads).toBe(1) // 去重后为 1 条广告

    const warnCalls = mockLogger.warn.mock.calls.map(c => String(c[0]))
    expect(warnCalls.some(s => s.includes('非标准口径兜底'))).toBe(false)
  })

  it('data_date 为空时使用 synced_at 兜底，并返回 compat meta + 打 warn', async () => {
    // 动态 import：确保拿到被 mock 后的实现
    const { archiveDailyStats } = await import('../services/ingestorService.js')

    // 调用序列（最小闭环）：
    // 1) 主查询 ROW_NUMBER() 抛错 → 触发回退
    // 2) 回退第一步 data_date 查询返回空
    // 3) 回退第二步 synced_at 查询返回 1 行
    // 4) INSERT daily_stats 返回 affectedRows
    mockExecute
      .mockRejectedValueOnce(new Error('ROW_NUMBER() is not supported')) // 主查询抛错，触发兼容
      .mockResolvedValueOnce([[]]) // data_date 优先：空
      .mockResolvedValueOnce([[{
        id: 1,
        account_id: 'act_test',
        ad_id: 'ad_1',
        ad_name: 'ad',
        ad_set_id: null,
        owner_id: 1,
        spend: 10,
        purchases: 1,
        link_clicks: 5,
        unique_link_clicks: 3,
        purchase_value: 20,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0,
        ucpc: null,
        cpa: null,
        actions: null
      }]]) // synced_at 兜底：1 行
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // 写 daily_stats

    const res = await archiveDailyStats(null, 'UTC', new Date('2026-02-11T00:00:00.000Z'))

    expect(res.success).toBe(true)
    expect(res.compat).toBeTruthy()
    expect(res.compat.mode).toBe('synced_at')
    expect(res.compat.ads).toBe(1)

    // warn 日志必须出现（包含关键标识）
    const warnCalls = mockLogger.warn.mock.calls.map(c => String(c[0]))
    expect(warnCalls.some(s => s.includes('[兼容归档]') && s.includes('synced_at') && s.includes('ads=1'))).toBe(true)
  })
})

