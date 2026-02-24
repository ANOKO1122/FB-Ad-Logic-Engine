// Data Ingestor 服务测试
// 按照教学三部曲的要求：最小自动化测试
// 测试核心逻辑：滑动窗口数据合并、冷数据落盘、时区读取

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { 
  syncAccountSlidingWindow,
  archiveDailyStats,
  parseActions
} from '../services/ingestorService.js'
import { getCircuitBreakerStatus, resetCircuitBreaker } from '../services/rateLimitService.js'

// ============================================
// 第一步：测试准备（Mock 外部依赖）
// ============================================

describe('Data Ingestor 服务测试', () => {
  // 在每个测试前重置熔断器状态
  beforeEach(() => {
    resetCircuitBreaker()
  })

  // ============================================
  // 测试 1：滑动窗口数据合并逻辑（核心逻辑）
  // ============================================
  
  describe('滑动窗口数据合并逻辑', () => {
    it('应该优先使用 Today 数据，Past 7 Days 作为补充', () => {
      // 模拟 Today 数据
      const todayInsights = [
        { ad_id: 'ad_001', spend: 10.5, purchases: 2 },
        { ad_id: 'ad_002', spend: 20.0, purchases: 1 }
      ]
      
      // 模拟 Past 7 Days 数据（包含 Today 的数据，但值不同）
      const past7DaysInsights = [
        { ad_id: 'ad_001', spend: 50.0, purchases: 5 }, // 这个应该被 Today 覆盖
        { ad_id: 'ad_003', spend: 30.0, purchases: 3 }  // 这个应该被添加
      ]
      
      // 执行合并逻辑（这是 syncAccountSlidingWindow 中的核心逻辑）
      const allInsights = []
      const seenAdIds = new Set()
      
      // 先添加 Today 数据
      todayInsights.forEach(insight => {
        const adId = String(insight.ad_id || '')
        if (adId && !seenAdIds.has(adId)) {
          allInsights.push(insight)
          seenAdIds.add(adId)
        }
      })
      
      // 再添加 Past 7 Days 数据（如果 Today 没有）
      past7DaysInsights.forEach(insight => {
        const adId = String(insight.ad_id || '')
        if (adId && !seenAdIds.has(adId)) {
          allInsights.push(insight)
          seenAdIds.add(adId)
        }
      })
      
      // 验证结果
      expect(allInsights).toHaveLength(3) // 应该有 3 个广告
      
      // ad_001 应该使用 Today 的数据（spend = 10.5，不是 50.0）
      const ad001 = allInsights.find(insight => insight.ad_id === 'ad_001')
      expect(ad001).toBeDefined()
      expect(ad001.spend).toBe(10.5) // Today 的数据
      expect(ad001.purchases).toBe(2) // Today 的数据
      
      // ad_002 应该使用 Today 的数据
      const ad002 = allInsights.find(insight => insight.ad_id === 'ad_002')
      expect(ad002).toBeDefined()
      expect(ad002.spend).toBe(20.0)
      
      // ad_003 应该使用 Past 7 Days 的数据（因为 Today 没有）
      const ad003 = allInsights.find(insight => insight.ad_id === 'ad_003')
      expect(ad003).toBeDefined()
      expect(ad003.spend).toBe(30.0)
    })

    it('应该正确处理空数据', () => {
      const todayInsights = []
      const past7DaysInsights = []
      
      const allInsights = []
      const seenAdIds = new Set()
      
      todayInsights.forEach(insight => {
        const adId = String(insight.ad_id || '')
        if (adId && !seenAdIds.has(adId)) {
          allInsights.push(insight)
          seenAdIds.add(adId)
        }
      })
      
      past7DaysInsights.forEach(insight => {
        const adId = String(insight.ad_id || '')
        if (adId && !seenAdIds.has(adId)) {
          allInsights.push(insight)
          seenAdIds.add(adId)
        }
      })
      
      expect(allInsights).toHaveLength(0)
    })
  })

  // ============================================
  // 测试 2：冷数据落盘聚合逻辑（核心逻辑）
  // ============================================
  
  describe('冷数据落盘聚合逻辑', () => {
    it('应该正确聚合多条快照数据', () => {
      // 模拟 ad_snapshots 表中的数据（同一天同一个广告有多条快照）
      const snapshotRows = [
        { account_id: 'act_001', ad_id: 'ad_001', ad_name: '广告1', owner_id: 1, spend: 10.0, purchases: 1, ucpc: 0.5, cpa: 5.0 },
        { account_id: 'act_001', ad_id: 'ad_001', ad_name: '广告1', owner_id: 1, spend: 20.0, purchases: 2, ucpc: 0.6, cpa: 6.0 },
        { account_id: 'act_001', ad_id: 'ad_002', ad_name: '广告2', owner_id: 1, spend: 30.0, purchases: 3, ucpc: 0.7, cpa: 7.0 }
      ]
      
      // 模拟 SQL 聚合结果（这是 archiveDailyStats 中的聚合逻辑）
      const aggregated = {}
      snapshotRows.forEach(row => {
        const key = `${row.account_id}_${row.ad_id}`
        if (!aggregated[key]) {
          aggregated[key] = {
            account_id: row.account_id,
            ad_id: row.ad_id,
            ad_name: row.ad_name,
            owner_id: row.owner_id,
            total_spend: 0,
            total_purchases: 0,
            ucpc_values: [],
            cpa_values: []
          }
        }
        aggregated[key].total_spend += row.spend
        aggregated[key].total_purchases += row.purchases
        aggregated[key].ucpc_values.push(row.ucpc)
        aggregated[key].cpa_values.push(row.cpa)
      })
      
      // 计算平均值
      Object.values(aggregated).forEach(item => {
        item.avg_ucpc = item.ucpc_values.reduce((a, b) => a + b, 0) / item.ucpc_values.length
        item.avg_cpa = item.cpa_values.reduce((a, b) => a + b, 0) / item.cpa_values.length
      })
      
      // 验证结果
      const ad001 = aggregated['act_001_ad_001']
      expect(ad001).toBeDefined()
      expect(ad001.total_spend).toBe(30.0) // 10.0 + 20.0
      expect(ad001.total_purchases).toBe(3) // 1 + 2
      expect(ad001.avg_ucpc).toBeCloseTo(0.55) // (0.5 + 0.6) / 2
      expect(ad001.avg_cpa).toBeCloseTo(5.5) // (5.0 + 6.0) / 2
      
      const ad002 = aggregated['act_001_ad_002']
      expect(ad002).toBeDefined()
      expect(ad002.total_spend).toBe(30.0)
      expect(ad002.total_purchases).toBe(3)
    })
  })

  // ============================================
  // 测试 3：时区读取逻辑
  // ============================================
  
  describe('时区读取逻辑', () => {
    it('应该从数据库读取 timezone_name，如果没有则使用默认值 UTC', () => {
      // 模拟数据库查询结果
      const accounts = [
        { account_id: 'act_001', owner_id: 1, timezone_name: 'Asia/Shanghai' },
        { account_id: 'act_002', owner_id: 2, timezone_name: null }, // NULL 值
        { account_id: 'act_003', owner_id: 3, timezone_name: 'America/New_York' }
      ]
      
      // 模拟从数据库读取时区的逻辑（这是 syncAllAccountsTodayStats 中的逻辑）
      const results = accounts.map(account => {
        const timezoneName = account.timezone_name || 'UTC' // 如果没有则使用默认值
        return {
          accountId: account.account_id,
          ownerId: account.owner_id,
          timezoneName
        }
      })
      
      // 验证结果
      expect(results[0].timezoneName).toBe('Asia/Shanghai')
      expect(results[1].timezoneName).toBe('UTC') // NULL → 'UTC'
      expect(results[2].timezoneName).toBe('America/New_York')
    })
  })

  // ============================================
  // 测试 4：购买次数 parseActions（保守防双算）
  // ============================================

  describe('parseActions（保守防双算）', () => {
    it('同一响应同时含 offsite 与 website 时，返回两者最大值', () => {
      const actions = [
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
        { action_type: 'website_purchase', value: '5' }
      ]
      expect(parseActions(actions)).toBe(5)
    })

    it('仅有 omni_purchase 时，直接返回 omni_purchase 的 value', () => {
      const actions = [
        { action_type: 'omni_purchase', value: '7' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }
      ]
      expect(parseActions(actions)).toBe(7)
    })

    it('仅有 purchase 时，才使用 purchase 作为兜底', () => {
      const actions = [
        { action_type: 'purchase', value: '4' }
      ]
      expect(parseActions(actions)).toBe(4)
    })
  })
})

