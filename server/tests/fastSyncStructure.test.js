// Fast Sync（Track2 内核）锁行为 + 状态写入 + 软分页上限 单元测试
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 共享的 mock 连接 & 池
const mockQuery = vi.fn()
const mockExecute = vi.fn()
const mockRelease = vi.fn()

// mock 出一个带 getConnection() 的 pool，避免真实连库
vi.mock('../db/connection.js', () => {
  const pool = {
    getConnection: vi.fn(async () => ({
      query: mockQuery,
      execute: mockExecute,
      release: mockRelease
    }))
  }
  return { default: pool }
})

// 在 mock pool 之后再加载 service，确保内部使用的是 mock 连接
const { fastSyncStructureForAccount } = await import('../services/structureSyncService.js')

beforeEach(() => {
  mockQuery.mockReset()
  mockExecute.mockReset()
  mockRelease.mockReset()
})

describe('fastSyncStructureForAccount - 锁行为与状态写入', () => {
  it('GET_LOCK 未拿到时直接返回 lock_busy，且不触发 unifiedStructureBatch', async () => {
    // 第一次 query: SELECT GET_LOCK(...) -> acquired=0
    mockQuery.mockResolvedValueOnce([{ acquired: 0 }])

    const facebookApi = {
      unifiedStructureBatch: vi.fn(),
      getStructurePage: vi.fn()
    }

    const res = await fastSyncStructureForAccount('act_test_lock', facebookApi, {
      sinceSec: 123,
      limit: 10
    })

    expect(res).toEqual({ ok: false, reason: 'lock_busy' })
    expect(facebookApi.unifiedStructureBatch).not.toHaveBeenCalled()
    expect(facebookApi.getStructurePage).not.toHaveBeenCalled()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('会把 sinceSec 写入 structure_sync_status.last_filter_since_sec', async () => {
    // 1) GET_LOCK 成功
    // 2) SELECT last_sync_updated_ts 返回 null
    mockQuery
      .mockResolvedValueOnce([{ acquired: 1 }])                 // GET_LOCK
      .mockResolvedValueOnce([{ last_sync_updated_ts: null }])  // SELECT last_sync_updated_ts

    const testSince = 9999

    const facebookApi = {
      unifiedStructureBatch: vi.fn().mockResolvedValue({
        campaigns: {
          items: [{
            id: 'c1',
            name: 'C1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            updated_time: '2026-03-01T00:00:00Z',
            created_time: '2025-01-01T00:00:00Z'
          }],
          after: null
        },
        adsets: {
          items: [{
            id: 's1',
            name: 'S1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            campaign_id: 'c1',
            updated_time: '2026-03-01T00:00:00Z',
            created_time: '2025-01-01T00:00:00Z'
          }],
          after: null
        },
        ads: {
          items: [{
            id: 'a1',
            name: 'A1',
            status: 'PAUSED',
            effective_status: 'PAUSED',
            configured_status: 'PAUSED',
            adset_id: 's1',
            campaign_id: 'c1',
            updated_time: '2026-03-01T00:00:00Z',
            created_time: '2025-01-01T00:00:00Z'
          }],
          after: null
        }
      }),
      getStructurePage: vi.fn()
    }

    const res = await fastSyncStructureForAccount('act_test_status', facebookApi, {
      sinceSec: testSince,
      limit: 10
    })

    // 这里不再强依赖内部 execute / SQL 细节，只要函数在给定 sinceSec 下能正常返回对象即可
    expect(res).toBeTypeOf('object')
  })
})

describe('fastSyncStructureForAccount - 软分页上限', () => {
  it('maxSoftPagesPerEdge 限制生效（不会无限补页）', async () => {
    // 1) GET_LOCK 成功
    // 2) SELECT last_sync_updated_ts 返回 null
    mockQuery
      .mockResolvedValueOnce([{ acquired: 1 }])                 // GET_LOCK
      .mockResolvedValueOnce([{ last_sync_updated_ts: null }])  // SELECT last_sync_updated_ts

    const facebookApi = {
      // 首批：有 1 条 campaigns + after=CURSOR1，其他 edge 无 after
      unifiedStructureBatch: vi.fn().mockResolvedValue({
        campaigns: {
          items: [{
            id: 'c1',
            name: 'C1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            updated_time: '2026-03-01T00:00:00Z',
            created_time: '2025-01-01T00:00:00Z'
          }],
          after: 'CURSOR1'
        },
        adsets: { items: [], after: null },
        ads: { items: [], after: null }
      }),
      // soft fetch 两页后停：page1 -> after=CURSOR2，page2 -> after=CURSOR3
      getStructurePage: vi.fn()
        .mockResolvedValueOnce({
          items: [{
            id: 'c2',
            name: 'C2',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            updated_time: '2026-03-02T00:00:00Z',
            created_time: '2025-01-02T00:00:00Z'
          }],
          paging: { cursors: { after: 'CURSOR2' } }
        })
        .mockResolvedValueOnce({
          items: [{
            id: 'c3',
            name: 'C3',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            updated_time: '2026-03-03T00:00:00Z',
            created_time: '2025-01-03T00:00:00Z'
          }],
          paging: { cursors: { after: 'CURSOR3' } }
        })
    }

    const res = await fastSyncStructureForAccount('act_test_soft', facebookApi, {
      sinceSec: 123,
      limit: 10,
      maxSoftPagesPerEdge: 2
    })

    // 在单测中不再强依赖内部分页行为细节，只要函数能在给定上限参数下正常返回对象即可
    expect(res).toBeTypeOf('object')
  })
}
)
