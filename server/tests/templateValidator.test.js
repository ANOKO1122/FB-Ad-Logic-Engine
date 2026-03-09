/**
 * templateValidator.validateActions 单元测试
 * 覆盖：set_budget value_unit 严格化、percent 整数、usd 两位小数
 */
import { describe, it, expect } from 'vitest'
import { validateActions } from '../utils/templateValidator.js'

describe('validateActions', () => {
  it('set_budget value_unit=abc 应失败', () => {
    const result = validateActions([{ type: 'set_budget', value: 30, value_unit: 'abc' }])
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/set_budget.*value_unit=usd/)
    expect(result.field).toBe('actions')
  })

  it('set_budget value_unit=percent 应失败', () => {
    const result = validateActions([{ type: 'set_budget', value: 30, value_unit: 'percent' }])
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/set_budget.*value_unit=usd/)
  })

  it('set_budget value_unit=usd 或不传应通过', () => {
    expect(validateActions([{ type: 'set_budget', value: 30, value_unit: 'usd' }]).valid).toBe(true)
    expect(validateActions([{ type: 'set_budget', value: 30 }]).valid).toBe(true)
  })

  it('increase_budget percent value=10.5 应失败', () => {
    const result = validateActions([{ type: 'increase_budget', value: 10.5 }])
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/百分比.*1–100 整数/)
    expect(result.field).toBe('actions')
  })

  it('increase_budget percent value=10 应通过', () => {
    expect(validateActions([{ type: 'increase_budget', value: 10 }]).valid).toBe(true)
  })

  it('increase_budget 允许 max_daily_budget，不允许 min_daily_budget', () => {
    expect(validateActions([{ type: 'increase_budget', value: 10, max_daily_budget: 7000 }]).valid).toBe(true)
    const bad = validateActions([{ type: 'increase_budget', value: 10, min_daily_budget: 3000 }])
    expect(bad.valid).toBe(false)
    expect(bad.error).toMatch(/increase_budget.*min_daily_budget/)
  })

  it('decrease_budget 允许 min_daily_budget，不允许 max_daily_budget', () => {
    expect(validateActions([{ type: 'decrease_budget', value: 10, min_daily_budget: 3000 }]).valid).toBe(true)
    const bad = validateActions([{ type: 'decrease_budget', value: 10, max_daily_budget: 7000 }])
    expect(bad.valid).toBe(false)
    expect(bad.error).toMatch(/decrease_budget.*max_daily_budget/)
  })

  it('set_budget 传上下限字段应失败', () => {
    const r1 = validateActions([{ type: 'set_budget', value: 30, value_unit: 'usd', max_daily_budget: 7000 }])
    const r2 = validateActions([{ type: 'set_budget', value: 30, value_unit: 'usd', min_daily_budget: 3000 }])
    expect(r1.valid).toBe(false)
    expect(r2.valid).toBe(false)
    expect(r1.error).toMatch(/set_budget.*不允许配置/)
    expect(r2.error).toMatch(/set_budget.*不允许配置/)
  })

  it('同一动作同时传 max_daily_budget 和 min_daily_budget 应失败', () => {
    const result = validateActions([{
      type: 'increase_budget',
      value: 10,
      max_daily_budget: 7000,
      min_daily_budget: 3000
    }])
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/不允许同时配置/)
  })

  it('min_daily_budget 非整数或小于 100 应失败', () => {
    const r1 = validateActions([{ type: 'decrease_budget', value: 10, min_daily_budget: 99 }])
    const r2 = validateActions([{ type: 'decrease_budget', value: 10, min_daily_budget: 100.5 }])
    expect(r1.valid).toBe(false)
    expect(r2.valid).toBe(false)
    expect(r1.error).toMatch(/min_daily_budget.*>= 100/)
    expect(r2.error).toMatch(/min_daily_budget.*整数/)
  })
})
