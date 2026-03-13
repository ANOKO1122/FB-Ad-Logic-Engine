// 执行时间窗口：跨日与同日内判断（方案：执行时间跨日与24小时制）
import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { isInExecutionWindow } from '../services/cronService.js'

const ZONE_BJ = 'Asia/Shanghai'

/** 构造北京时间某天的 HH:mm 的 DateTime（日期固定便于断言） */
function bjTime(year, month, day, hour, minute = 0, second = 0) {
  return DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: ZONE_BJ })
}

describe('isInExecutionWindow', () => {
  const baseDate = { year: 2026, month: 3, day: 13 }

  it('空/NULL/非数组或 length===0 视为全天，返回 true', () => {
    const now = bjTime(...Object.values(baseDate), 12, 0)
    expect(isInExecutionWindow({}, now)).toBe(true)
    expect(isInExecutionWindow({ executionTimeWindows: null }, now)).toBe(true)
    expect(isInExecutionWindow({ executionTimeWindows: [] }, now)).toBe(true)
    expect(isInExecutionWindow({ execution_time_windows: [] }, now)).toBe(true)
  })

  it('跨日窗口 20:00–05:00：21:00、02:00 命中，10:00 不命中', () => {
    const rule = {
      execution_time_windows: [{ start: '20:00:00', end: '05:00:00' }]
    }
    const day = baseDate.day
    const month = baseDate.month
    const year = baseDate.year
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 21, 0))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day + 1, 2, 0))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 10, 0))).toBe(false)
  })

  it('同日内窗口 09:00–18:00：12:00 命中，20:00 不命中', () => {
    const rule = {
      execution_time_windows: [{ start: '09:00:00', end: '18:00:00' }]
    }
    const { year, month, day } = baseDate
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 12, 0))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 20, 0))).toBe(false)
  })

  it('startSec === endSec 时视为全天该窗口恒命中', () => {
    const rule = {
      execution_time_windows: [{ start: '12:00:00', end: '12:00:00' }]
    }
    const { year, month, day } = baseDate
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 8, 0))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 12, 0))).toBe(true)
  })

  it('windows 为 JSON 字符串时（MySQL/Drizzle 读回）能正确解析并判断', () => {
    const rule = {
      execution_time_windows: '[{"start":"20:40:00","end":"04:00:00"}]'
    }
    const { year, month, day } = baseDate
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 21, 48))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 2, 0))).toBe(true)
    expect(isInExecutionWindow(rule, bjTime(year, month, day, 11, 48))).toBe(false)
  })
})
