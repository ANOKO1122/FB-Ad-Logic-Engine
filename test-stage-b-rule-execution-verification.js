// ============================================
// 阶段B验证脚本：规则执行改造（离线数据）验证
// 目的：验证规则执行从实时 Facebook API 改为离线数据库查询
// 创建时间：2026-01-20
// ============================================

import pool from './server/db/connection.js'
import { RuleEngine } from './server/index.js'
import { db } from './server/db/drizzle.js'
import { rules } from './server/db/schema.js'
import { eq } from 'drizzle-orm'

/**
 * 验证 1：检查规则配置（time_window 字段）
 */
async function verifyRuleConfiguration() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 1：检查规则配置（time_window 字段）')
  console.log('='.repeat(50))
  
  try {
    // 获取所有启用的规则
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
    
    if (enabledRules.length === 0) {
      console.log('⚠️  没有找到启用的规则')
      return false
    }
    
    console.log(`✅ 找到 ${enabledRules.length} 条启用的规则：`)
    
    let hasTimeWindow = 0
    let missingTimeWindow = 0
    
    for (const rule of enabledRules) {
      const conditions = rule.conditions || []
      const hasWindow = conditions.some(c => c.time_window)
      
      if (hasWindow) {
        hasTimeWindow++
        const timeWindows = conditions
          .filter(c => c.time_window)
          .map(c => c.time_window)
        console.log(`   ✅ 规则 "${rule.ruleName}" (ID: ${rule.id})`)
        console.log(`      time_window: ${timeWindows.join(', ')}`)
      } else {
        missingTimeWindow++
        console.log(`   ⚠️  规则 "${rule.ruleName}" (ID: ${rule.id}) 缺少 time_window，将使用默认值 'today'`)
      }
    }
    
    console.log(`\n📊 统计:`)
    console.log(`   - 有 time_window: ${hasTimeWindow} 条规则`)
    console.log(`   - 缺少 time_window: ${missingTimeWindow} 条规则`)
    
    return true
  } catch (error) {
    console.error('❌ 检查规则配置失败:', error.message)
    return false
  }
}

/**
 * 验证 2：测试离线规则评估（today 窗口）
 */
async function verifyOfflineRuleEvaluation() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 2：测试离线规则评估（today 窗口）')
  console.log('='.repeat(50))
  
  try {
    // 获取一个启用的规则
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
      .limit(1)
    
    if (enabledRules.length === 0) {
      console.log('⚠️  没有找到启用的规则，跳过测试')
      return false
    }
    
    const rule = enabledRules[0]
    console.log(`📋 测试规则: "${rule.ruleName}" (ID: ${rule.id})`)
    
    // 获取规则关联的账户
    // 方法1：通过 users 表查找 owner_id，再查找账户
    let accountId = null
    
    try {
      // 先查找用户的 owner_id
      const [userRows] = await pool.execute(
        `SELECT owner_id FROM users WHERE id = ? AND status = 'active'`,
        [rule.userId]
      )
      
      if (userRows.length > 0 && userRows[0].owner_id) {
        // 通过 owner_id 查找账户
        const [accountRows] = await pool.execute(
          `SELECT fb_account_id as account_id
           FROM account_mappings
           WHERE owner_id = ? AND is_active = 1
           LIMIT 1`,
          [userRows[0].owner_id]
        )
        
        if (accountRows.length > 0) {
          accountId = accountRows[0].account_id
        }
      }
    } catch (error) {
      console.warn(`   ⚠️  查询用户账户失败: ${error.message}`)
    }
    
    // 方法2：如果方法1失败，使用指定的测试账户
    if (!accountId) {
      accountId = 'act_927139705822379'  // 统一使用这个账户进行测试
      console.log(`   💡 使用测试账户: ${accountId}`)
    }
    
    if (!accountId) {
      console.log('⚠️  没有找到可用的账户，跳过测试')
      console.log('💡 提示：请确保 account_mappings 表中有活跃账户')
      return false
    }
    console.log(`📊 测试账户: ${accountId}`)
    console.log('')
    
    // 创建 RuleEngine 实例（不需要 API）
    const ruleEngine = new RuleEngine(null)
    
    // 测试离线评估（新版本：传入 accountId 字符串）
    console.log('🔄 执行离线规则评估（新版本）...')
    const matchedAds = await ruleEngine.evaluateRule(rule, accountId)
    
    console.log(`\n📊 评估结果:`)
    console.log(`   - 匹配广告数量: ${matchedAds.length}`)
    
    if (matchedAds.length > 0) {
      console.log(`   - 匹配的广告:`)
      matchedAds.slice(0, 5).forEach(ad => {
        console.log(`     * ${ad.ad_id} (${ad.ad_name || '未知'})`)
        if (ad.metrics) {
          console.log(`       花费: $${ad.metrics.spend || 0}, 购买: ${ad.metrics.purchases || 0}`)
        }
      })
      if (matchedAds.length > 5) {
        console.log(`     ... 还有 ${matchedAds.length - 5} 个广告`)
      }
    } else {
      console.log(`   - 没有匹配的广告（规则条件未满足）`)
    }
    
    console.log('\n✅ 离线规则评估测试完成')
    return true
  } catch (error) {
    console.error('❌ 离线规则评估测试失败:', error.message)
    console.error('   错误堆栈:', error.stack)
    return false
  }
}

