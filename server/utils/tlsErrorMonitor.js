/**
 * TLS 错误监控模块
 * 
 * 功能：
 * 1. 统计 TLS 错误频率
 * 2. 如果错误频率过高，记录警告
 * 3. 提供错误统计查询接口
 * 
 * 使用场景：
 * - 监控 SOCKS5 代理连接的 TLS 错误
 * - 检测网络连接质量问题
 * - 为优化代理连接提供数据支持
 */

// 错误统计：使用滑动窗口（最近 N 次请求）
const ERROR_WINDOW_SIZE = 100  // 统计最近 100 次请求
const ERROR_THRESHOLD = 0.3    // 错误率阈值：30%（超过此值记录警告）

// 存储最近 N 次请求的错误状态
const requestHistory = []

// 统计信息
let totalRequests = 0
let totalErrors = 0
let lastWarningTime = null
const WARNING_COOLDOWN = 5 * 60 * 1000  // 警告冷却时间：5 分钟

/**
 * 记录一次请求（无论成功或失败）
 * @param {boolean} hasError - 是否有 TLS 错误
 */
export function recordRequest(hasError = false) {
  totalRequests++
  
  if (hasError) {
    totalErrors++
  }
  
  // 添加到滑动窗口
  requestHistory.push({
    timestamp: Date.now(),
    hasError
  })
  
  // 保持窗口大小
  if (requestHistory.length > ERROR_WINDOW_SIZE) {
    requestHistory.shift()
  }
  
  // 检查是否需要记录警告
  checkAndWarn()
}

/**
 * 检查错误率并记录警告（如果过高）
 */
function checkAndWarn() {
  // 如果窗口数据不足，不检查
  if (requestHistory.length < 10) {
    return
  }
  
  // 计算最近窗口内的错误率
  const recentErrors = requestHistory.filter(r => r.hasError).length
  const recentTotal = requestHistory.length
  const errorRate = recentErrors / recentTotal
  
  // 如果错误率超过阈值，且不在冷却期内，记录警告
  if (errorRate > ERROR_THRESHOLD) {
    const now = Date.now()
    if (!lastWarningTime || (now - lastWarningTime) > WARNING_COOLDOWN) {
      lastWarningTime = now
      
      console.warn('')
      console.warn('⚠️  TLS 错误率过高警告')
      console.warn('='.repeat(60))
      console.warn(`📊 统计信息:`)
      console.warn(`   - 最近 ${recentTotal} 次请求中，${recentErrors} 次出现 TLS 错误`)
      console.warn(`   - 错误率: ${(errorRate * 100).toFixed(1)}% (阈值: ${ERROR_THRESHOLD * 100}%)`)
      console.warn(`   - 总请求数: ${totalRequests}`)
      console.warn(`   - 总错误数: ${totalErrors}`)
      console.warn(`   - 总体错误率: ${((totalErrors / totalRequests) * 100).toFixed(1)}%`)
      console.warn('')
      console.warn('💡 建议:')
      console.warn('   1. 检查 SOCKS5 代理服务器连接稳定性')
      console.warn('   2. 检查网络延迟和抖动')
      console.warn('   3. 考虑优化代理连接配置')
      console.warn('   4. 如果问题持续，考虑更换代理服务器')
      console.warn('='.repeat(60))
      console.warn('')
    }
  }
}

/**
 * 获取错误统计信息
 * @returns {Object} 统计信息
 */
export function getErrorStats() {
  const recentErrors = requestHistory.filter(r => r.hasError).length
  const recentTotal = requestHistory.length
  const recentErrorRate = recentTotal > 0 ? recentErrors / recentTotal : 0
  const overallErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0
  
  return {
    totalRequests,
    totalErrors,
    overallErrorRate,
    recentWindowSize: recentTotal,
    recentErrors,
    recentErrorRate,
    isHighErrorRate: recentErrorRate > ERROR_THRESHOLD,
    lastWarningTime
  }
}

/**
 * 重置统计信息（用于测试或手动重置）
 */
export function resetStats() {
  requestHistory.length = 0
  totalRequests = 0
  totalErrors = 0
  lastWarningTime = null
}

