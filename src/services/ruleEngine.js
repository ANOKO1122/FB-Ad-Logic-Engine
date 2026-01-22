// 自动规则引擎服务
import facebookApi from './facebookApi.js'

class RuleEngineService {
  constructor() {
    this.rules = []
    this.executionIntervals = new Map()
    this.storageKey = 'facebook_auto_rules'
  }

  // 添加规则
  addRule(rule) {
    this.rules.push({
      id: this.generateId(),
      ...rule,
      enabled: rule.enabled !== undefined ? rule.enabled : true
    })
    this.saveRules()
  }

  // 更新规则
  updateRule(ruleId, updates) {
    const index = this.rules.findIndex(r => r.id === ruleId)
    if (index > -1) {
      this.rules[index] = { ...this.rules[index], ...updates }
      this.saveRules()
    }
  }

  // 删除规则
  deleteRule(ruleId) {
    this.rules = this.rules.filter(r => r.id !== ruleId)
    this.saveRules()
  }

  // 获取所有规则
  getRules() {
    return [...this.rules]
  }

  // 启用/禁用规则
  toggleRule(ruleId, enabled) {
    this.updateRule(ruleId, { enabled })
  }

  // 开始自动执行规则
  startAutoExecution(accountId, intervalMs = 300000) { // 默认5分钟执行一次
    if (this.executionIntervals.has(accountId)) {
      this.stopAutoExecution(accountId)
    }

    const interval = setInterval(async () => {
      await this.executeRules(accountId)
    }, intervalMs)

    // 立即执行一次
    this.executeRules(accountId)

    this.executionIntervals.set(accountId, interval)
  }

  // 停止自动执行
  stopAutoExecution(accountId) {
    const interval = this.executionIntervals.get(accountId)
    if (interval) {
      clearInterval(interval)
      this.executionIntervals.delete(accountId)
    }
  }

  // 手动执行规则
  async executeRules(accountId) {
    const enabledRules = this.rules.filter(r => r.enabled)
    if (enabledRules.length === 0) return []

    try {
      const results = await facebookApi.executeRules(accountId, enabledRules)
      return results
    } catch (error) {
      console.error('规则执行失败:', error)
      return []
    }
  }

  // 保存规则到本地存储
  saveRules() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.rules))
  }

  // 从本地存储加载规则
  loadRules() {
    const saved = localStorage.getItem(this.storageKey)
    if (saved) {
      try {
        this.rules = JSON.parse(saved)
      } catch (error) {
        console.error('加载规则失败:', error)
        this.rules = []
      }
    }
  }

  // 设置规则作用域：做到“谁设的规则谁管”
  // - 不同用户（或负责人）使用不同 localStorage key，避免同一台机器切换账号互相污染
  setScope(scopeKey) {
    const key = String(scopeKey || '').trim()
    this.storageKey = key ? `facebook_auto_rules::${key}` : 'facebook_auto_rules'
    this.loadRules()
  }

  // 生成唯一ID
  generateId() {
    return `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

// 初始化时加载规则
const ruleEngine = new RuleEngineService()
ruleEngine.loadRules()

export default ruleEngine

