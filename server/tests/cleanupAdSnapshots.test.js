/**
 * TASKS §1.7 热表清理测试
 * 验证 cleanupAdSnapshots 只删除 synced_at < NOW() - 2 DAY 的记录，
 * 不影响昨日真空期兜底查询（保留最近 2 天数据）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

const mockExecute = vi.fn()

vi.mock('../db/connection.js', () => ({
  default: {
    execute: mockExecute,
    query: vi.fn(),
    getConnection: vi.fn()
  }
}))

describe('cleanupAdSnapshots 热表清理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应执行 DELETE 且条件为 synced_at < NOW() - INTERVAL 2 DAY', async () => {
    const { cleanupAdSnapshots } = await import('../services/ingestorService.js')

    mockExecute.mockResolvedValue([{ affectedRows: 10 }])

    const result = await cleanupAdSnapshots()

    expect(result.success).toBe(true)
    expect(result.deleted).toBe(10)
    expect(mockExecute).toHaveBeenCalledTimes(1)
    const [sql] = mockExecute.mock.calls[0]
    expect(String(sql)).toContain('DELETE FROM ad_snapshots')
    expect(String(sql)).toContain('synced_at < NOW() - INTERVAL 2 DAY')
  })

  it('无匹配记录时应返回 deleted=0', async () => {
    const { cleanupAdSnapshots } = await import('../services/ingestorService.js')

    mockExecute.mockResolvedValue([{ affectedRows: 0 }])

    const result = await cleanupAdSnapshots()

    expect(result.success).toBe(true)
    expect(result.deleted).toBe(0)
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it('执行失败时应返回 success=false 并记录 error', async () => {
    const { cleanupAdSnapshots } = await import('../services/ingestorService.js')

    mockExecute.mockRejectedValue(new Error('DB connection failed'))

    const result = await cleanupAdSnapshots()

    expect(result.success).toBe(false)
    expect(result.deleted).toBe(0)
    expect(result.error).toBe('DB connection failed')
    expect(mockLogger.error).toHaveBeenCalled()
  })
})
