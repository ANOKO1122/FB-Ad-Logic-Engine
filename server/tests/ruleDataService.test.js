// 规则数据查询服务测试
// 按照 .cursorrules 的要求：最小自动化测试，培养测开意识

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAccountTimezone, queryRuleData } from '../services/ruleDataService.js'

/**
 * 【为什么需要这个测试？】
 * - 验证时区查询功能是否正常
 * - 验证错误处理（账户不存在时返回默认值）
 * - 培养测开意识：每个函数都要有测试
 */
describe('ruleDataService', () => {
  // 测试1：获取账户时区（最小测试用例）
  it('应该从数据库获取账户时区，如果不存在则返回 UTC', async () => {
    // 第1行：调用函数（使用一个不存在的账户ID，测试默认值）
    const timezone = await getAccountTimezone('act_nonexistent')
    
    // 第2行：验证返回值（应该是 'UTC'，因为账户不存在）
    expect(timezone).toBe('UTC')
    
    // 第3行：验证返回值是字符串类型（防御性检查）
    expect(typeof timezone).toBe('string')
  })
  
  // 测试2：智能路由（待实现，需要 mock 数据库）
  // it('应该根据时间窗口选择正确的数据源', async () => {
  //   // TODO: 实现测试
  // })
})

