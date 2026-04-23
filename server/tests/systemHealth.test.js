// GET /api/system/health 健康检查 API 测试（需鉴权）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'
import bcrypt from 'bcryptjs'

const TEST_OWNER_KEY = 'test_system_health_owner'
const TEST_ACCOUNT_ID = 'act_test_system_health'
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

    await pool.execute(
      'INSERT INTO account_mappings (fb_account_id, fb_account_name, owner_id, is_active, timezone_name) VALUES (?, ?, ?, 1, ?)',
      [TEST_ACCOUNT_ID, '测试健康检查账户', testOwnerId, 'UTC']
    )

    await pool.execute(
      `INSERT INTO structure_sync_status
        (
          account_id,
          last_heartbeat_attempt_at,
          last_heartbeat_success_at,
          last_heartbeat_data_update_at,
          last_heartbeat_result_code,
          last_heartbeat_error_message,
          last_heartbeat_duration_ms,
          updated_at
        )
       VALUES
        (?, NOW(), NOW(), NOW(), ?, NULL, 321, NOW())
       ON DUPLICATE KEY UPDATE
        last_heartbeat_attempt_at = VALUES(last_heartbeat_attempt_at),
        last_heartbeat_success_at = VALUES(last_heartbeat_success_at),
        last_heartbeat_data_update_at = VALUES(last_heartbeat_data_update_at),
        last_heartbeat_result_code = VALUES(last_heartbeat_result_code),
        last_heartbeat_error_message = VALUES(last_heartbeat_error_message),
        last_heartbeat_duration_ms = VALUES(last_heartbeat_duration_ms),
        updated_at = NOW()`,
      [TEST_ACCOUNT_ID, 'SUCCESS_WITH_DATA']
    )

    authToken = signToken(testUserId)
  })

  afterAll(async () => {
    await pool.execute('DELETE FROM structure_sync_status WHERE account_id = ?', [TEST_ACCOUNT_ID])
    await pool.execute('DELETE FROM account_mappings WHERE fb_account_id = ?', [TEST_ACCOUNT_ID])
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

  it('accounts 每项应含业务心跳字段，并区分正常有数据/正常无数据/异常/未知', async () => {
    const res = await request(app)
      .get('/api/system/health')
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    const targetAccount = res.body.accounts.find((a) => a.account_id === TEST_ACCOUNT_ID)
    expect(targetAccount).toBeDefined()
    expect(targetAccount).toHaveProperty('status')
    expect(['healthy', 'healthy_no_data', 'stale', 'error', 'unknown']).toContain(targetAccount.status)
    expect(targetAccount).toHaveProperty('last_heartbeat_attempt_at')
    expect(targetAccount).toHaveProperty('last_heartbeat_success_at')
    expect(targetAccount).toHaveProperty('last_heartbeat_data_update_at')
    expect(targetAccount).toHaveProperty('last_heartbeat_result_code', 'SUCCESS_WITH_DATA')
    expect(targetAccount).toHaveProperty('last_heartbeat_error_message')
    expect(targetAccount).toHaveProperty('last_heartbeat_duration_ms', 321)
    expect(targetAccount.status).toBe('healthy')
  })
})
