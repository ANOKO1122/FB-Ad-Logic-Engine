// GET /api/system/health 健康检查 API 测试（需鉴权）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'
import bcrypt from 'bcryptjs'

const TEST_OWNER_KEY = 'test_system_health_owner'
let authToken = null
let testUserId = null
let testOwnerId = null

describe('GET /api/system/health', () => {
  beforeAll(async () => {
    const [ownerResult] = await pool.execute(
      'INSERT INTO owners (owner_key, owner_name, is_active) VALUES (?, ?, 1)',
      [TEST_OWNER_KEY, '测试健康检查负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_system_health_user', passwordHash, 'staff', 'active', testOwnerId]
    )
    testUserId = result.insertId

    authToken = signToken(testUserId)
  })

  afterAll(async () => {
    if (testUserId) {
      await pool.execute('UPDATE users SET owner_id = NULL WHERE id = ?', [testUserId])
      await pool.execute('DELETE FROM users WHERE id = ?', [testUserId])
    }
    if (testOwnerId) {
      await pool.execute('DELETE FROM owners WHERE id = ?', [testOwnerId])
    }
  })

  it('无鉴权时应返回 401', async () => {
    const res = await request(app).get('/api/system/health')
    expect(res.status).toBe(401)
  })

  it('有鉴权时应返回 200 及正确响应结构', async () => {
    const res = await request(app)
      .get('/api/system/health')
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('success', true)
    expect(res.body).toHaveProperty('system_status')
    expect(['healthy', 'warning', 'error']).toContain(res.body.system_status)
    expect(res.body).toHaveProperty('is_system_locked')
    expect(typeof res.body.is_system_locked).toBe('boolean')
    expect(res.body).toHaveProperty('cron')
    expect(res.body.cron).toHaveProperty('is_running')
    expect(res.body).toHaveProperty('accounts')
    expect(Array.isArray(res.body.accounts)).toBe(true)
    expect(res.body).toHaveProperty('queue')
    expect(res.body.queue).toHaveProperty('pending_count')
    expect(res.body).toHaveProperty('timestamp')
  })

  it('timestamp 应为有效 ISO 日期字符串', async () => {
    const res = await request(app)
      .get('/api/system/health')
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    const ts = new Date(res.body.timestamp)
    expect(ts.toString()).not.toBe('Invalid Date')
  })

  it('accounts 每项应含 account_id、status、last_sync_time 等字段', async () => {
    const res = await request(app)
      .get('/api/system/health')
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    for (const a of res.body.accounts) {
      expect(a).toHaveProperty('account_id')
      expect(a).toHaveProperty('status')
      expect(['healthy', 'stale', 'error', 'unknown']).toContain(a.status)
      expect(a).toHaveProperty('last_sync_time')  // 可能为 null
    }
  })
})
