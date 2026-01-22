// 频率控制服务测试
// 按照教学三部曲的要求：最小自动化测试

import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseUsageHeader,
  calculateSleepTime,
  fetchWithTimeout,
  checkTokenError,
  recordSuccess,
  getCircuitBreakerStatus,
  resetCircuitBreaker
} from '../services/rateLimitService.js'

describe('频率控制服务', () => {
  beforeEach(() => {
    // 每个测试前重置熔断器
    resetCircuitBreaker()
  })

  describe('parseUsageHeader', () => {
    it('应该能解析 JSON 字符串格式的响应头', () => {
      const headerValue = '{"call_count": 100, "total_time": 1000}'
      const result = parseUsageHeader(headerValue)
      expect(result).toEqual({ call_count: 100, total_time: 1000 })
    })

    it('应该能处理已经是对象的响应头', () => {
      const headerValue = { call_count: 100, total_time: 1000 }
      const result = parseUsageHeader(headerValue)
      expect(result).toEqual(headerValue)
    })

    it('应该能处理空值', () => {
      expect(parseUsageHeader(null)).toBeNull()
      expect(parseUsageHeader(undefined)).toBeNull()
      expect(parseUsageHeader('')).toBeNull()
    })
  })

  describe('calculateSleepTime', () => {
    it('应该根据使用率 < 50% 返回 500ms 休眠时间', () => {
      const usageInfo = { call_count: 10, total_time: 1000 }
      const result = calculateSleepTime(usageInfo)
      expect(result.sleepMs).toBe(500)
      expect(result.alert).toBe(false)
    })

    it('应该优先使用 estimated_time_to_regain_access（分钟单位）', () => {
      // ⚠️ 重要：estimated_time_to_regain_access 的单位是分钟，不是秒！
      // 1.5 分钟 = 90 秒 = 90000 毫秒 + 2000ms 安全缓冲 = 92000ms
      const usageInfo = { estimated_time_to_regain_access: 1.5 }
      const result = calculateSleepTime(usageInfo, { estimatedTimeUnit: 'minutes' })
      
      // 1.5 分钟 * 60 * 1000 + 2000ms 缓冲 = 92000ms
      expect(result.sleepMs).toBe(92000)
      expect(result.usageRate).toBe(90) // >= 1 分钟，推断为 90%（> 85%）
      expect(result.alert).toBe(true) // 使用率 > 85%，触发告警
    })

    it('应该优先使用 estimated_time_to_regain_access（秒单位，用于测试）', () => {
      // 如果单位是秒（仅用于测试或特殊场景）
      const usageInfo = { estimated_time_to_regain_access: 1.5 }
      const result = calculateSleepTime(usageInfo, { estimatedTimeUnit: 'seconds' })
      
      // 1.5 秒 * 1000 + 2000ms 缓冲 = 3500ms
      expect(result.sleepMs).toBe(3500)
      expect(result.usageRate).toBe(90) // >= 1 秒，推断为 90%（> 85%）
      expect(result.alert).toBe(true)
    })

    it('应该根据使用率 >= 90% 返回 2 分钟休眠时间', () => {
      // 没有 estimated_time_to_regain_access，使用使用率分档逻辑
      // 注意：使用率计算方式：usageRate = (call_count / (total_time * 10)) * 100
      // 要得到 >= 90% 的使用率，需要：call_count >= total_time * 10 * 0.9
      // 例如：total_time = 100，需要 call_count >= 900
      const usageInfo = { call_count: 950, total_time: 100 } // 950 / 1000 = 95% 使用率
      const result = calculateSleepTime(usageInfo)
      // 使用率 >= 90%，休眠 2 分钟 = 120000ms
      expect(result.sleepMs).toBe(120000)
      expect(result.alert).toBe(true)
    })

    it('应该根据使用率 >= 80% 返回 30 秒休眠时间', () => {
      // 要得到 >= 80% 的使用率，需要：call_count >= total_time * 10 * 0.8
      // 例如：total_time = 100，需要 call_count >= 800
      const usageInfo = { call_count: 850, total_time: 100 } // 850 / 1000 = 85% 使用率
      const result = calculateSleepTime(usageInfo)
      // 使用率 >= 80%，休眠 30 秒 = 30000ms
      expect(result.sleepMs).toBe(30000)
      expect(result.alert).toBe(false)
    })
    
    it('应该忽略 estimated_time_to_regain_access 为 0 的情况', () => {
      // Facebook API 经常返回 0，表示不需要等待
      const usageInfo = { estimated_time_to_regain_access: 0, call_count: 950, total_time: 100 }
      const result = calculateSleepTime(usageInfo)
      // 应该走使用率分档逻辑，而不是 estimated_time 逻辑
      expect(result.sleepMs).toBe(120000) // 95% 使用率，休眠 2 分钟
      expect(result.alert).toBe(true)
    })

    it('应该在没有使用率信息时使用默认休眠时间', () => {
      const result = calculateSleepTime(null)
      expect(result.sleepMs).toBe(1000)
      expect(result.usageRate).toBeNull()
    })
  })

  describe('Token 熔断器', () => {
    it('应该在连续 3 次失败后触发熔断', () => {
      // 模拟 3 次 190 错误
      const error1 = { error: { code: 190, message: 'Invalid OAuth access token' } }
      const error2 = { error: { code: 190, message: 'Invalid OAuth access token' } }
      const error3 = { error: { code: 190, message: 'Invalid OAuth access token' } }

      expect(() => checkTokenError(error1)).not.toThrow()
      expect(() => checkTokenError(error2)).not.toThrow()
      expect(() => checkTokenError(error3)).toThrow('Token 已失效，系统已自动锁定')
    })

    it('应该在成功请求后重置失败计数', () => {
      const error = { error: { code: 190, message: 'Invalid OAuth access token' } }
      checkTokenError(error)
      expect(getCircuitBreakerStatus().failureCount).toBe(1)

      recordSuccess()
      expect(getCircuitBreakerStatus().failureCount).toBe(0)
      expect(getCircuitBreakerStatus().isLocked).toBe(false)
    })

    it('应该忽略非 190 错误', () => {
      const error = { error: { code: 100, message: 'Other error' } }
      checkTokenError(error)
      expect(getCircuitBreakerStatus().failureCount).toBe(0)
    })
  })

  describe('fetchWithTimeout', () => {
    it('应该在超时后抛出错误', async () => {
      const slowPromise = new Promise(resolve => setTimeout(resolve, 1000))
      await expect(fetchWithTimeout(slowPromise, 100)).rejects.toThrow('请求超时')
    })

    it('应该在超时前完成请求', async () => {
      const fastPromise = Promise.resolve('success')
      const result = await fetchWithTimeout(fastPromise, 1000)
      expect(result).toBe('success')
    })
  })
})

