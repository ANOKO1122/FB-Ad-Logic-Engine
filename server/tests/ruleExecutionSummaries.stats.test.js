import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'

const TEST_OWNER_KEY = 'test_summary_scope_owner'
const TEST_RUN_ID = 'run-summary-scope-test'
const TEST_EVALUATED_AT = '2035-01-01 00:00:00'
let testOwnerId = null
let testUserId = null
let authToken = null

describe('GET /api/rule-execution-summaries/stats', () => {
  beforeAll(async () => {
    const [scopeColRows] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rule_execution_summaries'
         AND COLUMN_NAME = 'summary_scope'`
    )
    if (Number(scopeColRows?.[0]?.cnt || 0) === 0) {
      try {
        await pool.execute(
          `ALTER TABLE rule_execution_summaries
           ADD COLUMN summary_scope VARCHAR(20) DEFAULT NULL`
        )
      } catch (err) {
        if (err?.code !== 'ER_DUP_FIELDNAME') throw err
      }
    }

    const [ownerResult] = await pool.execute(
      'INSERT INTO owners (owner_key, owner_name, is_active) VALUES (?, ?, 1)',
      [TEST_OWNER_KEY, 'summary scope 测试负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [userResult] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_summary_scope_admin', passwordHash, 'admin', 'active', testOwnerId]
    )
    testUserId = userResult.insertId
    authToken = signToken(testUserId)

    await pool.execute(
      `INSERT INTO rule_execution_summaries (
        run_id, rule_id, rule_name, account_id, user_id, owner_id,
        matched_count, executed_count, failed_count, skipped_count,
        status, summary_scope, skip_reason, skip_details, error_message, duration_ms, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [TEST_RUN_ID, 2001, 'summary-account', 'act_1', testUserId, testOwnerId, 1, 1, 0, 0, 'matched', 'account', null, null, null, 10, TEST_EVALUATED_AT]
    )

    await pool.execute(
      `INSERT INTO rule_execution_summaries (
        run_id, rule_id, rule_name, account_id, user_id, owner_id,
        matched_count, executed_count, failed_count, skipped_count,
        status, summary_scope, skip_reason, skip_details, error_message, duration_ms, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [TEST_RUN_ID, 2001, 'summary-rollup', 'multi', testUserId, testOwnerId, 1, 1, 0, 0, 'matched', 'rollup', null, null, null, 10, TEST_EVALUATED_AT]
    )
  })

  afterAll(async () => {
    await pool.execute('DELETE FROM rule_execution_summaries WHERE run_id = ?', [TEST_RUN_ID])
    if (testUserId) {
      await pool.execute('UPDATE users SET owner_id = NULL WHERE id = ?', [testUserId])
      await pool.execute('DELETE FROM users WHERE id = ?', [testUserId])
    }
    if (testOwnerId) {
      await pool.execute('DELETE FROM owners WHERE id = ?', [testOwnerId])
    }
  })

  it('默认仅统计 summary_scope=account', async () => {
    const res = await request(app)
      .get(`/api/rule-execution-summaries/stats?start_date=${encodeURIComponent(TEST_EVALUATED_AT)}&end_date=${encodeURIComponent(TEST_EVALUATED_AT)}`)
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.total.total).toBe(1)
  })

  it('显式 summary_scope=rollup 时应统计 rollup', async () => {
    const res = await request(app)
      .get(`/api/rule-execution-summaries/stats?summary_scope=rollup&start_date=${encodeURIComponent(TEST_EVALUATED_AT)}&end_date=${encodeURIComponent(TEST_EVALUATED_AT)}`)
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.total.total).toBe(1)
  })
})
