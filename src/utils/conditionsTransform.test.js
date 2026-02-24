// 2.3.1 方案B：线性条件 ↔ v2 DNF 转换单测
import { describe, it, expect } from 'vitest'
import {
  linesToV2Groups,
  v2ToLines,
  v1ToLines,
  createDefaultWhenLine,
  getDefaultWhenCustomRange
} from './conditionsTransform.js'

describe('conditionsTransform', () => {
  describe('linesToV2Groups', () => {
    it('A AND B OR C → 2 组，第1组2条、第2组1条', () => {
      const lines = [
        { join: null, metric: 'spend', operator: 'gt', value: 20 },
        { join: 'AND', metric: 'roas', operator: 'lt', value: 0.5 },
        { join: 'OR', metric: 'cpc', operator: 'gt', value: 0.8 }
      ]
      const v2 = linesToV2Groups(lines, 'today', null)
      expect(v2.version).toBe(2)
      expect(v2.groups).toHaveLength(2)
      expect(v2.groups[0].conditions).toHaveLength(2)
      expect(v2.groups[0].conditions[0]).toMatchObject({ metric: 'spend', operator: 'gt', value: 20, time_window: 'today' })
      expect(v2.groups[0].conditions[1]).toMatchObject({ metric: 'roas', operator: 'lt', value: 0.5, time_window: 'today' })
      expect(v2.groups[1].conditions).toHaveLength(1)
      expect(v2.groups[1].conditions[0]).toMatchObject({ metric: 'cpc', operator: 'gt', value: 0.8, time_window: 'today' })
    })

    it('custom_range 时每条 condition 带 custom_range', () => {
      const lines = [{ join: null, metric: 'spend', operator: 'gt', value: 10 }]
      const cr = { since: '2026-01-01', until: '2026-01-07' }
      const v2 = linesToV2Groups(lines, 'custom_range', cr)
      expect(v2.groups[0].conditions[0].custom_range).toEqual(cr)
    })

    it('空 lines → 空 groups', () => {
      const v2 = linesToV2Groups([], 'today', null)
      expect(v2.groups).toHaveLength(0)
    })
  })

  describe('v2ToLines', () => {
    it('v2 → 线性，OR 落在新组首条', () => {
      const v2 = {
        version: 2,
        groups: [
          { operator: 'AND', conditions: [{ metric: 'spend', operator: 'gt', value: 20, time_window: 'today' }, { metric: 'roas', operator: 'lt', value: 0.5, time_window: 'today' }] },
          { operator: 'AND', conditions: [{ metric: 'cpc', operator: 'gt', value: 0.8, time_window: 'today' }] }
        ]
      }
      const { lines, timeWindow } = v2ToLines(v2)
      expect(lines).toHaveLength(3)
      expect(lines[0].join).toBeNull()
      expect(lines[0].metric).toBe('spend')
      expect(lines[1].join).toBe('AND')
      expect(lines[2].join).toBe('OR')
      expect(timeWindow).toBe('today')
    })

    it('空 v2 → 空 lines', () => {
      const { lines, timeWindow } = v2ToLines({})
      expect(lines).toHaveLength(0)
      expect(timeWindow).toBe('today')
    })
  })

  describe('v1ToLines', () => {
    it('v1 单条 → 首行 join null，timeWindow 取自第一条', () => {
      const v1 = [{ metric: 'spend', operator: 'gt', value: 10, time_window: 'today' }]
      const { lines, timeWindow } = v1ToLines(v1, 'OR')
      expect(lines).toHaveLength(1)
      expect(lines[0].join).toBeNull()
      expect(lines[0].metric).toBe('spend')
      expect(timeWindow).toBe('today')
    })

    it('v1 多条 AND → 除首行外 join 均为 AND', () => {
      const v1 = [
        { metric: 'spend', operator: 'gt', value: 1, time_window: 'today' },
        { metric: 'roas', operator: 'lt', value: 0.5, time_window: 'today' }
      ]
      const { lines } = v1ToLines(v1, 'AND')
      expect(lines[0].join).toBeNull()
      expect(lines[1].join).toBe('AND')
    })
  })

  describe('createDefaultWhenLine', () => {
    it('默认返回首行结构', () => {
      const line = createDefaultWhenLine(null)
      expect(line).toMatchObject({ join: null, metric: 'spend', operator: 'gt', value: 0 })
    })
  })

  describe('getDefaultWhenCustomRange', () => {
    it('返回 since/until 同一天', () => {
      const cr = getDefaultWhenCustomRange()
      expect(cr.since).toBe(cr.until)
      expect(cr.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  describe('往返一致性', () => {
    it('linesToV2Groups → v2ToLines 往返不丢 AND/OR', () => {
      const lines = [
        { join: null, metric: 'spend', operator: 'gt', value: 20 },
        { join: 'AND', metric: 'roas', operator: 'lt', value: 0.5 },
        { join: 'OR', metric: 'cpc', operator: 'gt', value: 0.8 }
      ]
      const v2 = linesToV2Groups(lines, 'today', null)
      const back = v2ToLines(v2)
      expect(back.lines[0].join).toBeNull()
      expect(back.lines[1].join).toBe('AND')
      expect(back.lines[2].join).toBe('OR')
      expect(back.lines[0].metric).toBe('spend')
      expect(back.lines[1].metric).toBe('roas')
      expect(back.lines[2].metric).toBe('cpc')
    })
  })
})
