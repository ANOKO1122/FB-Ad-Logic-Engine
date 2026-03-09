// 规则 API 测试文件
// 使用 Vitest + Supertest 测试规则 API
// 按照 README.md 中的测试指南编写
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'
import bcrypt from 'bcryptjs'

// 测试用的用户信息（M3 后创建规则需 accountId，且 accountId 须属于用户的 owner）
const TEST_ACCOUNT_ID = 'act_test_rules'
const TEST_OWNER_KEY = 'test_rules_owner'
let authToken = null
let testUserId = null
let testOwnerId = null

describe('规则 API 测试', () => {
  // 在测试前：创建 owner → 创建用户(绑定 owner_id) → 创建 account_mapping → 生成 token
  beforeAll(async () => {
    const [ownerResult] = await pool.execute(
      'INSERT INTO owners (owner_key, owner_name, is_active) VALUES (?, ?, 1)',
      [TEST_OWNER_KEY, '测试规则负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_rules_user', passwordHash, 'staff', 'active', testOwnerId]
    )
    testUserId = result.insertId

    await pool.execute(
      'INSERT INTO account_mappings (fb_account_id, owner_id, is_active, timezone_name) VALUES (?, ?, 1, ?)',
      [TEST_ACCOUNT_ID, testOwnerId, 'UTC']
    )

    authToken = signToken(testUserId)
  })

  // 测试后清理测试数据（顺序：规则 → account_mapping → 用户 owner_id 置空 → 用户 → owner）
  afterAll(async () => {
    if (testUserId) {
      await pool.execute('DELETE FROM rules WHERE user_id = ?', [testUserId])
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

  describe('POST /api/rules - 创建规则', () => {
    it('应该创建规则并返回 201', async () => {
      const ruleData = {
        ruleName: '测试规则',
        accountId: TEST_ACCOUNT_ID,
        conditions: [
          { metric: 'ctr', operator: 'lt', value: 0.8 }
        ],
        actions: [
          { type: 'pause_ad' }
        ]
      }

      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send(ruleData)

      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('rule')
      expect(res.body.rule).toHaveProperty('id')
      expect(res.body.rule.ruleName).toBe('测试规则')
      
      // 验证数据库记录（使用 Drizzle 查询，但这里用原生 SQL 验证）
      const [rows] = await pool.execute(
        'SELECT * FROM rules WHERE id = ? AND user_id = ?',
        [res.body.rule.id, testUserId]
      )
      expect(rows.length).toBe(1)
      expect(rows[0].rule_name).toBe('测试规则')
    })

    it('应该拒绝缺少必填字段的请求', async () => {
      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则',
          accountId: TEST_ACCOUNT_ID
          // 缺少 conditions 和 actions
        })

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
      expect(res.body.code).toBe('MISSING_FIELDS')
    })

    it('应该创建规则并使用新字段（M3 扩展）', async () => {
      const ruleData = {
        ruleName: '测试规则（新字段）',
        accountId: TEST_ACCOUNT_ID,
        targetLevel: 'adset',
        targetIds: ['adset_123', 'adset_456'],
        conditions: [
          { metric: 'spend', operator: 'gt', value: 20, time_window: 'today' }
        ],
        logicOperator: 'OR',
        timezoneName: 'Asia/Shanghai',
        isSimulation: true,
        actions: [
          { type: 'pause_ad' }
        ]
      }

      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send(ruleData)

      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('rule')
      
      // 验证新字段
      expect(res.body.rule.targetLevel).toBe('adset')
      expect(res.body.rule.targetIds).toEqual(['adset_123', 'adset_456'])
      expect(res.body.rule.logicOperator).toBe('OR')
      expect(res.body.rule.timezoneName).toBe('Asia/Shanghai')
      expect(res.body.rule.isSimulation).toBe(true)
      
      // 验证数据库记录
      const [rows] = await pool.execute(
        'SELECT * FROM rules WHERE id = ? AND user_id = ?',
        [res.body.rule.id, testUserId]
      )
      expect(rows.length).toBe(1)
      expect(rows[0].target_level).toBe('adset')
      
      // MySQL JSON 字段可能已经是对象，也可能是字符串，需要处理两种情况
      const targetIds = typeof rows[0].target_ids === 'string' 
        ? JSON.parse(rows[0].target_ids) 
        : rows[0].target_ids
      expect(targetIds).toEqual(['adset_123', 'adset_456'])
      
      expect(rows[0].logic_operator).toBe('OR')
      expect(rows[0].timezone_name).toBe('Asia/Shanghai')
      expect(rows[0].is_simulation).toBe(1) // MySQL BOOLEAN 存储为 1/0
    })

    it('应该使用新字段的默认值（如果不提供）', async () => {
      const ruleData = {
        ruleName: '测试规则（默认值）',
        accountId: TEST_ACCOUNT_ID,
        conditions: [
          { metric: 'ctr', operator: 'lt', value: 0.8 }
        ],
        actions: [
          { type: 'pause_ad' }
        ]
        // 不提供新字段，应该使用默认值
      }

      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send(ruleData)

      expect(res.status).toBe(201)
      
      // 验证默认值
      expect(res.body.rule.targetLevel).toBe('ad') // 默认值
      expect(res.body.rule.targetIds).toEqual([]) // 默认值（空数组）
      expect(res.body.rule.logicOperator).toBe('AND') // 默认值
      expect(res.body.rule.timezoneName).toBe('UTC') // 默认值
      expect(res.body.rule.isSimulation).toBe(false) // 默认值
    })

    it('应该拒绝无效的 targetLevel', async () => {
      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则',
          accountId: TEST_ACCOUNT_ID,
          targetLevel: 'invalid_level', // 无效值
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
      expect(res.body.code).toBe('INVALID_TARGET_LEVEL')
    })

    it('应该拒绝 v2 含空 conditions 的规则', async () => {
      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: 'v2 空组',
          accountId: TEST_ACCOUNT_ID,
          conditions: {
            version: 2,
            groups: [{ operator: 'AND', conditions: [] }]
          },
          actions: [{ type: 'pause_ad' }]
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/非空 conditions/)
    })

    it('应该接受 v2 conditions 并创建规则', async () => {
      const v2Conditions = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0.8 }] },
          { operator: 'AND', conditions: [{ metric: 'cpc', operator: 'gt', value: 0.8 }] }
        ]
      }
      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: 'v2 规则',
          accountId: TEST_ACCOUNT_ID,
          conditions: v2Conditions,
          actions: [{ type: 'pause_ad' }]
        })
      expect(res.status).toBe(201)
      expect(res.body.rule.conditions).toEqual(v2Conditions)
    })

    it('应该拒绝无效的 logicOperator', async () => {
      const res = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则',
          accountId: TEST_ACCOUNT_ID,
          logicOperator: 'XOR', // 无效值
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
      expect(res.body.code).toBe('INVALID_LOGIC_OPERATOR')
    })
  })

  describe('GET /api/rules - 获取规则列表', () => {
    it('应该返回用户的规则列表', async () => {
      const res = await request(app)
        .get('/api/rules')
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rules')
      expect(res.body).toHaveProperty('count')
      expect(Array.isArray(res.body.rules)).toBe(true)
    })

    it('应该返回规则列表中的新字段（M3 扩展）', async () => {
      // 先创建一个规则（包含新字段）
      await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则列表（新字段）',
          accountId: TEST_ACCOUNT_ID,
          targetLevel: 'campaign',
          targetIds: ['campaign_999'],
          logicOperator: 'OR',
          timezoneName: 'Europe/London',
          isSimulation: false,
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      // 获取规则列表
      const res = await request(app)
        .get('/api/rules')
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.rules.length).toBeGreaterThan(0)
      
      // 找到刚创建的规则
      const testRule = res.body.rules.find(r => r.ruleName === '测试规则列表（新字段）')
      expect(testRule).toBeDefined()
      
      // 验证新字段存在
      expect(testRule).toHaveProperty('targetLevel')
      expect(testRule).toHaveProperty('targetIds')
      expect(testRule).toHaveProperty('logicOperator')
      expect(testRule).toHaveProperty('timezoneName')
      expect(testRule).toHaveProperty('isSimulation')
    })
  })

  describe('GET /api/rules/:id - 获取单个规则', () => {
    it('应该返回规则详情', async () => {
      // 先创建一个规则
      const createRes = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则详情',
          accountId: TEST_ACCOUNT_ID,
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      const ruleId = createRes.body.rule.id

      // 查询规则详情
      const res = await request(app)
        .get(`/api/rules/${ruleId}`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rule')
      expect(res.body.rule.id).toBe(ruleId)
      expect(res.body.rule.ruleName).toBe('测试规则详情')
    })

    it('应该返回规则的新字段（M3 扩展）', async () => {
      // 先创建一个规则（包含新字段）
      const createRes = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '测试规则详情（新字段）',
          accountId: TEST_ACCOUNT_ID,
          targetLevel: 'adset',
          targetIds: ['adset_111', 'adset_222'],
          conditions: [
            { metric: 'spend', operator: 'gt', value: 30, time_window: 'yesterday' }
          ],
          logicOperator: 'OR',
          timezoneName: 'Asia/Tokyo',
          isSimulation: true,
          actions: [{ type: 'pause_ad' }]
        })

      const ruleId = createRes.body.rule.id

      // 查询规则详情
      const res = await request(app)
        .get(`/api/rules/${ruleId}`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rule')
      
      // 验证新字段
      expect(res.body.rule.targetLevel).toBe('adset')
      expect(res.body.rule.targetIds).toEqual(['adset_111', 'adset_222'])
      expect(res.body.rule.logicOperator).toBe('OR')
      expect(res.body.rule.timezoneName).toBe('Asia/Tokyo')
      expect(res.body.rule.isSimulation).toBe(true)
    })
  })

  describe('PUT /api/rules/:id - 更新规则', () => {
    it('应该更新规则并返回更新后的数据', async () => {
      // 先创建一个规则
      const createRes = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '原始规则名称',
          accountId: TEST_ACCOUNT_ID,
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      const ruleId = createRes.body.rule.id

      // 更新规则
      const res = await request(app)
        .put(`/api/rules/${ruleId}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '更新后的规则名称'
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rule')
      expect(res.body.rule.ruleName).toBe('更新后的规则名称')
    })

    it('应该更新规则的新字段（M3 扩展）', async () => {
      // 先创建一个规则（使用默认值）
      const createRes = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '原始规则',
          accountId: TEST_ACCOUNT_ID,
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      const ruleId = createRes.body.rule.id

      // 验证初始值（默认值）
      expect(createRes.body.rule.targetLevel).toBe('ad')
      expect(createRes.body.rule.logicOperator).toBe('AND')
      expect(createRes.body.rule.timezoneName).toBe('UTC')
      expect(createRes.body.rule.isSimulation).toBe(false)

      // 更新新字段
      const res = await request(app)
        .put(`/api/rules/${ruleId}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          targetLevel: 'campaign',
          targetIds: ['campaign_789'],
          logicOperator: 'OR',
          timezoneName: 'America/New_York',
          isSimulation: true
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rule')
      
      // 验证新字段已更新
      expect(res.body.rule.targetLevel).toBe('campaign')
      expect(res.body.rule.targetIds).toEqual(['campaign_789'])
      expect(res.body.rule.logicOperator).toBe('OR')
      expect(res.body.rule.timezoneName).toBe('America/New_York')
      expect(res.body.rule.isSimulation).toBe(true)
    })
  })

  describe('DELETE /api/rules/:id - 删除规则', () => {
    it('应该删除规则', async () => {
      // 先创建一个规则
      const createRes = await request(app)
        .post('/api/rules')
        .set('Cookie', `token=${authToken}`)
        .send({
          ruleName: '待删除的规则',
          accountId: TEST_ACCOUNT_ID,
          conditions: [{ metric: 'ctr', operator: 'lt', value: 0.8 }],
          actions: [{ type: 'pause_ad' }]
        })

      const ruleId = createRes.body.rule.id
      await pool.execute(
        `INSERT INTO rule_matched_objects (rule_id, account_id, object_id, object_type)
         VALUES (?, ?, ?, 'ad')`,
        [ruleId, TEST_ACCOUNT_ID, 'test_ad_for_delete']
      )

      // 删除规则
      const res = await request(app)
        .delete(`/api/rules/${ruleId}`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('message', '规则删除成功')

      // 验证规则已被删除
      const [rows] = await pool.execute(
        'SELECT * FROM rules WHERE id = ?',
        [ruleId]
      )
      expect(rows.length).toBe(0)

      // 验证动态快照已被联动清理（避免孤儿数据）
      const [snapshotRows] = await pool.execute(
        'SELECT * FROM rule_matched_objects WHERE rule_id = ?',
        [ruleId]
      )
      expect(snapshotRows.length).toBe(0)
    })
  })
})

