// 验证阶段B实现：合并查询（历史+今天）
// 目的：验证 last_7_days 现在包含历史数据和今天数据，并且有正确的 warnings

import { queryRuleData } from './server/services/ruleDataService.js'
import pool from './server/db/connection.js'

async function verifyStageB() {
  try {
    console.log('🔍 验证阶段B实现（合并查询：历史+今天）...\n')
    
    const accountId = 'act_927139705822379'
    
    // 1. 测试 last_7_days（应该包含历史+今天）
    console.log('📋 测试1：last_7_days 查询（应该包含历史数据和今天数据）...')
    console.log('='.repeat(60))
    
    try {
      const result = await queryRuleData(accountId, null, 'last_7_days', null, null)
      const data = result.data || result
      const warnings = result.warnings || []
      
      console.log(`✅ 查询成功，返回 ${Array.isArray(data) ? data.length : 0} 条记录`)
      
      if (warnings.length > 0) {
        console.log(`⚠️  Warnings (${warnings.length} 条):`)
        warnings.forEach((w, i) => {
          console.log(`   ${i + 1}. [${w.code}] ${w.message}`)
        })
      }
      
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ 成功！返回了合并后的数据`)
        console.log(`📊 第一条记录:`)
        console.log(`   ad_id: ${data[0].ad_id}`)
        console.log(`   ad_name: ${data[0].ad_name}`)
        console.log(`   spend: $${data[0].spend || 0}`)
        console.log(`   purchases: ${data[0].purchases || 0}`)
        console.log(`   roas: ${data[0].roas || 0}`)
        console.log(`   cpa: $${data[0].cpa || 0}`)
      } else {
        console.log(`❌ 仍然返回空数组`)
      }
    } catch (error) {
      console.error(`❌ 查询失败:`, error.message)
    }
    
    // 2. 检查数据来源（历史 vs 今天）
    console.log('\n📋 测试2：检查数据来源（历史数据 vs 今天数据）...')
    console.log('='.repeat(60))
    
    // 检查 daily_stats 中的历史数据
    const [historyRows] = await pool.execute(`
      SELECT COUNT(*) as count, MIN(date) as min_date, MAX(date) as max_date
      FROM daily_stats
      WHERE account_id = ?
        AND date < CURDATE()
    `, [accountId])
    
    console.log(`📊 daily_stats 历史数据: ${historyRows[0].count} 条`)
    if (historyRows[0].min_date) {
      console.log(`   日期范围: ${historyRows[0].min_date} 到 ${historyRows[0].max_date}`)
    }
    
    // 检查 ad_snapshots 中的今天数据
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const [todayRows] = await pool.execute(`
      SELECT COUNT(DISTINCT ad_id) as count
      FROM ad_snapshots
      WHERE account_id = ?
        AND synced_at >= ?
    `, [accountId, todayStart])
    
    console.log(`📊 ad_snapshots 今天数据: ${todayRows[0].count} 个广告`)
    
    // 3. 验证时区不匹配警告
    console.log('\n📋 测试3：验证时区不匹配警告...')
    console.log('='.repeat(60))
    
    // 检查 daily_stats 中的时区分布
    const [timezoneRows] = await pool.execute(`
      SELECT DISTINCT timezone_name, COUNT(*) as count
      FROM daily_stats
      WHERE account_id = ?
      GROUP BY timezone_name
    `, [accountId])
    
    console.log(`📊 daily_stats 时区分布:`)
    timezoneRows.forEach(row => {
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
    
    // 如果时区不匹配，应该看到 TIMEZONE_MISMATCH warning
    const hasMismatch = timezoneRows.some(row => row.timezone_name !== accountTimezone)
    if (hasMismatch) {
      console.log(`   ⚠️  时区不匹配：应该看到 TIMEZONE_MISMATCH warning`)
    } else {
      console.log(`   ✅ 时区匹配`)
    }
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 验证完成！')
    console.log('\n💡 验证要点:')
    console.log('   1. last_7_days 应该包含历史数据（daily_stats）和今天数据（ad_snapshots）')
    console.log('   2. 如果时区不匹配，应该看到 TIMEZONE_MISMATCH warning')
    console.log('   3. 如果历史数据为空，应该看到 HISTORY_EMPTY warning（但仍返回今天的数据）')
    console.log('   4. 数据应该正确聚合（避免辛普森悖论）')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

verifyStageB()

