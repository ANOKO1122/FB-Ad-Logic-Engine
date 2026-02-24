// resolve 回显查库 + sync 接口测试（顺序2）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import '../index.js'  // 注册 /api/structure/* 等路由
import app from '../app.js'
import pool from '../db/connection.js'
import { signToken } from '../middleware/authJwt.js'
import bcrypt from 'bcryptjs'

const TEST_ACCOUNT_ID = 'act_test_resolve'
const TEST_OWNER_KEY = 'test_resolve_owner'
const TEST_AD_ID = '120212345678901234'
const TEST_CAMPAIGN_ID = '120212345678901000'
const TEST_ADSET_ID = '120212345678901100'
let authToken = null
let testUserId = null
let testOwnerId = null

describe('resolve 回显查库 + sync', () => {
  beforeAll(async () => {
    const [ownerResult] = await pool.execute(
      'INSERT INTO owners (owner_key, owner_name, is_active) VALUES (?, ?, 1)',
      [TEST_OWNER_KEY, '测试resolve负责人']
    )
    testOwnerId = ownerResult.insertId

    const passwordHash = await bcrypt.hash('test123456', 10)
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role, status, owner_id) VALUES (?, ?, ?, ?, ?)',
      ['test_resolve_user', passwordHash, 'staff', 'active', testOwnerId]
    )
    testUserId = result.insertId

    await pool.execute(
      'INSERT INTO account_mappings (fb_account_id, owner_id, is_active, timezone_name) VALUES (?, ?, 1, ?)',
      [TEST_ACCOUNT_ID, testOwnerId, 'UTC']
    )

    authToken = signToken(testUserId)
  })

  afterAll(async () => {
    await pool.execute('DELETE FROM structure_ads WHERE account_id = ?', [TEST_ACCOUNT_ID])
    await pool.execute('DELETE FROM structure_adsets WHERE account_id = ?', [TEST_ACCOUNT_ID])
    await pool.execute('DELETE FROM structure_campaigns WHERE account_id = ?', [TEST_ACCOUNT_ID])
    await pool.execute('DELETE FROM account_mappings WHERE fb_account_id = ?', [TEST_ACCOUNT_ID])
    if (testUserId) {
      await pool.execute('UPDATE users SET owner_id = NULL WHERE id = ?', [testUserId])
      await pool.execute('DELETE FROM users WHERE id = ?', [testUserId])
    }
    if (testOwnerId) {
      await pool.execute('DELETE FROM owners WHERE id = ?', [testOwnerId])
    }
  })

  describe('GET /api/structure/resolve', () => {
    it('ids 为空应返回 items: []', async () => {
      const res = await request(app)
        .get('/api/structure/resolve')
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('items')
      expect(Array.isArray(res.body.items)).toBe(true)
      expect(res.body.items).toHaveLength(0)
    })

    it('ids 缺省应返回 items: []', async () => {
      const res = await request(app)
        .get('/api/structure/resolve?ids=')
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(0)
    })

    it('DB miss 的 ids 应返回 missing: true，不穿透 FB', async () => {
      const res = await request(app)
        .get('/api/structure/resolve?ids=99999999999999,88888888888888')
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(2)
      expect(res.body.items[0]).toEqual({ id: '99999999999999', missing: true })
      expect(res.body.items[1]).toEqual({ id: '88888888888888', missing: true })
    })

    it('structure_ads 存在的 id 应返回 name 等字段', async () => {
      await pool.execute(
        `INSERT INTO structure_ads (account_id, ad_id, name, effective_status, status, configured_status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [TEST_ACCOUNT_ID, TEST_AD_ID, '测试广告名', 'ACTIVE', 'ACTIVE', 'ACTIVE']
      )

      const res = await request(app)
        .get(`/api/structure/resolve?ids=${TEST_AD_ID}`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0]).toMatchObject({
        id: TEST_AD_ID,
        name: '测试广告名',
        effective_status: 'ACTIVE'
      })
      expect(res.body.items[0]).not.toHaveProperty('missing')
    })

    it('混合（存在+不存在）应分别返回 name 与 missing', async () => {
      const res = await request(app)
        .get(`/api/structure/resolve?ids=${TEST_AD_ID},77777777777777`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(2)
      const found = res.body.items.find(it => it.id === TEST_AD_ID)
      const missing = res.body.items.find(it => it.id === '77777777777777')
      expect(found).toMatchObject({ id: TEST_AD_ID, name: '测试广告名' })
      expect(found).not.toHaveProperty('missing')
      expect(missing).toEqual({ id: '77777777777777', missing: true })
    })

    it('应返回 type 字段（campaign/adset/ad）', async () => {
      await pool.execute(
        `INSERT INTO structure_campaigns (account_id, campaign_id, name, effective_status, status)
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [TEST_ACCOUNT_ID, TEST_CAMPAIGN_ID, '测试广告系列', 'ACTIVE', 'ACTIVE']
      )
      await pool.execute(
        `INSERT INTO structure_adsets (account_id, adset_id, campaign_id, name, effective_status, status)
         VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [TEST_ACCOUNT_ID, TEST_ADSET_ID, null, '测试广告组', 'ACTIVE', 'ACTIVE']
      )

      const res = await request(app)
        .get(`/api/structure/resolve?ids=${TEST_CAMPAIGN_ID},${TEST_ADSET_ID},${TEST_AD_ID}`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(3)
      const camp = res.body.items.find(it => it.id === TEST_CAMPAIGN_ID)
      const adset = res.body.items.find(it => it.id === TEST_ADSET_ID)
      const ad = res.body.items.find(it => it.id === TEST_AD_ID)
      expect(camp).toMatchObject({ id: TEST_CAMPAIGN_ID, name: '测试广告系列', type: 'campaign' })
      expect(adset).toMatchObject({ id: TEST_ADSET_ID, name: '测试广告组', type: 'adset' })
      expect(ad).toMatchObject({ id: TEST_AD_ID, name: '测试广告名', type: 'ad' })
    })
  })

  describe('GET /api/structure/ads（选择器查库）', () => {
    it('应返回 structure_ads 数据，meta.source 为 structure_ads', async () => {
      const res = await request(app)
        .get(`/api/structure/ads?account_id=${TEST_ACCOUNT_ID}&limit=20`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('items')
      expect(res.body).toHaveProperty('meta')
      expect(res.body.meta?.source).toBe('structure_ads')
      expect(Array.isArray(res.body.items)).toBe(true)
    })
  })

  describe('GET /api/structure/campaigns（选择器查库）', () => {
    it('应返回 structure_campaigns 数据，meta.source 为 structure_campaigns', async () => {
      const res = await request(app)
        .get(`/api/structure/campaigns?account_id=${TEST_ACCOUNT_ID}&limit=20`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('items')
      expect(res.body).toHaveProperty('meta')
      expect(res.body.meta?.source).toBe('structure_campaigns')
      expect(Array.isArray(res.body.items)).toBe(true)
    })
  })

  describe('GET /api/structure/adsets（选择器查库）', () => {
    it('应返回 structure_adsets 数据，meta.source 为 structure_adsets', async () => {
      const res = await request(app)
        .get(`/api/structure/adsets?account_id=${TEST_ACCOUNT_ID}&limit=20`)
        .set('Cookie', `token=${authToken}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('items')
      expect(res.body).toHaveProperty('meta')
      expect(res.body.meta?.source).toBe('structure_adsets')
      expect(Array.isArray(res.body.items)).toBe(true)
    })
  })
})
