// 实时监控服务
import facebookApi from './facebookApi.js'

class MonitorService {
  constructor() {
    this.intervals = new Map()
    this.callbacks = new Map()
    this.options = new Map()
  }

  // 开始监控指定账户
  startMonitoring(accountId, intervalMs = 60000, insightsOptions = null) {
    if (this.intervals.has(accountId)) {
      this.stopMonitoring(accountId)
    }

    this.options.set(accountId, insightsOptions)

    const interval = setInterval(async () => {
      try {
        const opt = this.options.get(accountId) || null
        // opt 可能是 { preset, level } 格式，需要拆开传给 getAdInsights
        const timeRange = opt?.preset ? { preset: opt.preset } : null
        const options = { level: opt?.level }
        const insights = await facebookApi.getAdInsights(accountId, timeRange, options)
        const callbacks = this.callbacks.get(accountId) || []
        callbacks.forEach(callback => callback(insights))
      } catch (error) {
        console.error('监控数据获取失败:', error)
        const callbacks = this.callbacks.get(accountId) || []
        callbacks.forEach(callback => callback(null, error))
      }
    }, intervalMs)

    // 立即执行一次
    const opt = this.options.get(accountId) || null
    const timeRange = opt?.preset ? { preset: opt.preset } : null
    const options = { level: opt?.level }
    facebookApi.getAdInsights(accountId, timeRange, options)
      .then(insights => {
        const callbacks = this.callbacks.get(accountId) || []
        callbacks.forEach(callback => callback(insights))
      })
      .catch(error => {
        const callbacks = this.callbacks.get(accountId) || []
        callbacks.forEach(callback => callback(null, error))
      })

    this.intervals.set(accountId, interval)
  }

  // 停止监控
  stopMonitoring(accountId) {
    const interval = this.intervals.get(accountId)
    if (interval) {
      clearInterval(interval)
      this.intervals.delete(accountId)
    }
    this.callbacks.delete(accountId)
    this.options.delete(accountId)
  }

  // 订阅监控数据更新
  subscribe(accountId, callback) {
    if (!this.callbacks.has(accountId)) {
      this.callbacks.set(accountId, [])
    }
    this.callbacks.get(accountId).push(callback)

    // 返回取消订阅函数
    return () => {
      const callbacks = this.callbacks.get(accountId)
      if (callbacks) {
        const index = callbacks.indexOf(callback)
        if (index > -1) {
          callbacks.splice(index, 1)
        }
      }
    }
  }

  // 停止所有监控
  stopAll() {
    this.intervals.forEach((interval) => clearInterval(interval))
    this.intervals.clear()
    this.callbacks.clear()
  }
}

export default new MonitorService()

