import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecute = vi.fn()

vi.mock('../db/connection.js', () => ({
  default: {
    execute: (...args) => mockExecute(...args)
  }
}))

import { queryRuleData, queryRuleDataByLevel } from '../services/ruleDataService.js'

function buildAggregateRows(objectId) {
  return [[{
    object_id: objectId,
    spend: 10,
    purchases: 1,
    link_clicks: 5,
    unique_link_clicks: 4,
    purchase_value: 20,
    add_to_cart_count: 0,
    initiate_checkout_count: 0,
    add_payment_info_count: 0
  }]]
}

function buildChildrenRows(objectId) {
  return [[{
    object_id: objectId,
    ad_id: 'ad_1',
    ad_name: 'ad-1',
    ad_set_id: objectId.startsWith('as_') ? objectId : 'as_1',
    campaign_id: objectId.startsWith('cmp_') ? objectId : 'cmp_1',
    status: 'ACTIVE',
    spend: 10,
    purchases: 1,
    link_clicks: 5,
    unique_link_clicks: 4,
    purchase_value: 20,
    add_to_cart_count: 0,
    initiate_checkout_count: 0,
    add_payment_info_count: 0
  }]]
}

describe('queryRuleDataByLevel status fields', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    vi.useRealTimers()
  })

  it('adset 层级结果应包含 status/object_status/adset_status', async () => {
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      if (sql.includes('FROM structure_adsets')) {
        return [[{ adset_id: 'as_1', name: 'Adset 1', campaign_id: 'cmp_1', status: 'PAUSED' }]]
      }
      if (sql.includes('GROUP BY object_id, ad_id')) {
        return buildChildrenRows('as_1')
      }
      if (sql.includes('GROUP BY object_id')) {
        return buildAggregateRows('as_1')
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const result = await queryRuleDataByLevel('act_test', ['as_1'], 'adset', 'today', 'UTC')
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data[0].status).toBe('PAUSED')
    expect(result.data[0].object_status).toBe('PAUSED')
    expect(result.data[0].adset_status).toBe('PAUSED')
  })

  it('campaign 层级结果应包含 status/object_status/campaign_status', async () => {
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      if (sql.includes('FROM structure_campaigns')) {
        return [[{ campaign_id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' }]]
      }
      if (sql.includes('GROUP BY object_id, ad_id')) {
        return buildChildrenRows('cmp_1')
      }
      if (sql.includes('GROUP BY object_id')) {
        return buildAggregateRows('cmp_1')
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const result = await queryRuleDataByLevel('act_test', ['cmp_1'], 'campaign', 'today', 'UTC')
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data[0].status).toBe('ACTIVE')
    expect(result.data[0].object_status).toBe('ACTIVE')
    expect(result.data[0].campaign_status).toBe('ACTIVE')
  })

  it('不含今天窗口不应拼接 ad_snapshots 今天段查询', async () => {
    const sqlLogs = []
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      sqlLogs.push(sql)
      if (sql.includes('FROM structure_campaigns')) {
        return [[{ campaign_id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' }]]
      }
      if (sql.includes('GROUP BY object_id, ad_id')) {
        return buildChildrenRows('cmp_1')
      }
      if (sql.includes('GROUP BY object_id')) {
        return buildAggregateRows('cmp_1')
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    await queryRuleDataByLevel('act_test', ['cmp_1'], 'campaign', 'last_7_days_excluding_today', 'UTC')

    const hasTodaySnapshotsSql = sqlLogs.some((sql) => sql.includes('FROM ad_snapshots s'))
    expect(hasTodaySnapshotsSql).toBe(false)
  })

  it('ad 层级 lifetime 应使用 created_time 起点且不应抛运行时错误', async () => {
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      if (sql.includes('FROM structure_ads')) {
        return [[{ ad_id: 'ad_1', created_time: '2026-05-10T08:00:00+08:00' }]]
      }
      if (sql.includes('SELECT DISTINCT timezone_name')) {
        return [[{ timezone_name: 'UTC', count: 1 }]]
      }
      if (sql.includes('FROM daily_stats')) {
        return [[{
          account_id: 'act_test',
          ad_id: 'ad_1',
          ad_name: 'ad-1',
          ad_set_id: 'as_1',
          campaign_id: 'cmp_1',
          owner_id: 1,
          date: '2026-05-11',
          timezone_name: 'UTC',
          spend: 10,
          purchases: 1,
          link_clicks: 5,
          unique_link_clicks: 4,
          purchase_value: 20,
          add_to_cart_count: 1,
          initiate_checkout_count: 1,
          add_payment_info_count: 1,
          cpc: null,
          roas: null,
          add_to_cart_count_legacy: null
        }]]
      }
      if (sql.includes('FROM ad_snapshots')) {
        return [[{
          account_id: 'act_test',
          ad_id: 'ad_1',
          ad_name: 'ad-1',
          ad_set_id: 'as_1',
          campaign_id: 'cmp_1',
          owner_id: 1,
          status: 'ACTIVE',
          spend: 2,
          purchases: 0,
          link_clicks: 1,
          unique_link_clicks: 1,
          purchase_value: 0,
          add_to_cart_count: 0,
          initiate_checkout_count: 0,
          add_payment_info_count: 0,
          roas: null,
          cpa: null,
          add_to_cart_cost: null,
          checkout_cost: null,
          payment_cost: null,
          mute_until: null,
          mute_reason: null,
          synced_at: '2026-05-12 08:00:00'
        }]]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const result = await queryRuleData('act_test', ['ad_1'], 'lifetime', 'UTC')

    expect(result.data).toHaveLength(1)
    expect(result.data[0].ad_id).toBe('ad_1')
    expect(result.data[0].spend).toBe(12)
    expect(result.effective_range.start_date).toBe('2026-05-10')
    expect(result.effective_range.start.local).toBe('2026-05-10 00:00:00')
    expect(result.warnings).toEqual([])
  })

  it('ad 层级应计算创建日后购买次数平均数且不影响普通 purchases', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'))
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      if (sql.includes('FROM structure_ads')) {
        return [[{ ad_id: 'ad_1', created_time: '2026-05-10T01:00:00Z' }]]
      }
      if (sql.includes('SELECT DISTINCT timezone_name')) {
        return [[{ timezone_name: 'UTC', count: 1 }]]
      }
      if (sql.includes('FROM daily_stats')) {
        return [[
          {
            account_id: 'act_test',
            ad_id: 'ad_1',
            ad_name: 'ad-1',
            ad_set_id: 'as_1',
            campaign_id: 'cmp_1',
            owner_id: 1,
            date: '2026-05-10',
            timezone_name: 'UTC',
            spend: 10,
            purchases: 9,
            link_clicks: 5,
            unique_link_clicks: 4,
            purchase_value: 20,
            add_to_cart_count: 0,
            initiate_checkout_count: 0,
            add_payment_info_count: 0,
            cpc: null,
            roas: null,
            add_to_cart_count_legacy: null
          },
          {
            account_id: 'act_test',
            ad_id: 'ad_1',
            ad_name: 'ad-1',
            ad_set_id: 'as_1',
            campaign_id: 'cmp_1',
            owner_id: 1,
            date: '2026-05-11',
            timezone_name: 'UTC',
            spend: 10,
            purchases: 1,
            link_clicks: 5,
            unique_link_clicks: 4,
            purchase_value: 20,
            add_to_cart_count: 0,
            initiate_checkout_count: 0,
            add_payment_info_count: 0,
            cpc: null,
            roas: null,
            add_to_cart_count_legacy: null
          }
        ]]
      }
      if (sql.includes('FROM ad_snapshots')) {
        return [[{
          account_id: 'act_test',
          ad_id: 'ad_1',
          ad_name: 'ad-1',
          ad_set_id: 'as_1',
          campaign_id: 'cmp_1',
          owner_id: 1,
          status: 'ACTIVE',
          data_date: '2026-05-12',
          spend: 10,
          purchases: 5,
          link_clicks: 5,
          unique_link_clicks: 4,
          purchase_value: 20,
          add_to_cart_count: 0,
          initiate_checkout_count: 0,
          add_payment_info_count: 0,
          roas: null,
          cpa: null,
          add_to_cart_cost: null,
          checkout_cost: null,
          payment_cost: null,
          mute_until: null,
          mute_reason: null,
          synced_at: '2026-05-12 08:00:00'
        }]]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const result = await queryRuleData('act_test', ['ad_1'], 'last_3_days', 'UTC')

    expect(result.data[0].purchases).toBe(15)
    expect(result.data[0].purchases_avg_after_create).toBe(3)
    expect(result.data[0].purchases_avg_after_create_days).toBe(2)
  })

  it('创建当天无有效自然日时 purchases_avg_after_create 应为 null', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'))
    mockExecute.mockImplementation(async (sqlText) => {
      const sql = String(sqlText)
      if (sql.includes('FROM structure_ads')) {
        return [[{ ad_id: 'ad_1', created_time: '2026-05-12T01:00:00Z' }]]
      }
      if (sql.includes('FROM ad_snapshots')) {
        return [[{
          account_id: 'act_test',
          ad_id: 'ad_1',
          ad_name: 'ad-1',
          ad_set_id: 'as_1',
          campaign_id: 'cmp_1',
          owner_id: 1,
          status: 'ACTIVE',
          data_date: '2026-05-12',
          spend: 10,
          purchases: 5,
          link_clicks: 5,
          unique_link_clicks: 4,
          purchase_value: 20,
          add_to_cart_count: 0,
          initiate_checkout_count: 0,
          add_payment_info_count: 0,
          roas: null,
          cpa: null,
          add_to_cart_cost: null,
          checkout_cost: null,
          payment_cost: null,
          mute_until: null,
          mute_reason: null,
          synced_at: '2026-05-12 08:00:00'
        }]]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const result = await queryRuleData('act_test', ['ad_1'], 'today', 'UTC')

    expect(result.data[0].purchases).toBe(5)
    expect(result.data[0].purchases_avg_after_create).toBeNull()
    expect(result.data[0].purchases_avg_after_create_days).toBe(0)
  })
})
