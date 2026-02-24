// API 频率控制与熔断服务
// 按照 TASKS.md 1.3 节的要求实现
// 负责：响应头解析、动态休眠、超时控制、Token 熔断
import logger from '../utils/logger.js'

/**
 * 解析 Facebook API 响应头 x-business-use-case-usage
 * @param {string|Object} headerValue - 响应头的值（可能是字符串或已解析的对象）
 * @returns {Object|null} 解析后的使用率信息，格式：{ call_count: 100, total_cputime: 5000, total_time: 10000 }
 */
export function parseUsageHeader(headerValue) {
  if (!headerValue) {
    return null
  }
  
  try {
    // 如果已经是对象，直接返回
    if (typeof headerValue === 'object') {
      return headerValue
    }
    
    // 如果是字符串，尝试 JSON 解析
    if (typeof headerValue === 'string') {
      const parsed = JSON.parse(headerValue)
      return parsed
    }
    
    return null
  } catch (error) {
    // 解析失败，返回 null（不影响主流程）
    logger.warn('⚠️  解析 x-business-use-case-usage 响应头失败:', error.message)
    return null
  }
}

/**
 * 根据使用率计算动态休眠时间
 * 
 * ⚠️ 重要安全提示：
 * - estimated_time_to_regain_access 的单位通常是**分钟**（Minutes），不是秒！
 * - 如果误将分钟当作秒处理，会导致休眠时间严重不足，触发死循环限流
 * 
 * @param {Object|null} usageInfo - 使用率信息（从 parseUsageHeader 获取）
 * @param {Object} options - 配置选项
 *   - estimatedTimeUnit: 'minutes' | 'seconds' - estimated_time_to_regain_access 的单位（默认 'minutes'）
 *   - safetyBufferMs: number - 安全缓冲时间（毫秒），默认 2000ms（2秒）
 * @returns {Object} { sleepMs: number, usageRate: number, alert: boolean }
 *   - sleepMs: 休眠时间（毫秒）
 *   - usageRate: 使用率（0-100）
 *   - alert: 是否需要告警
 */
export function calculateSleepTime(usageInfo, options = {}) {
  const {
    estimatedTimeUnit = 'minutes', // 默认单位：分钟（Facebook API 标准）
    safetyBufferMs = 2000 // 默认安全缓冲：2秒
  } = options
  
  // 如果没有使用率信息，使用默认休眠时间（保守策略）
  if (!usageInfo) {
    return {
      sleepMs: 1000, // 默认 1 秒
      usageRate: null,
      alert: false
    }
  }
  
  // ============================================
  // 最高优先级：显式等待时间（Explicit Backoff）
  // ============================================
  // 如果 Facebook API 明确返回了 estimated_time_to_regain_access，必须优先使用它
  // 这是 API 的强制要求，不能忽略
  // ⚠️ 重要：必须判断 > 0，因为 FB API 经常返回 0（表示不需要等待）
  if (usageInfo.estimated_time_to_regain_access !== undefined && 
      usageInfo.estimated_time_to_regain_access > 0) {
    const estimatedTime = usageInfo.estimated_time_to_regain_access
    
    // ⚠️ 关键单位换算：
    // - 如果单位是分钟（minutes）：estimatedTime * 60 * 1000
    // - 如果单位是秒（seconds）：estimatedTime * 1000
    let exactWaitMs
    if (estimatedTimeUnit === 'minutes') {
      exactWaitMs = Math.ceil(estimatedTime * 60 * 1000) // 分钟 -> 毫秒
    } else {
      exactWaitMs = Math.ceil(estimatedTime * 1000) // 秒 -> 毫秒
    }
    
    // 添加安全缓冲，防止服务器时间偏差或网络延迟导致刚好撞在枪口上
    const finalWaitMs = exactWaitMs + safetyBufferMs
    
    // 根据恢复时间推断使用率（用于告警）
    // - 恢复时间 < 1 单位：使用率可能在 50-85% 之间
    // - 恢复时间 >= 1 单位：使用率 > 85%
    let usageRate
    let alert = false
    if (estimatedTime < 1) {
      usageRate = 70 // 中等使用率
    } else {
      usageRate = 90 // 高使用率
      alert = true // 触发告警
    }
    
    logger.info(`[RateLimit] ⚠️  Facebook API 强制要求等待 ${estimatedTime} ${estimatedTimeUnit}，系统将休眠 ${finalWaitMs}ms（含 ${safetyBufferMs}ms 安全缓冲）`)
    
    return {
      sleepMs: finalWaitMs,
      usageRate: Math.round(usageRate * 100) / 100,
      alert
    }
  }
  
  // ============================================
  // 次优先级：基于使用率的分档逻辑（Heuristic Backoff）
  // ============================================
  // 只有在没有显式等待时间时，才执行这里的逻辑
  let usageRate = 0
  let sleepMs = 500 // 默认 500ms
  
  if (usageInfo.call_count && usageInfo.total_time) {
    // 使用 call_count 和 total_time 估算使用率
    // 假设最大调用次数为 total_time 的某个倍数（这个需要根据实际情况调整）
    const estimatedMaxCalls = usageInfo.total_time * 10 // 简化估算
    usageRate = Math.min((usageInfo.call_count / estimatedMaxCalls) * 100, 100)
  } else if (usageInfo.call_count) {
    // 只有 call_count，使用简化的估算
    // 假设 call_count > 100 时使用率较高
    usageRate = Math.min((usageInfo.call_count / 100) * 50, 100) // 简化计算
  }
  
  // 根据使用率分档设置休眠时间（只有在没有显式等待时间时才执行）
  let alert = false
  if (usageRate >= 100) {
    sleepMs = 5 * 60 * 1000 // 使用率 100%：休眠 5 分钟
    alert = true
  } else if (usageRate >= 90) {
    sleepMs = 2 * 60 * 1000 // 使用率 >= 90%：休眠 2 分钟
    alert = true
  } else if (usageRate >= 80) {
    sleepMs = 30 * 1000 // 使用率 >= 80%：休眠 30 秒
  } else if (usageRate >= 50) {
    sleepMs = 2000 // 使用率 50%–80%：休眠 2s
  } else {
    sleepMs = 500 // 使用率 < 50%：休眠 500ms
  }
  
  return {
    sleepMs,
    usageRate: Math.round(usageRate * 100) / 100, // 保留两位小数
    alert
  }
}