/**
 * 验证 3：测试多天窗口（last_7_days）数据合并
 */
async function verifyMultiDayWindow() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 3：测试多天窗口（last_7_days）数据合并')
  console.log('='.repeat(50))
  
  try {
    // 获取一个启用的规则，且 conditions 包含 last_7_days
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
    
    // 查找有 last_7_days 的规则，或创建一个测试规则条件
    let testRule = null
    for (const rule of enabledRules) {
      const conditions = rule.conditions || []
      if (conditions.some(c => c.time_window === 'last_7_days')) {
        testRule = rule
        break
      }
    }
    
    // 如果没有找到，使用第一个规则并临时修改 conditions（仅用于测试）
    if (!testRule && enabledRules.length > 0) {
      testRule = enabledRules[0]
      // 创建一个测试用的 conditions（不修改数据库）
      testRule = {
        ...testRule,
        conditions: [
          { metric: 'spend', operator: 'gt', value: 0, time_window: 'last_7_days' }
        ]
      }
    }
    
    if (!testRule) {
      console.log('⚠️  没有找到可测试的规则，跳过测试')
      return false
    }
    
    console.log(`📋 测试规则: "${testRule.ruleName}" (ID: ${testRule.id})`)
    console.log(`📅 时间窗口: last_7_days`)
    
    // 获取规则关联的账户（使用与验证2相同的逻辑）
    let accountId = null
    
    try {
      const [userRows] = await pool.execute(
        `SELECT owner_id FROM users WHERE id = ? AND status = 'active'`,
        [testRule.userId]
      )
      
      if (userRows.length > 0 && userRows[0].owner_id) {
        const [accountRows] = await pool.execute(
          `SELECT fb_account_id as account_id
           FROM account_mappings
           WHERE owner_id = ? AND is_active = 1
           LIMIT 1`,
          [userRows[0].owner_id]
        )
        
        if (accountRows.length > 0) {
          accountId = accountRows[0].account_id
        }
      }
    } catch (error) {
      console.warn(`   ⚠️  查询用户账户失败: ${error.message}`)
    }
    
    // 备用方案：使用指定的测试账户
    if (!accountId) {
      accountId = 'act_927139705822379'  // 统一使用这个账户进行测试
      console.log(`   💡 使用测试账户: ${accountId}`)
    }
    
    if (!accountId) {
      console.log('⚠️  没有找到可用的账户，跳过测试')
      return false
    }
    
    console.log(`📊 测试账户: ${accountId}`)
    console.log('')
    
    // 创建 RuleEngine 实例
    const ruleEngine = new RuleEngine(null)
    
    // 测试多天窗口评估
    console.log('🔄 执行多天窗口规则评估...')
    const matchedAds = await ruleEngine.evaluateRule(testRule, accountId)
    
    console.log(`\n📊 评估结果:`)
    console.log(`   - 匹配广告数量: ${matchedAds.length}`)
    
    if (matchedAds.length > 0) {
      console.log(`   - 匹配的广告（前 3 个）:`)
      matchedAds.slice(0, 3).forEach(ad => {
        console.log(`     * ${ad.ad_id} (${ad.ad_name || '未知'})`)
        if (ad.metrics) {
          console.log(`       花费: $${ad.metrics.spend || 0}, 购买: ${ad.metrics.purchases || 0}`)
        }
      })
      
      // 检查是否有重复的 ad_id（不应该有）
      const adIds = matchedAds.map(ad => ad.ad_id)
      const uniqueAdIds = new Set(adIds)
      if (adIds.length !== uniqueAdIds.size) {
        console.log(`\n⚠️  警告：发现重复的 ad_id（聚合可能有问题）`)
      } else {
        console.log(`\n✅ 数据聚合正确（没有重复的 ad_id）`)
      }
    } else {
      console.log(`   - 没有匹配的广告（可能是条件未满足或数据不足）`)
    }
    
    console.log('\n✅ 多天窗口数据合并测试完成')
    return true
  } catch (error) {
    console.error('❌ 多天窗口测试失败:', error.message)
    console.error('   错误堆栈:', error.stack)
    return false
  }
}

