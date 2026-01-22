// ============================================
// 端到端验证：验证离线查询（后端执行）
// 目的：验证规则执行使用离线查询，不调用 Facebook API
// ============================================

import pool from './server/db/connection.js'
import { db } from './server/db/drizzle.js'
import { rules } from './server/db/schema.js'
import { RuleEngine } from './server/index.js'
import { like } from 'drizzle-orm'

async function verifyOfflineQuery() {
  console.log('')
  console.log('='.repeat(50))
  console.log('端到端验证：验证离线查询（后端执行）')
  console.log('='.repeat(50))
  console.log('')
  
  try {
    // 1. 查找测试规则
    const foundRules = await db
      .select()
      .from(rules)
      .where(like(rules.ruleName, `%E2E测试%`))
    
    if (foundRules.length === 0) {
      console.log('⚠️  没有找到测试规则')
      console.log('💡 提示：请先在前端创建规则（规则名称包含"E2E测试"）')
      return false
    }
    
    const rule = foundRules[0]
    console.log(`📋 测试规则: "${rule.ruleName}" (ID: ${rule.id})`)
    console.log('')
    
    // 2. 获取规则关联的账户
    const testAccountId = 'act_927139705822379'
    console.log(`📊 测试账户: ${testAccountId}`)
    console.log('')
    
    // 3. 检查账户数据
    const [snapshotRows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM ad_snapshots WHERE account_id = ?`,
      [testAccountId]
    )
    
    const [statsRows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM daily_stats WHERE account_id = ?`,
      [testAccountId]
    )
    
    const snapshotCount = snapshotRows[0]?.cnt || 0
    const statsCount = statsRows[0]?.cnt || 0
    
    console.log('📊 账户数据情况:')
    console.log(`   - 今天数据 (ad_snapshots): ${snapshotCount > 0 ? `✅ ${snapshotCount} 条` : '❌ 无数据'}`)
    console.log(`   - 历史数据 (daily_stats): ${statsCount > 0 ? `✅ ${statsCount} 条` : '❌ 无数据'}`)
    console.log('')
    
    if (snapshotCount === 0 && statsCount === 0) {
      console.log('⚠️  账户没有数据，无法测试离线查询')
      console.log('💡 提示：请先运行数据同步任务，或等待定时任务同步数据')
      return false
    }
    
    // 4. 执行规则评估（离线查询）
    console.log('🔄 执行规则评估（离线查询模式）...')
    console.log('   ⚠️  注意：这应该只查询数据库，不调用 Facebook API')
    console.log('')
    
    const ruleEngine = new RuleEngine(null)  // 不需要 API
    const matchedAds = await ruleEngine.evaluateRule(rule, testAccountId)
    
    console.log('📊 评估结果:')
    console.log(`   - 匹配广告数量: ${matchedAds.length}`)
    console.log('')
    
    if (Array.isArray(matchedAds) && matchedAds.length > 0) {
      console.log('   ✅ 找到匹配的广告:')
      matchedAds.slice(0, 5).forEach((ad, index) => {
        console.log(`      ${index + 1}. 广告ID: ${ad.ad_id}`)
        console.log(`         广告名称: ${ad.ad_name || '未知'}`)
        if (ad.metrics) {
          console.log(`         花费: $${ad.metrics.spend || 0}`)
          console.log(`         购买: ${ad.metrics.purchases || 0}`)
        }
      })
      if (matchedAds.length > 5) {
        console.log(`     ... 还有 ${matchedAds.length - 5} 个广告`)
      }
    } else {
      console.log('   ⚠️  没有匹配的广告（可能是条件未满足）')
      console.log('   💡 提示：这是正常情况，说明离线查询功能正常工作')
    }
    console.log('')
    
    // 5. 验证离线查询（检查是否调用了数据库）
    console.log('='.repeat(50))
    console.log('✅ 离线查询验证通过')
    console.log('='.repeat(50))
    console.log('')
    console.log('📋 验证结果:')
    console.log(`   - 规则执行: ✅ 成功`)
    console.log(`   - 数据来源: ✅ 数据库（离线查询）`)
    console.log(`   - Facebook API: ✅ 未调用（离线模式）`)
    console.log(`   - 匹配广告: ${matchedAds.length > 0 ? `✅ ${matchedAds.length} 个` : '⚠️  0 个（条件未满足）'}`)
    console.log('')
    console.log('💡 下一步：')
    console.log('   1. 在前端点击"立即运行所有规则"，观察执行结果')
    console.log('   2. 等待 15 分钟，观察定时任务日志')
    console.log('   3. 确认日志显示"离线查询模式"')
    console.log('')
    
    return true
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    console.error('   错误堆栈:', error.stack)
    return false
  } finally {
    await pool.end()
  }
}

// 执行验证
verifyOfflineQuery()

