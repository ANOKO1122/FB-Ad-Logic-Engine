/**
 * TASKS §1.6 归档状态表测试
 * 验证 daily_archive_status 驱动下：
 * - 不重复归档同一 (account_id, target_date)
 * - 失败后可重试补齐
 * - 跨时区账户互不影响
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DateTime } from 'luxon'

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

const mockExecute = vi.fn()
const mockGetConnection = vi.fn()

vi.mock('../db/connection.js', () => ({
  default: {
    execute: mockExecute,
    getConnection: mockGetConnection,
    query: vi.fn()
  }
}))

// 用于捕获 connection.execute 的调用（INSERT daily_archive_status）
const connExecuteCalls = []

function makeConn() {
  connExecuteCalls.length = 0
  return {
    execute: vi.fn(async (sql) => {
      connExecuteCalls.push({ sql: String(sql) })
      if (String(sql).includes('GET_LOCK')) return [[{ acquired: 1 }]]
      if (String(sql).includes('RELEASE_LOCK')) return [[{ released: 1 }]]
      if (String(sql).includes('INSERT INTO daily_archive_status')) return [{ affectedRows: 1 }]
      throw new Error(`unexpected conn.execute: ${sql}`)
    }),
    release: vi.fn()
  }
}

describe('daily_archive_status 状态表驱动', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connExecuteCalls.length = 0
    mockGetConnection.mockImplementation(async () => makeConn())
  })

  it('status=ARCHIVED 且 hour>=2 时跳过初步归档，不调用 executeArchive', async () => {
    const { checkAndExecuteArchive } = await import('../services/ingestorService.js')

    mockExecute.mockResolvedValue([[{ status: 'ARCHIVED' }]])

    const localTime = DateTime.fromObject(
      { year: 2026, month: 2, day: 12, hour: 3, minute: 0 },
      { zone: 'Asia/Shanghai' }
    )
    const res = await checkAndExecuteArchive('act_test', 1, 'Asia/Shanghai', localTime)

    expect(res.archived).toBe(false)
    expect(res.finalized).toBe(false)
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('status=FINALIZED 且 hour>=12 时跳过深度对账，不调用 executeArchive', async () => {
    const { checkAndExecuteArchive } = await import('../services/ingestorService.js')

    mockExecute.mockResolvedValue([[{ status: 'FINALIZED' }]])

    const localTime = DateTime.fromObject(
      { year: 2026, month: 2, day: 12, hour: 14, minute: 0 },
      { zone: 'Asia/Shanghai' }
    )
    const res = await checkAndExecuteArchive('act_test', 1, 'Asia/Shanghai', localTime)

    expect(res.archived).toBe(false)
    expect(res.finalized).toBe(false)
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('status=null 且 hour>=2 时执行初步归档，调用 executeArchive', async () => {
    const prevToken = process.env.FACEBOOK_ACCESS_TOKEN
    process.env.FACEBOOK_ACCESS_TOKEN = ''

    const { checkAndExecuteArchive } = await import('../services/ingestorService.js')

    const makeSnapshotRow = () => ({
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
    })

    mockExecute.mockImplementation(async (sql, params = []) => {
      const s = String(sql)
      if (s.includes('SELECT status FROM daily_archive_status')) return [[]]
      if (s.includes('ROW_NUMBER() OVER') || s.includes('WHERE data_date = ?')) return [[makeSnapshotRow()]]
      if (s.includes('INSERT INTO daily_stats')) return [{ affectedRows: 1 }]
      throw new Error(`unexpected execute: ${s.slice(0, 120)}`)
    })

    const localTime = DateTime.fromObject(
      { year: 2026, month: 2, day: 12, hour: 3, minute: 0 },
      { zone: 'Asia/Shanghai' }
    )
    const res = await checkAndExecuteArchive('act_test', 1, 'Asia/Shanghai', localTime)

    expect(res.archived).toBe(true)
    expect(mockGetConnection).toHaveBeenCalled()
    const insertCalls = connExecuteCalls.filter(c => c.sql.includes('INSERT INTO daily_archive_status'))
    expect(insertCalls.length).toBeGreaterThanOrEqual(1)

    process.env.FACEBOOK_ACCESS_TOKEN = prevToken
  })

  it('跨时区时各账户使用各自的 targetDateStr，互不干扰', async () => {
    const { checkAndExecuteArchive, getArchiveStatus } = await import('../services/ingestorService.js')

    mockExecute.mockImplementation(async (sql, params = []) => {
      const s = String(sql)
      if (!s.includes('daily_archive_status')) return [[]]
      const accountId = params[0]
      const targetDate = params[1]
      if (accountId === 'act_shanghai' && targetDate === '2026-02-11') return [[{ status: 'FINALIZED' }]]
      if (accountId === 'act_newyork' && targetDate === '2026-02-10') return [[{ status: 'FINALIZED' }]]
      return [[]]
    })

    // 同一 UTC 时刻：上海 09:00 Feb 12 → 昨日 2026-02-11；纽约 20:00 Feb 11 → 昨日 2026-02-10
    const shanghaiLocal = DateTime.fromObject(
      { year: 2026, month: 2, day: 12, hour: 9, minute: 0 },
      { zone: 'Asia/Shanghai' }
    )
    const nyLocal = DateTime.fromObject(
      { year: 2026, month: 2, day: 11, hour: 20, minute: 0 },
      { zone: 'America/New_York' }
    )

    const statusA = await getArchiveStatus('act_shanghai', '2026-02-11')
    const statusB = await getArchiveStatus('act_newyork', '2026-02-10')

    expect(statusA).toBe('FINALIZED')
    expect(statusB).toBe('FINALIZED')

    const resA = await checkAndExecuteArchive('act_shanghai', 1, 'Asia/Shanghai', shanghaiLocal)
    const resB = await checkAndExecuteArchive('act_newyork', 1, 'America/New_York', nyLocal)

    expect(resA.archived).toBe(false)
    expect(resB.archived).toBe(false)
    expect(resB.finalized).toBe(false)
    expect(mockGetConnection).not.toHaveBeenCalled()
  })
})
