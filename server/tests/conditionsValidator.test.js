// 条件组校验与归一化单元测试（DNF 阶段 1）
import { describe, it, expect } from 'vitest'
import {
  validateConditionsStructure,
  validateTimeWindowConsistency,
  normalizeConditionsToV2,
  getAllConditionsFromV2
} from '../utils/conditionsValidator.js'

describe('conditionsValidator', () => {
  describe('validateConditionsStructure', () => {
    it('v1 空数组应无效', () => {
      expect(validateConditionsStructure([]).valid).toBe(false)
      expect(validateConditionsStructure([]).error).toMatch(/不能为空/)
    })

    it('v1 合法数组应有效', () => {
      const v1 = [{ metric: 'spend', operator: 'gt', value: 0 }]
      expect(validateConditionsStructure(v1).valid).toBe(true)
    })

    it('v1 缺 metric 应无效', () => {
      const v1 = [{ operator: 'gt', value: 0 }]
      expect(validateConditionsStructure(v1).valid).toBe(false)
    })

    it('v2 合法对象应有效', () => {
      const v2 = {
        version: 2,
        groups: [{ operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0 }] }]
      }
      expect(validateConditionsStructure(v2).valid).toBe(true)
    })

    it('v2 version 非 2 应无效', () => {
      const v = { version: 1, groups: [{ operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0 }] }] }
      expect(validateConditionsStructure(v).valid).toBe(false)
    })

    it('v2 groups 为空应无效', () => {
      const v = { version: 2, groups: [] }
      expect(validateConditionsStructure(v).valid).toBe(false)
    })

    it('v2 group.conditions 为空数组应无效（防永真）', () => {
      const v = {
        version: 2,
        groups: [{ operator: 'AND', conditions: [] }]
      }
      const r = validateConditionsStructure(v)
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/非空 conditions/)
    })

    it('v2 group.operator 非 AND 应无效', () => {
      const v = {
        version: 2,
        groups: [{ operator: 'OR', conditions: [{ metric: 'spend', operator: 'gt', value: 0 }] }]
      }
      const r = validateConditionsStructure(v)
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/仅支持 AND/)
    })
  })

  describe('validateTimeWindowConsistency', () => {
    it('v1 数组应跳过（返回 valid）', () => {
      expect(validateTimeWindowConsistency([{ metric: 'a', operator: 'gt', value: 0 }]).valid).toBe(true)
    })

    it('v2 一致 time_window 应有效', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }] }
        ]
      }
      expect(validateTimeWindowConsistency(v2).valid).toBe(true)
    })

    it('v2 不一致 time_window 应无效', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0, time_window: 'today' }] },
          { operator: 'AND', conditions: [{ metric: 'cpc', operator: 'gt', value: 0, time_window: 'yesterday' }] }
        ]
      }
      const r = validateTimeWindowConsistency(v2)
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/time_window 须一致/)
    })
  })

  describe('normalizeConditionsToV2', () => {
    it('v1 AND → 单组多条件', () => {
      const v1 = [
        { metric: 'spend', operator: 'gt', value: 0.8 },
        { metric: 'link_clicks', operator: 'eq', value: 0 }
      ]
      const out = normalizeConditionsToV2(v1, 'AND')
      expect(out.version).toBe(2)
      expect(out.groups).toHaveLength(1)
      expect(out.groups[0].conditions).toHaveLength(2)
    })

    it('v1 OR → 多组单条件', () => {
      const v1 = [
        { metric: 'spend', operator: 'gt', value: 0.8 },
        { metric: 'cpc', operator: 'gt', value: 0.8 }
      ]
      const out = normalizeConditionsToV2(v1, 'OR')
      expect(out.version).toBe(2)
      expect(out.groups).toHaveLength(2)
      expect(out.groups[0].conditions).toHaveLength(1)
      expect(out.groups[1].conditions).toHaveLength(1)
    })

    it('v2 直接返回', () => {
      const v2 = {
        version: 2,
        groups: [{ operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 0 }] }]
      }
      const out = normalizeConditionsToV2(v2, 'AND')
      expect(out).toBe(v2)
    })
  })

  describe('getAllConditionsFromV2', () => {
    it('应扁平化所有组内条件', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'a', operator: 'gt', value: 0 }] },
          { operator: 'AND', conditions: [{ metric: 'b', operator: 'lt', value: 1 }] }
        ]
      }
      const list = getAllConditionsFromV2(v2)
      expect(list).toHaveLength(2)
      expect(list[0].metric).toBe('a')
      expect(list[1].metric).toBe('b')
    })
  })
})