/** 最近一次已知的 API 使用率（0–100），供结构全量轮转「usage 高本小时跳过」判断 */
let lastKnownUsageRate = null

/**
 * 返回最近一次由 sleepBasedOnUsage/calculateSleepTime 得出的使用率（可能为 null）
 */
export function getLastUsageRate() {
  return lastKnownUsageRate
}

/**
 * 动态休眠（根据使用率）
 * @param {Object|null} usageInfo - 使用率信息
 * @param {Object} options - 配置选项（传递给 calculateSleepTime）
 * @returns {Promise<void>}
 */
export async function sleepBasedOnUsage(usageInfo, options = {}) {
  const { sleepMs, usageRate, alert } = calculateSleepTime(usageInfo, options)
  if (usageRate !== null) lastKnownUsageRate = usageRate

  if (usageRate !== null) {
    logger.info(`⏸️  API 使用率: ${usageRate}%，休眠 ${sleepMs}ms`)
  } else {
    logger.info(`⏸️  使用默认休眠时间: ${sleepMs}ms`)
  }
  
  if (alert) {
    logger.warn(`⚠️  API 使用率过高（${usageRate}%），已触发告警`)
    // TODO: 这里可以发送告警通知（IM 机器人）
  }
  
  await new Promise(resolve => setTimeout(resolve, sleepMs))
}

/**
 * 带超时控制的请求封装
 * @param {Promise} promise - 原始请求 Promise
 * @param {number} timeoutMs - 超时时间（毫秒），默认 45 秒
 * @returns {Promise} 带超时控制的 Promise
 */
export function fetchWithTimeout(promise, timeoutMs = 45000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`请求超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })
  ])
}

/**
 * Token 熔断管理器
 * 维护连续失败计数，达到阈值时熔断
 */
class TokenCircuitBreaker {
  constructor() {
    // 连续失败计数（专门针对 190 错误）
    this.failureCount = 0
    // 系统锁定状态
    this.isSystemLocked = false
    // 最后一次失败时间
    this.lastFailureTime = null
    // 熔断阈值（连续 3 次失败）
    this.threshold = 3
  }
  
  /**
   * 记录失败（190 错误）
   */
  recordFailure() {
    this.failureCount++
    this.lastFailureTime = new Date()
    
    logger.warn(`⚠️  Token 失败计数: ${this.failureCount}/${this.threshold}`)
    
    // 达到阈值，触发熔断
    if (this.failureCount >= this.threshold) {
      this.isSystemLocked = true
      logger.error(`❌ Token 熔断触发：连续 ${this.failureCount} 次失败，系统已锁定`)
      // TODO: 这里可以发送高优先级告警（IM 机器人）
    }
  }
  
  /**
   * 记录成功（重置失败计数）
   */
  recordSuccess() {
    if (this.failureCount > 0) {
      logger.info(`✅ Token 恢复：重置失败计数（之前: ${this.failureCount}）`)
    }
    this.failureCount = 0
    this.isSystemLocked = false
  }
  
  /**
   * 检查是否已熔断
   * @returns {boolean}
   */
  isLocked() {
    return this.isSystemLocked
  }
  
  /**
   * 获取当前状态
   * @returns {Object}
   */
  getStatus() {
    return {
      isLocked: this.isSystemLocked,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      threshold: this.threshold
    }
  }
  
  /**
   * 手动重置熔断器（用于测试或手动恢复）
   */
  reset() {
    logger.info('🔄 手动重置 Token 熔断器')
    this.failureCount = 0
    this.isSystemLocked = false
    this.lastFailureTime = null
  }
}

// 创建全局单例
const tokenCircuitBreaker = new TokenCircuitBreaker()

/**
 * 检查 Token 错误并更新熔断器
 * @param {Error|Object} error - 错误对象或 API 响应
 * @throws {Error} 如果已熔断，抛出错误
 */
export function checkTokenError(error) {
  // 检查是否是 190 错误（Token 失效）
  const errorCode = error?.error?.code || error?.code || error?.response?.data?.error?.code
  const errorMessage = error?.error?.message || error?.message || error?.response?.data?.error?.message || ''
  
  if (errorCode === 190 || errorMessage.includes('Invalid OAuth access token')) {
    tokenCircuitBreaker.recordFailure()
    
    // 如果已熔断，抛出统一错误
    if (tokenCircuitBreaker.isLocked()) {
      throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
    }
  }
  
  // 不是 190 错误或未熔断，不抛出错误（让调用者决定如何处理）
}

/**
 * 记录成功请求（重置熔断器）
 */
export function recordSuccess() {
  tokenCircuitBreaker.recordSuccess()
}

/**
 * 获取熔断器状态
 * @returns {Object}
 */
export function getCircuitBreakerStatus() {
  return tokenCircuitBreaker.getStatus()
}

/**
 * 手动重置熔断器（用于测试或手动恢复）
 */
export function resetCircuitBreaker() {
  tokenCircuitBreaker.reset()
}

// 导出所有函数
export {
  tokenCircuitBreaker
}

