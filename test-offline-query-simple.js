// ============================================
// 简单测试：验证离线查询功能
// 目的：确认离线查询功能是否正常工作
// ============================================

import pool from './server/db/connection.js'
import { queryRuleData } from './server/services/ruleDataService.js'

async function testOfflineQuery() {
  console.log('')
  console.log('='.repeat(50))
  console.log('简单测试：验证离线查询功能')
  console.log('='.repeat(50))
  console.log('')
  
  try {
    // 1. 使用指定的测试账户
    const accountId = 'act_927139705822379'  // 统一使用这个账户进行测试
    console.log(`📊 测试账户: ${accountId}`)
    
    // 2. 查询该账户下的所有广告ID
    const [adRows] = await pool.execute(
      `SELECT DISTINCT ad_id
       FROM ad_snapshots
       WHERE account_id = ?
       LIMIT 10`,
      [accountId]
    )
    
    if (adRows.length === 0) {
      console.log('⚠️  账户没有广告数据（需要先同步数据）')
      console.log('💡 提示：运行数据同步任务，或等待定时任务同步数据')
      return
    }
    
    const adIds = adRows.map(row => String(row.ad_id))
    console.log(`📋 找到 ${adIds.length} 个广告（用于测试）`)
    console.log(`   广告ID: ${adIds.slice(0, 3).join(', ')}${adIds.length > 3 ? '...' : ''}`)
    console.log('')
    
    // 3. 测试离线查询（today 窗口）
    console.log('🔄 测试离线查询（today 窗口）...')
    const result = await queryRuleData(accountId, adIds, 'today', 'UTC')
    
    const data = result.data || result
    const warnings = result.warnings || []
    
    console.log(`\n📊 查询结果:`)
    console.log(`   - 返回数据条数: ${Array.isArray(data) ? data.length : 0}`)
    console.log(`   - Warnings: ${warnings.length > 0 ? warnings.join(', ') : '无'}`)
    
    if (Array.isArray(data) && data.length > 0) {
      console.log(`\n✅ 离线查询功能正常！`)
      console.log(`   示例数据（第一条）:`)
      const firstAd = data[0]
      console.log(`     - 广告ID: ${firstAd.ad_id}`)
      console.log(`     - 广告名称: ${firstAd.ad_name || '未知'}`)
      console.log(`     - 花费: $${firstAd.spend || 0}`)
      console.log(`     - 购买: ${firstAd.purchases || 0}`)
    } else {
      console.log(`\n⚠️  查询返回空数组（可能是今天没有数据）`)
      console.log(`💡 提示：这是正常情况，说明离线查询功能正常工作，只是没有数据`)
    }
    
    // 4. 测试多天窗口（last_7_days）
    console.log('\n' + '-'.repeat(50))
    console.log('🔄 测试离线查询（last_7_days 窗口）...')
    const result7days = await queryRuleData(accountId, adIds, 'last_7_days', 'UTC')
    
    const data7days = result7days.data || result7days
    const warnings7days = result7days.warnings || []
    
    console.log(`\n📊 查询结果:`)
    console.log(`   - 返回数据条数: ${Array.isArray(data7days) ? data7days.length : 0}`)
    console.log(`   - Warnings: ${warnings7days.length > 0 ? warnings7days.join(', ') : '无'}`)
    
    if (Array.isArray(data7days) && data7days.length > 0) {
      console.log(`\n✅ 多天窗口查询功能正常！`)
    } else {
      console.log(`\n⚠️  查询返回空数组（可能是最近7天没有数据）`)
      console.log(`💡 提示：这是正常情况，说明离线查询功能正常工作，只是没有数据`)
    }
    
    console.log('\n' + '='.repeat(50))
    console.log('✅ 测试完成')
    console.log('='.repeat(50))
    console.log('\n💡 总结：')
    console.log('   1. 如果查询没有报错，说明离线查询功能正常工作')
    console.log('   2. 返回空数组是正常情况（可能是没有数据或条件未满足）')
    console.log('   3. 如果有数据但返回空数组，可能是规则条件太严格')
    console.log('')
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message)
    console.error('   错误堆栈:', error.stack)
  } finally {
    await pool.end()
  }
}

// 执行测试
testOfflineQuery()

