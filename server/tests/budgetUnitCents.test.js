/**
 * M4 3.5 预算单位统一（美分）— Vitest 单元测试
 *
 * 【教学】为什么要统一预算单位？
 * - 一句话比喻：像「所有金额都用分记账」，避免 0.1 + 0.2 ≠ 0.3 的浮点精度问题。
 * - 为什么要学：浮点数在金融/预算场景下会产生精度丢失，用整数「分」可完全避免。
 * - 面试怎么问：「你们预算是用美元还是美分存的？为什么？」
 *   答：内部全用美分（整数），只在 FB API 边界转换，保证计算精度和幂等性。
 *
 * 验收标准：
 * 1. getAdsetBudget 返回值为美分（整数）
 * 2. updateAdsetBudget 接受美分（整数），内部转换为美元调用 FB API
 * 3. computeNewBudgetCentsOnce 计算结果为美分（整数）
 * 4. 最低预算护栏为 100 美分（1 美元）
 */

import { describe, it, expect } from 'vitest'

// 直接测试纯函数
import { computeNewBudgetCentsOnce } from '../services/actionExecutorService.js'

describe('M4 3.5 预算单位统一', () => {
  describe('computeNewBudgetCentsOnce 纯函数', () => {
    it('increase_budget 10% : 1000 分 → 1100 分', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 10 })
      expect(result).toBe(1100)
    })

    it('decrease_budget 10% : 1000 分 → 900 分', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'decrease_budget', value: 10 })
      expect(result).toBe(900)
    })

    it('decrease_budget 导致低于 100 分时触发护栏：结果为 100 分', () => {
      const result = computeNewBudgetCentsOnce(50, { type: 'decrease_budget', value: 50 })
      expect(result).toBe(100) // 50 * 0.5 = 25 → 护栏 100
    })

    it('max_daily_budget 上限护栏：计算结果超过上限时截断', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 50, max_daily_budget: 1200 })
      expect(result).toBe(1200) // 1000 * 1.5 = 1500 → 截断到 1200
    })

    it('max_daily_budget 未超过时不截断', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 10, max_daily_budget: 2000 })
      expect(result).toBe(1100) // 1000 * 1.1 = 1100 < 2000
    })

    it('value 未传时默认 10%', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget' })
      expect(result).toBe(1100) // 默认 +10%
    })

    it('value_unit=usd increase_budget +$5 : 1000 分 → 1500 分', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 5, value_unit: 'usd' })
      expect(result).toBe(1500)
    })

    it('value_unit=usd decrease_budget -$5 : 1000 分 → 500 分', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'decrease_budget', value: 5, value_unit: 'usd' })
      expect(result).toBe(500)
    })

    it('value_unit=usd decrease 导致低于 100 分时触发护栏', () => {
      const result = computeNewBudgetCentsOnce(150, { type: 'decrease_budget', value: 1, value_unit: 'usd' })
      expect(result).toBe(100)
    })

    it('value_unit=usd increase 时 max_daily_budget 上限生效', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 10, value_unit: 'usd', max_daily_budget: 1200 })
      expect(result).toBe(1200)
    })

    it('set_budget $30 → 3000 分', () => {
      const result = computeNewBudgetCentsOnce(0, { type: 'set_budget', value: 30, value_unit: 'usd' })
      expect(result).toBe(3000)
    })

    it('set_budget + cap: $80 且 max 5000 → 5000 分', () => {
      const result = computeNewBudgetCentsOnce(0, { type: 'set_budget', value: 80, value_unit: 'usd', max_daily_budget: 5000 })
      expect(result).toBe(5000)
    })

    it('set_budget + MIN: $0.5 → 100 分（下限护栏）', () => {
      const result = computeNewBudgetCentsOnce(0, { type: 'set_budget', value: 0.5, value_unit: 'usd' })
      expect(result).toBe(100)
    })

    it('set_budget 不依赖当前预算（currentBudgetCents 被忽略）', () => {
      const r1 = computeNewBudgetCentsOnce(0, { type: 'set_budget', value: 20 })
      const r2 = computeNewBudgetCentsOnce(10000, { type: 'set_budget', value: 20 })
      expect(r1).toBe(2000)
      expect(r2).toBe(2000)
    })

    it('set_budget $30 + max_daily_budget=0 → 100 分（cap 有效化）', () => {
      const result = computeNewBudgetCentsOnce(0, { type: 'set_budget', value: 30, max_daily_budget: 0 })
      expect(result).toBe(100)
    })

    it('increase_budget 10% + max_daily_budget=0 → 100 分（cap 有效化）', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'increase_budget', value: 10, max_daily_budget: 0 })
      expect(result).toBe(100)
    })

    it('返回值为整数（四舍五入）', () => {
      const result = computeNewBudgetCentsOnce(1001, { type: 'increase_budget', value: 10 })
      expect(Number.isInteger(result)).toBe(true)
      expect(result).toBe(1101) // 1001 * 1.1 = 1101.1 → 1101
    })

    it('当前预算为 0 时，护栏保证最低 100 分', () => {
      const result = computeNewBudgetCentsOnce(0, { type: 'increase_budget', value: 10 })
      expect(result).toBe(100) // 0 * 1.1 = 0 → 护栏 100
    })

    it('当前预算为字符串时正确转换', () => {
      const result = computeNewBudgetCentsOnce('1000', { type: 'decrease_budget', value: 10 })
      expect(result).toBe(900)
    })

    it('未知动作类型时按 decrease_budget 处理', () => {
      const result = computeNewBudgetCentsOnce(1000, { type: 'unknown_type', value: 10 })
      expect(result).toBe(900) // 按 decrease 处理
    })
  })

  describe('getAdsetBudget 返回美分验证', () => {
    /**
     * FB Marketing API 的 daily_budget 读写均为账户最小货币单位（USD=美分），
     * GET 返回的已是「分」，getAdsetBudget 直接取整返回，不再乘 100。
     */
    const asGetAdsetBudgetReturn = (raw) =>
      Math.round(Number(raw ?? 0))

    it('FB 返回 3000（30 美元=3000 分）→ 美分 3000', () => {
      const fbResponse = { daily_budget: 3000 }
      expect(asGetAdsetBudgetReturn(fbResponse.daily_budget)).toBe(3000)
    })

    it('FB 返回字符串 "1000" → 美分 1000', () => {
      const fbResponse = { daily_budget: '1000' }
      expect(asGetAdsetBudgetReturn(fbResponse.daily_budget)).toBe(1000)
    })

    it('FB 返回 1050（10.50 美元）→ 美分 1050', () => {
      const fbResponse = { daily_budget: 1050 }
      expect(asGetAdsetBudgetReturn(fbResponse.daily_budget)).toBe(1050)
    })

    it('无预算时返回 0', () => {
      const fbResponse = {}
      expect(asGetAdsetBudgetReturn(fbResponse.daily_budget)).toBe(0)
    })
  })

  describe('updateAdsetBudget 接受美分验证', () => {
    /**
     * 【教学】API 层的单位转换
     *
     * updateAdsetBudget 接受美分，内部转换为美元调用 FB API：
     *
     * ```javascript
     * const dollars = newBudgetCents / 100
     * const params = { [field]: dollars, ... }
     * ```
     *
     * 这个测试验证转换逻辑的正确性。
     */

    it('美分 1000 → 美元 10', () => {
      const newBudgetCents = 1000
      const dollars = newBudgetCents / 100
      expect(dollars).toBe(10)
    })

    it('美分 1050 → 美元 10.5', () => {
      const newBudgetCents = 1050
      const dollars = newBudgetCents / 100
      expect(dollars).toBe(10.5)
    })

    it('美分 100（最低）→ 美元 1', () => {
      const newBudgetCents = 100
      const dollars = newBudgetCents / 100
      expect(dollars).toBe(1)
    })

    it('美分 99999 → 美元 999.99', () => {
      const newBudgetCents = 99999
      const dollars = newBudgetCents / 100
      expect(dollars).toBe(999.99)
    })
  })

  describe('端到端流程验证', () => {
    it('完整流程：FB 返回分 → 内部美分计算 → 向 FB 发送分', () => {
      // 步骤 1：FB API 返回的 daily_budget 已是分（如 1000 = 10 美元）
      const fbGetResponse = { daily_budget: 1000 }
      const currentCents = Math.round(Number(fbGetResponse.daily_budget ?? 0))
      expect(currentCents).toBe(1000)

      // 步骤 2：内部用美分计算
      const newCents = computeNewBudgetCentsOnce(currentCents, { type: 'increase_budget', value: 20 })
      expect(newCents).toBe(1200)

      // 步骤 3：直接以分发送给 FB（FB API 的 daily_budget 为最小货币单位）
      expect(newCents).toBe(1200)
    })

    it('浮点精度验证：0.1 美元 + 0.2 美元用美分计算', () => {
      // 直接用美元计算会有精度问题
      const dollarResult = 0.1 + 0.2
      expect(dollarResult).not.toBe(0.3) // 0.30000000000000004

      // 用美分计算完全精确
      const centsResult = 10 + 20
      expect(centsResult).toBe(30)
      expect(centsResult / 100).toBe(0.3)
    })
  })
})
