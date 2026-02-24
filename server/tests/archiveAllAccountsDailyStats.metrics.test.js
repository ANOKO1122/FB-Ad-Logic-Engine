import { describe, it, expect, vi, beforeEach } from 'vitest'

// 覆盖点：
// - archiveAllAccountsDailyStats 汇总日志应输出“回退观测”
// - 当子任务返回 result.compat.mode = 'synced_at' 时，统计应累加 syncedAtFallbackAccounts/Ads

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

const mockExecute = vi.fn()
const mockQuery = vi.fn()
const mockGetConnection = vi.fn()

vi.mock('../db/connection.js', () => ({
  default: {
    execute: mockExecute,
    query: mockQuery,
    getConnection: mockGetConnection
  }
}))

describe('archiveAllAccountsDailyStats 回退观测汇总', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应统计兼容方案账户数与 synced_at 兜底广告数', async () => {
    // 避免 archiveDailyStats 在测试里触发 FB API yesterday 拉取
    const prevToken = process.env.FACEBOOK_ACCESS_TOKEN
    process.env.FACEBOOK_ACCESS_TOKEN = ''

    const mod = await import('../services/ingestorService.js')

    // 2 个账户，强制归档（forceAll=true）
    mockQuery.mockResolvedValueOnce([[
      { account_id: 'act_a', owner_id: 1, timezone_name: 'Asia/Shanghai' },
      { account_id: 'act_b', owner_id: 2, timezone_name: 'Asia/Shanghai' }
    ]])

    // DB 锁连接（并发安全）
    const makeConn = () => ({
      execute: vi.fn(async (sql) => {
        const s = String(sql)
        if (s.includes('GET_LOCK')) return [[{ acquired: 1 }]]
        if (s.includes('RELEASE_LOCK')) return [[{ released: 1 }]]
        throw new Error(`unexpected conn execute sql: ${s}`)
      }),
      release: vi.fn()
    })
    mockGetConnection.mockImplementation(async () => makeConn())

    const makeSnapshotRow = (accountId) => ({
      id: 1,
      account_id: accountId,
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
    })

    // 让两个账户都走“兼容方案”（ROW_NUMBER 不可用），其中：
    // - act_a：data_date 查不到 → synced_at 兜底（ads=1）
    // - act_b：data_date 命中 → data_date 模式（ads=1）
    mockExecute.mockImplementation(async (sql, params = []) => {
      const s = String(sql)
      const ps = Array.isArray(params) ? params : []
      const accountId = ps.find(v => typeof v === 'string' && v.startsWith('act_')) || null

      // 完整性检查
      if (s.includes('COUNT(DISTINCT ad_id)') && s.includes('FROM ad_snapshots')) return [[{ cnt: 1 }]]
      if (s.includes('COUNT(DISTINCT ad_id)') && s.includes('FROM daily_stats')) return [[{ cnt: 0 }]]

      // 主路径：强制触发兼容方案
      if (s.includes('ROW_NUMBER() OVER')) throw new Error('ROW_NUMBER() is not supported')

      // 兼容方案：data_date 优先（queryDataDate）
      if (s.includes('WHERE data_date = ?') && s.includes('MAX(synced_at) AS last_synced_at') && s.includes('WHERE s.data_date = ?')) {
        if (accountId === 'act_a') return [[]] // act_a：data_date 真空
        return [[makeSnapshotRow(accountId)]] // act_b：命中
      }

      // 兼容方案：synced_at 兜底（queryRange）
      if (s.includes('WHERE synced_at >= ?') && s.includes('MAX(synced_at) AS last_synced_at') && s.includes('WHERE s.synced_at >= ?')) {
        if (accountId === 'act_a') return [[makeSnapshotRow(accountId)]]
        return [[]]
      }

      // 写入 daily_stats
      if (s.includes('INSERT INTO daily_stats')) return [{ affectedRows: 1 }]

      throw new Error(`unexpected execute sql: ${s}`)
    })

    const res = await mod.archiveAllAccountsDailyStats(null, true)
    expect(res.success).toBe(true)
    expect(res.archivedAccounts).toBe(2)

    // 汇总日志应包含回退观测 + synced_at 兜底计数
    const infoText = mockLogger.info.mock.calls.map(c => String(c[0])).join('\n')
    expect(infoText.includes('📊 回退观测:')).toBe(true)
    expect(infoText.includes('兼容方案账户（ROW_NUMBER 不可用）: 2 个')).toBe(true)
    expect(infoText.includes('synced_at 兜底账户（非标准口径）: 1 个')).toBe(true)
    expect(infoText.includes('synced_at 兜底广告数: 1 条')).toBe(true)

    // 恢复环境变量
    process.env.FACEBOOK_ACCESS_TOKEN = prevToken
  })
})