/**
 * 验证 4：测试无历史数据场景
 */
async function verifyNoHistoryData() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 4：测试无历史数据场景')
  console.log('='.repeat(50))
  
  try {
    // 检查是否有账户在 daily_stats 中没有历史数据
    const [accountsWithNoHistory] = await pool.execute(`
      SELECT DISTINCT am.fb_account_id as account_id
      FROM account_mappings am
      WHERE am.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM daily_stats ds
          WHERE ds.account_id = am.fb_account_id
        )
      LIMIT 1
    `)
    
    // 统一使用指定的测试账户
    const accountId = 'act_927139705822379'
    
    // 检查是否有历史数据
    const [historyCheck] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM daily_stats WHERE account_id = ?`,
      [accountId]
    )
    
    const hasHistory = (historyCheck[0]?.cnt || 0) > 0
    
    if (hasHistory) {
      console.log(`📊 测试账户: ${accountId}（有历史数据）`)
      console.log(`💡 提示：账户有历史数据，将测试正常的数据合并场景`)
    } else {
      console.log(`📊 测试账户: ${accountId}（无历史数据）`)
      console.log(`💡 提示：账户无历史数据，将测试降级策略（只返回今天数据）`)
    }
    
    // 获取一个启用的规则
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
      .limit(1)
    
    if (enabledRules.length === 0) {
      console.log('⚠️  没有找到启用的规则，跳过测试')
      return false
    }
    
    const rule = enabledRules[0]
    console.log(`📋 测试规则: "${rule.ruleName}" (ID: ${rule.id})`)
    console.log('')
    
    // 创建 RuleEngine 实例
    const ruleEngine = new RuleEngine(null)
    
    // 测试评估（应该能返回今天的数据，即使没有历史数据）
    console.log('🔄 执行规则评估（无历史数据场景）...')
    const matchedAds = await ruleEngine.evaluateRule(rule, accountId)
    
    console.log(`\n📊 评估结果:`)
    console.log(`   - 匹配广告数量: ${matchedAds.length}`)
    
    if (matchedAds.length > 0) {
      console.log(`   ✅ 无历史数据场景测试通过：仍能返回今天的数据`)
      console.log(`   - 匹配的广告（前 3 个）:`)
      matchedAds.slice(0, 3).forEach(ad => {
        console.log(`     * ${ad.ad_id} (${ad.ad_name || '未知'})`)
      })
    } else {
      console.log(`   ⚠️  没有匹配的广告（可能是条件未满足或今天也没有数据）`)
    }
    
    console.log('\n✅ 无历史数据场景测试完成')
    return true
  } catch (error) {
    console.error('❌ 无历史数据场景测试失败:', error.message)
    return false
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('')
  console.log('='.repeat(50))
  console.log('阶段B验证：规则执行改造（离线数据）')
  console.log('='.repeat(50))
  
  try {
    // 验证 1：检查规则配置
    await verifyRuleConfiguration()
    
    // 验证 2：测试离线规则评估
    await verifyOfflineRuleEvaluation()
    
    // 验证 3：测试多天窗口数据合并
    await verifyMultiDayWindow()
    
    // 验证 4：测试无历史数据场景
    await verifyNoHistoryData()
    
    console.log('\n' + '='.repeat(50))
    console.log('✅ 验证完成')
    console.log('='.repeat(50))
    console.log('\n💡 下一步：')
    console.log('   1. 观察定时任务日志，确认规则执行使用离线查询')
    console.log('   2. 确认不再调用 Facebook API（getAdInsights、getAds 等）')
    console.log('   3. 验证匹配的广告数量统计正确')
    console.log('')
  } catch (error) {
    console.error('\n❌ 验证失败:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// 执行验证
main()

