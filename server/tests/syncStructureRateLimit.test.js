// /api/sync/structure 限流与提前拒绝测试（不触网）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'
import bcrypt from 'bcryptjs'

// Mock：避免真实调用 Facebook
vi.mock('../services/structureSyncService.js', async () => {
  const actual = await vi.importActual('../services/structureSyncService.js')
  return {
    ...actual,
    syncAccountStructureAds: vi.fn()
  }
})

// 注意：必须在 mock 之后再 import index.js，确保路由使用 mock 的 syncAccountStructureAds
const { syncAccountStructureAds } = await import('../services/structureSyncService.js')
// 注册 index.js 路由（含 /api/sync/structure），必须早于 app 导入，避免 404
await import('../index.js')
const { default: app } = await import('../app.js')

const TEST_ACCOUNT_ID = 'act_test_sync_structure_rl'
const TEST_OWNER_KEY = 'test_sync_structure_rl_owner'
let authToken = null
let testUserId = null
let testOwnerId = null

describe('POST /api/sync/structure - rate limit handling', () => {
  beforeAll(async () => {
    // 令牌仅用于通过 server/index.js 的“是否配置 token”校验，不会真实触网
    process.env.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'test_token_dummy'

    const [ownerResult] = await pool.execute(
      'INSERT INTO owners (owner_key, owner_name, is_active) VALUES (?, ?, 1)',
      [TEST_OWNER_KEY, '测试同步结构限流负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_sync_structure_rl_user', passwordHash, 'staff', 'active', testOwnerId]
    )
    testUserId = result.insertId

    await pool.execute(
      'INSERT INTO account_mappings (fb_account_id, owner_id, is_active, timezone_name) VALUES (?, ?, 1, ?)',
      [TEST_ACCOUNT_ID, testOwnerId, 'UTC']
    )

    authToken = signToken(testUserId)
  })

  afterAll(async () => {
    await pool.execute('DELETE FROM account_mappings WHERE fb_account_id = ?', [TEST_ACCOUNT_ID])
    if (testUserId) {
      await pool.execute('UPDATE users SET owner_id = NULL WHERE id = ?', [testUserId])
      await pool.execute('DELETE FROM users WHERE id = ?', [testUserId])
    }
    if (testOwnerId) {
      await pool.execute('DELETE FROM owners WHERE id = ?', [testOwnerId])
    }
  })

  it('当 service 返回 quota_high 时应返回 429 + retry_after_sec', async () => {
    syncAccountStructureAds.mockResolvedValueOnce({ ok: false, reason: 'quota_high', retry_after_sec: 600 })

    const res = await request(app)
      .post('/api/sync/structure')
      .set('Cookie', `token=${authToken}`)
      .send({ account_id: TEST_ACCOUNT_ID })

    expect(res.status).toBe(429)
    expect(res.body).toMatchObject({ ok: false, reason: 'quota_high', retry_after_sec: 600 })
  })

  it('当抛出 User request limit reached 时应返回 429 fb_rate_limited', async () => {
    syncAccountStructureAds.mockImplementationOnce(() => {
      throw new Error('Facebook API Error: User request limit reached')
    })

    const res = await request(app)
      .post('/api/sync/structure')
      .set('Cookie', `token=${authToken}`)
      .send({ account_id: TEST_ACCOUNT_ID })

    expect(res.status).toBe(429)
    expect(res.body).toHaveProperty('reason', 'fb_rate_limited')
    expect(res.body).toHaveProperty('retry_after_sec')
  })
})

