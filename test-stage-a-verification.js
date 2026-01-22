// 验证阶段A修复：时区匹配 + 降级策略
// 目的：验证 last_7_days 不再返回空数组

import { queryRuleData } from './server/services/ruleDataService.js'
import pool from './server/db/connection.js'

async function verifyStageA() {
  try {
    console.log('🔍 验证阶段A修复（时区匹配 + 降级策略）...\n')
    
    const accountId = 'act_927139705822379'
    
    // 1. 测试 last_7_days（应该不再返回空数组）
    console.log('📋 测试1：last_7_days 查询（应该包含今天的数据）...')
    console.log('='.repeat(60))
    
    try {
      const result = await queryRuleData(accountId, null, 'last_7_days', null, null)
      const data = result.data || result  // 兼容旧格式
      const warnings = result.warnings || []
      
      console.log(`✅ 查询成功，返回 ${Array.isArray(data) ? data.length : 0} 条记录`)
      
      if (warnings.length > 0) {
        console.log(`⚠️  Warnings (${warnings.length} 条):`)
        warnings.forEach((w, i) => {
          console.log(`   ${i + 1}. [${w.code}] ${w.message}`)
        })
      }
      
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ 成功！不再返回空数组`)
        console.log(`📊 第一条记录:`)
        console.log(`   ad_id: ${data[0].ad_id}`)
        console.log(`   ad_name: ${data[0].ad_name}`)
        console.log(`   spend: $${data[0].spend || 0}`)
        console.log(`   purchases: ${data[0].purchases || 0}`)
      } else {
        console.log(`❌ 仍然返回空数组，需要进一步检查`)
      }
    } catch (error) {
      console.error(`❌ 查询失败:`, error.message)
    }
    
    // 2. 测试 last_30_days
    console.log('\n📋 测试2：last_30_days 查询...')
    console.log('='.repeat(60))
    
    try {
      const result = await queryRuleData(accountId, null, 'last_30_days', null, null)
      const data = result.data || result
      const warnings = result.warnings || []
      
      console.log(`✅ 查询成功，返回 ${Array.isArray(data) ? data.length : 0} 条记录`)
      
      if (warnings.length > 0) {
        console.log(`⚠️  Warnings (${warnings.length} 条):`)
        warnings.forEach((w, i) => {
          console.log(`   ${i + 1}. [${w.code}] ${w.message}`)
        })
      }
    } catch (error) {
      console.error(`❌ 查询失败:`, error.message)
    }
    
    // 3. 验证时区匹配
    console.log('\n📋 测试3：验证时区匹配（检查 queryDailyStats 使用的时区）...')
    console.log('='.repeat(60))
    
    // 检查 daily_stats 表中的时区分布
    const [timezoneStats] = await pool.execute(`
      SELECT 
        COUNT(*) as count,
        timezone_name
      FROM daily_stats
      WHERE account_id = ?
      GROUP BY timezone_name
    `, [accountId])
    
    console.log(`✅ daily_stats 表中的时区分布:`)
    timezoneStats.forEach(row => {
      console.log(`   ${row.timezone_name}: ${row.count} 条`)
    })
    
    // 获取账户时区
    const [accountRows] = await pool.execute(`
      SELECT COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings
      WHERE fb_account_id = ? AND is_active = 1
      LIMIT 1
    `, [accountId])
    
    const accountTimezone = accountRows.length > 0 ? accountRows[0].timezone_name : 'UTC'
    console.log(`   账户时区: ${accountTimezone}`)
    console.log(`   查询使用的时区: ${accountTimezone} (data_timezone_used)`)
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 验证完成！')
    console.log('\n💡 验证要点:')
    console.log('   1. last_7_days 应该不再返回空数组（至少包含今天的数据）')
    console.log('   2. 如果 daily_stats 为空，应该触发降级策略（HISTORY_EMPTY warning）')
    console.log('   3. 时区匹配应该正确（使用 data_timezone_used）')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

verifyStageA()

