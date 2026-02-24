// 规则引擎测试
// 按照 .cursorrules 的要求：最小自动化测试，培养测开意识

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RuleEngine } from '../index.js'

/**
 * 【为什么需要这个测试？】
 * - 验证 RuleEngine 类的基本功能
 * - 验证 AND/OR 逻辑运算符
 * - 验证指标获取功能
 * - 培养测开意识：每个核心功能都要有测试
 */

describe('RuleEngine', () => {
  let ruleEngine
  let mockApi

  beforeEach(() => {
    // 创建模拟的 Facebook API 客户端
    mockApi = {
      pauseAd: vi.fn(),
      activateAd: vi.fn(),
      getAdsetBudget: vi.fn(),
      updateAdsetBudget: vi.fn()
    }
    
    // 创建 RuleEngine 实例
    ruleEngine = new RuleEngine(mockApi)
  })

  // 测试1：评估条件（最小测试用例）
  it('应该正确评估条件（gt 操作符）', () => {
    // 第1行：准备测试数据
    const condition = { metric: 'spend', operator: 'gt', value: 20 }
    const adData = { spend: 25.5, purchases: 2, cpc: 0.5, roas: 1.5 }
    
    // 第2行：调用方法
    const result = ruleEngine.evaluateCondition(condition, adData)
    
    // 第3行：验证结果（25.5 > 20，应该返回 true）
    expect(result).toBe(true)
  })

  // 测试2：评估条件（lt 操作符）
  it('应该正确评估条件（lt 操作符）', () => {
    const condition = { metric: 'spend', operator: 'lt', value: 20 }
    const adData = { spend: 15.5, purchases: 1, cpc: 0.3, roas: 1.2 }
    
    const result = ruleEngine.evaluateCondition(condition, adData)
    
    expect(result).toBe(true)
  })

  // 测试3：评估多个条件（AND 逻辑）
  it('应该正确评估多个条件（AND 逻辑）', () => {
    const conditions = [
      { metric: 'spend', operator: 'gt', value: 20 },
      { metric: 'purchases', operator: 'lt', value: 1 }
    ]
    const adData = { spend: 25.5, purchases: 0, cpc: 0.5, roas: 0 }
    
    const result = ruleEngine.evaluateConditions(conditions, adData, 'AND')
    
    expect(result).toBe(true)  // spend > 20 AND purchases < 1，应该返回 true
  })

  // 测试4：评估多个条件（OR 逻辑）
  it('应该正确评估多个条件（OR 逻辑）', () => {
    const conditions = [
      { metric: 'spend', operator: 'gt', value: 20 },
      { metric: 'roas', operator: 'lt', value: 1.5 }
    ]
    const adData = { spend: 15.5, purchases: 2, cpc: 0.3, roas: 1.2 }
    
    const result = ruleEngine.evaluateConditions(conditions, adData, 'OR')
    
    expect(result).toBe(true)  // spend > 20 OR roas < 1.5，roas < 1.5 满足，应该返回 true
  })

  // 测试5：获取指标值（新字段）
  it('应该正确获取指标值（roas）', () => {
    const adData = { spend: 100, purchases: 5, purchase_value: 150, roas: 1.5 }
    
    const result = ruleEngine.getMetricValue('roas', adData)
    
    expect(result).toBe(1.5)
  })

  // ─── DNF 条件组（阶段 1 后端）────────────────────────────────────────────
  // (spend>0.8 AND link_clicks=0) OR (cpc>0.8)
  describe('DNF 语义 (spend>0.8 AND link_clicks=0) OR (cpc>0.8)', () => {
    const dnfConditions = {
      version: 2,
      groups: [
        {
          operator: 'AND',
          conditions: [
            { metric: 'spend', operator: 'gt', value: 0.8 },
            { metric: 'link_clicks', operator: 'eq', value: 0 }
          ]
        },
        {
          operator: 'AND',
          conditions: [
            { metric: 'cpc', operator: 'gt', value: 0.8 }
          ]
        }
      ]
    }

    it('组1满足：spend>0.8 且 link_clicks=0 应匹配', () => {
      const adData = { spend: 1, link_clicks: 0, cpc: 0.5 }
      const result = ruleEngine.evaluateConditions(dnfConditions, adData, 'AND')
      expect(result).toBe(true)
    })

    it('组2满足：cpc>0.8 应匹配', () => {
      const adData = { spend: 0.5, link_clicks: 5, cpc: 1.0 }
      const result = ruleEngine.evaluateConditions(dnfConditions, adData, 'AND')
      expect(result).toBe(true)
    })

    it('两组都不满足应不匹配', () => {
      const adData = { spend: 0.5, link_clicks: 5, cpc: 0.5 }
      const result = ruleEngine.evaluateConditions(dnfConditions, adData, 'AND')
      expect(result).toBe(false)
    })
  })

  // v1 OR 兼容：确保 v1 OR 不会被误算成 AND
  describe('v1 OR 兼容', () => {
    it('v1 OR：满足任一条件应匹配（spend>0.8 OR cpc>0.8）', () => {
      const v1OrConditions = [
        { metric: 'spend', operator: 'gt', value: 0.8 },
        { metric: 'cpc', operator: 'gt', value: 0.8 }
      ]
      // 只满足 cpc>0.8，不满足 spend>0.8；若误算成 AND 则 false
      const adData = { spend: 0.5, cpc: 1.0 }
      const result = ruleEngine.evaluateConditions(v1OrConditions, adData, 'OR')
      expect(result).toBe(true)
    })

    it('v1 OR：都不满足应不匹配', () => {
      const v1OrConditions = [
        { metric: 'spend', operator: 'gt', value: 0.8 },
        { metric: 'cpc', operator: 'gt', value: 0.8 }
      ]
      const adData = { spend: 0.5, cpc: 0.5 }
      const result = ruleEngine.evaluateConditions(v1OrConditions, adData, 'OR')
      expect(result).toBe(false)
    })
  })

  // getTimeWindowFromConditions / getCustomRangeFromConditions（v2 + 一致性防御）
  describe('getTimeWindowFromConditions / getCustomRangeFromConditions', () => {
    it('v2 一致 time_window 应正确提取', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'yesterday' }] }
        ]
      }
      expect(ruleEngine.getTimeWindowFromConditions(v2, 'AND')).toBe('yesterday')
    })

    it('v2 time_window 不一致应抛错', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }] },
          { operator: 'AND', conditions: [{ metric: 'cpc', operator: 'gt', value: 0, time_window: 'yesterday' }] }
        ]
      }
      expect(() => ruleEngine.getTimeWindowFromConditions(v2, 'AND')).toThrow(/time_window 须一致/)
    })

    it('v2 custom_range 一致应正确提取', () => {
      const v2 = {
        version: 2,
        groups: [
          {
            operator: 'AND',
            conditions: [
              { metric: 'spend', operator: 'gt', value: 0, time_window: 'custom_range', custom_range: { since: '2025-01-01', until: '2025-01-31' } }
            ]
          }
        ]
      }
      const range = ruleEngine.getCustomRangeFromConditions(v2, 'AND')
      expect(range).toEqual({ since: '2025-01-01', until: '2025-01-31' })
    })

    it('v2 custom_range 不一致应抛错', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'custom_range', custom_range: { since: '2025-01-01', until: '2025-01-15' } }] },
          { operator: 'AND', conditions: [{ metric: 'cpc', operator: 'gt', value: 0, time_window: 'custom_range', custom_range: { since: '2025-01-01', until: '2025-01-31' } }] }
        ]
      }
      expect(() => ruleEngine.getCustomRangeFromConditions(v2, 'AND')).toThrow(/custom_range 须一致/)
    })
  })
})

