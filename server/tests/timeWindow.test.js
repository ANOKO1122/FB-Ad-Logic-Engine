// 时间窗口工具模块测试
// 按照教学三部曲的要求：最小自动化测试
// 测试核心逻辑：时区感知的时间窗口计算

import { describe, it, expect } from 'vitest'
import {
  calculateTimeWindow,
  getTimeWindowForQuery,
  isValidTimezone,
  getCommonTimezones
} from '../utils/timeWindow.js'
import { DateTime } from 'luxon'

describe('时间窗口工具模块', () => {
  describe('calculateTimeWindow', () => {
    it('应该正确计算 today 时间窗口（UTC 时区）', () => {
      const { start, end } = calculateTimeWindow('today', 'UTC')
      
      // 验证是 DateTime 对象
      expect(start).toBeInstanceOf(DateTime)
      expect(end).toBeInstanceOf(DateTime)
      
      // 验证时区
      expect(start.zoneName).toBe('UTC')
      expect(end.zoneName).toBe('UTC')
      
      // 验证是当天的开始和结束
      expect(start.hour).toBe(0)
      expect(start.minute).toBe(0)
      expect(start.second).toBe(0)
      expect(end.hour).toBe(23)
      expect(end.minute).toBe(59)
      expect(end.second).toBe(59)
    })

    it('应该正确计算 today 时间窗口（Asia/Shanghai 时区）', () => {
      const { start, end } = calculateTimeWindow('today', 'Asia/Shanghai')
      
      // 验证时区
      expect(start.zoneName).toBe('Asia/Shanghai')
      expect(end.zoneName).toBe('Asia/Shanghai')
      
      // 验证是当天的开始和结束
      expect(start.hour).toBe(0)
      expect(start.minute).toBe(0)
      expect(end.hour).toBe(23)
      expect(end.minute).toBe(59)
    })

    it('应该正确计算 yesterday 时间窗口', () => {
      const { start, end } = calculateTimeWindow('yesterday', 'UTC')
      const today = DateTime.now().setZone('UTC')
      const yesterday = today.minus({ days: 1 })
      
      // 验证是昨天的日期
      expect(start.day).toBe(yesterday.day)
      expect(start.month).toBe(yesterday.month)
      expect(start.year).toBe(yesterday.year)
      
      // 验证是当天的开始和结束
      expect(start.hour).toBe(0)
      expect(end.hour).toBe(23)
    })

    it('应该正确计算 last_3_days 时间窗口', () => {
      const { start, end } = calculateTimeWindow('last_3_days', 'UTC')
      const now = DateTime.now().setZone('UTC')
      
      // 验证结束时间是今天
      expect(end.day).toBe(now.day)
      expect(end.month).toBe(now.month)
      expect(end.year).toBe(now.year)
      
      // 验证开始时间是 3 天前
      const expectedStart = now.minus({ days: 3 }).startOf('day')
      expect(start.day).toBe(expectedStart.day)
      expect(start.month).toBe(expectedStart.month)
      expect(start.year).toBe(expectedStart.year)
    })

    it('应该正确计算 lifetime 时间窗口', () => {
      const { start, end } = calculateTimeWindow('lifetime', 'UTC')
      
      // 验证开始时间是 1970-01-01
      expect(start.year).toBe(1970)
      expect(start.month).toBe(1)
      expect(start.day).toBe(1)
      
      // 验证结束时间是今天
      const now = DateTime.now().setZone('UTC')
      expect(end.day).toBe(now.day)
      expect(end.month).toBe(now.month)
      expect(end.year).toBe(now.year)
    })

    it('应该在不支持的时间窗口类型时抛出错误', () => {
      expect(() => {
        calculateTimeWindow('invalid_window', 'UTC')
      }).toThrow('不支持的时间窗口类型: invalid_window')
    })
  })

  describe('getTimeWindowForQuery', () => {
    it('应该返回 MySQL 日期格式的查询条件', () => {
      const result = getTimeWindowForQuery('today', 'UTC', 'synced_at')
      
      // 验证返回格式
      expect(result).toHaveProperty('startDate')
      expect(result).toHaveProperty('endDate')
      expect(result).toHaveProperty('startISO')
      expect(result).toHaveProperty('endISO')
      
      // 验证日期格式（YYYY-MM-DD HH:mm:ss）
      expect(result.startDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    })
  })

  describe('isValidTimezone', () => {
    it('应该验证有效的时区名称', () => {
      expect(isValidTimezone('UTC')).toBe(true)
      expect(isValidTimezone('Asia/Shanghai')).toBe(true)
      expect(isValidTimezone('America/New_York')).toBe(true)
    })

    it('应该拒绝无效的时区名称', () => {
      expect(isValidTimezone('Invalid/Timezone')).toBe(false)
      expect(isValidTimezone('')).toBe(false)
    })
  })

  describe('getCommonTimezones', () => {
    it('应该返回常用时区列表', () => {
      const timezones = getCommonTimezones()
      
      expect(Array.isArray(timezones)).toBe(true)
      expect(timezones.length).toBeGreaterThan(0)
      
      // 验证每个时区都有 value 和 label
      timezones.forEach(tz => {
        expect(tz).toHaveProperty('value')
        expect(tz).toHaveProperty('label')
      })
    })
  })
})

