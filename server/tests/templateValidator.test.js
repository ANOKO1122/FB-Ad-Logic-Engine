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
})
