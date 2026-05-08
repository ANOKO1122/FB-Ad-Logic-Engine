import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'

const TEST_OWNER_KEY = 'test_rule_execute_owner'
const TEST_ACCOUNT_ID = 'act_test_rule_execute'
let testOwnerId = null
let testUserId = null
let authToken = null
let createdRuleId = null

describe('POST /api/rules/:id/execute', () => {
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
      [TEST_OWNER_KEY, '规则执行接口测试负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [userResult] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_rule_execute_user', passwordHash, 'staff', 'active', testOwnerId]
    )
    testUserId = userResult.insertId
    authToken = signToken(testUserId)

    await pool.execute(
      'INSERT INTO account_mappings (fb_account_id, fb_account_name, owner_id, is_active, timezone_name) VALUES (?, ?, ?, 1, ?)',
      [TEST_ACCOUNT_ID, '规则执行接口测试账户', testOwnerId, 'UTC']
    )

    const [ruleResult] = await pool.execute(
      `INSERT INTO rules (
        user_id, account_id, rule_name, conditions, actions, enabled
      ) VALUES (?, ?, ?, ?, ?, 1)`,
      [
        testUserId,
        TEST_ACCOUNT_ID,
        '规则执行接口测试规则',
        JSON.stringify([{ metric: 'spend', operator: 'gt', value: 100000, time_window: 'today' }]),
        JSON.stringify([{ type: 'pause_ad' }])
      ]
    )
    createdRuleId = ruleResult.insertId
  })

  afterAll(async () => {
    if (createdRuleId) {
      await pool.execute('DELETE FROM rules WHERE id = ?', [createdRuleId])
      await pool.execute('DELETE FROM rule_execution_summaries WHERE rule_id = ?', [createdRuleId])
    }
    await pool.execute('DELETE FROM account_mappings WHERE fb_account_id = ?', [TEST_ACCOUNT_ID])
    if (testUserId) {
      await pool.execute('UPDATE users SET owner_id = NULL WHERE id = ?', [testUserId])
      await pool.execute('DELETE FROM users WHERE id = ?', [testUserId])
    }
    if (testOwnerId) {
      await pool.execute('DELETE FROM owners WHERE id = ?', [testOwnerId])
    }
  })

  it('应返回 run_id 与 status 字段', async () => {
    const res = await request(app)
      .post(`/api/rules/${createdRuleId}/execute`)
      .set('Cookie', `token=${authToken}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(typeof res.body.run_id).toBe('string')
    expect(res.body.run_id.length).toBeGreaterThan(0)
    expect(['matched', 'no_match', 'skipped', 'error']).toContain(res.body.status)
    expect(res.body).toHaveProperty('matched_count')
    expect(res.body).toHaveProperty('executed_count')
    expect(res.body).toHaveProperty('failed_count')
  })
})
