// 规则数据查询服务测试
// 按照 .cursorrules 的要求：最小自动化测试，培养测开意识

import { describe, it, expect } from 'vitest'
import { getAccountTimezone, queryRuleData, calculateSingleDayMetrics } from '../services/ruleDataService.js'

/**
 * 【为什么需要这个测试？】
 * - 验证时区查询功能是否正常
 * - 验证错误处理（账户不存在时返回默认值）
 * - 验证规则判断一律用本地计算（不落库的 API 比值仅用于前端展示）
 */
describe('ruleDataService', () => {
  it('应该从数据库获取账户时区，如果不存在则返回 UTC', async () => {
    const timezone = await getAccountTimezone('act_nonexistent')
    expect(timezone).toBe('UTC')
    expect(typeof timezone).toBe('string')
  })

  describe('calculateSingleDayMetrics（计算优先 -> API兜底 -> 零兜底）', () => {
    it('spend=50, purchase_value=0, day.roas=null 时 roas 应为 0.0', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 50,
        link_clicks: 0,
        unique_link_clicks: 0,
        purchases: 0,
        purchase_value: 0,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.roas).toBe(0)
    })

    it('spend=0, purchase_value=0 时 roas 应为 null', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 0,
        link_clicks: 0,
        unique_link_clicks: 0,
        purchases: 0,
        purchase_value: 0,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.roas).toBeNull()
    })

    it('spend=50, purchase_value=30 时 roas 应为 0.6', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 50,
        link_clicks: 10,
        unique_link_clicks: 8,
        purchases: 1,
        purchase_value: 30,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.roas).toBe(0.6)
    })

    it('spend=50, purchase_value=0 时 roas 应为 0（有花费无转化）', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 50,
        link_clicks: 10,
        unique_link_clicks: 8,
        purchases: 0,
        purchase_value: 0,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.roas).toBe(0)
    })

    it('link_clicks=0 / unique_link_clicks=0 时 cpc/ucpc 应为 null', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 2,
        link_clicks: 0,
        unique_link_clicks: 0,
        purchases: 0,
        purchase_value: 0,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.cpc).toBeNull()
      expect(result.ucpc).toBeNull()
    })

    it('有 link_clicks 时 cpc/ucpc 应为分子分母计算值', () => {
      const row = {
        account_id: 'act_test',
        ad_id: '120xxx',
        ad_name: 'test',
        ad_set_id: null,
        owner_id: 0,
        status: 'ACTIVE',
        spend: 2,
        link_clicks: 5,
        unique_link_clicks: 4,
        purchases: 0,
        purchase_value: 0,
        roas: null,
        add_to_cart_count: 0,
        initiate_checkout_count: 0,
        add_payment_info_count: 0
      }
      const result = calculateSingleDayMetrics(row)
      expect(result.cpc).toBe(0.4)
      expect(result.ucpc).toBe(0.5)
    })
  })
})

