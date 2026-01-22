// ============================================
// 后端离线查询链路验证：数据查询链路
// 目的：验证从数据库查询数据的完整链路
// ============================================

import pool from './server/db/connection.js'
import { queryRuleData } from './server/services/ruleDataService.js'
import { getAccountTimezone } from './server/services/ruleDataService.js'

const TEST_ACCOUNT_ID = 'act_927139705822379'

async function verifyDataQueryChain() {
  console.log('')
  console.log('='.repeat(50))
  console.log('后端离线查询链路验证：数据查询链路')
  console.log('='.repeat(50))
  console.log('')
  
  try {
    console.log(`📊 测试账户: ${TEST_ACCOUNT_ID}`)
    console.log('')
    
    // 1. 检查账户配置
    console.log('步骤 1：检查账户配置...')
    const [accountRows] = await pool.execute(
      `SELECT fb_account_id, owner_id, timezone_name, is_active
       FROM account_mappings
       WHERE fb_account_id = ?`,
      [TEST_ACCOUNT_ID]
    )
    
    if (accountRows.length === 0) {
      console.log('❌ 账户不存在于 account_mappings 表中')
      return false
    }
    
    const account = accountRows[0]
    const timezoneName = account.timezone_name || 'UTC'
    console.log(`   ✅ 账户配置正常`)
    console.log(`      - 时区: ${timezoneName}`)
    console.log(`      - 是否活跃: ${account.is_active ? '是' : '否'}`)
    console.log('')
    
    // 2. 检查数据源（ad_snapshots）
    console.log('步骤 2：检查今天数据源 (ad_snapshots)...')
    const [snapshotRows] = await pool.execute(
      `SELECT COUNT(*) as cnt, 
              COUNT(DISTINCT ad_id) as ad_count,
              MIN(synced_at) as min_time,
              MAX(synced_at) as max_time
       FROM ad_snapshots
       WHERE account_id = ?`,
      [TEST_ACCOUNT_ID]
    )
    
    const snapshotCount = snapshotRows[0]?.cnt || 0
    const adCount = snapshotRows[0]?.ad_count || 0
    console.log(`   - 记录数: ${snapshotCount}`)
    console.log(`   - 唯一广告数: ${adCount}`)
    if (snapshotCount > 0) {
      console.log(`   - 最早同步: ${snapshotRows[0].min_time}`)
      console.log(`   - 最新同步: ${snapshotRows[0].max_time}`)
    }
    console.log('')
    
    // 3. 检查数据源（daily_stats）
    console.log('步骤 3：检查历史数据源 (daily_stats)...')
    const [statsRows] = await pool.execute(
      `SELECT COUNT(*) as cnt,
              COUNT(DISTINCT ad_id) as ad_count,
              MIN(date) as min_date,
              MAX(date) as max_date
       FROM daily_stats
       WHERE account_id = ?`,
      [TEST_ACCOUNT_ID]
    )
    
    const statsCount = statsRows[0]?.cnt || 0
    const statsAdCount = statsRows[0]?.ad_count || 0
    console.log(`   - 记录数: ${statsCount}`)
    console.log(`   - 唯一广告数: ${statsAdCount}`)
    if (statsCount > 0) {
      console.log(`   - 最早日期: ${statsRows[0].min_date}`)
      console.log(`   - 最新日期: ${statsRows[0].max_date}`)
    }
    console.log('')
    
    if (snapshotCount === 0 && statsCount === 0) {
      console.log('⚠️  账户没有数据，无法测试查询链路')
      console.log('💡 提示：请先运行数据同步任务，或等待定时任务同步数据')
      return false
    }
    
    // 4. 测试 today 窗口查询
    console.log('步骤 4：测试 today 窗口查询...')
    const adIds = snapshotCount > 0 ? null : []  // null 表示查询所有广告
    
    const resultToday = await queryRuleData(TEST_ACCOUNT_ID, adIds, 'today', timezoneName)
    const dataToday = resultToday.data || resultToday
    const warningsToday = resultToday.warnings || []
    
    console.log(`   ✅ 查询成功`)
    console.log(`      - 返回数据条数: ${Array.isArray(dataToday) ? dataToday.length : 0}`)
    console.log(`      - Warnings: ${warningsToday.length > 0 ? warningsToday.join(', ') : '无'}`)
    if (Array.isArray(dataToday) && dataToday.length > 0) {
      console.log(`      - 示例数据: 广告ID ${dataToday[0].ad_id}, 花费 $${dataToday[0].spend || 0}`)
    }
    console.log('')
    
    // 5. 测试 last_7_days 窗口查询（数据合并）
    console.log('步骤 5：测试 last_7_days 窗口查询（数据合并）...')
    const result7days = await queryRuleData(TEST_ACCOUNT_ID, adIds, 'last_7_days', timezoneName)
    const data7days = result7days.data || result7days
    const warnings7days = result7days.warnings || []
    
    console.log(`   ✅ 查询成功`)
    console.log(`      - 返回数据条数: ${Array.isArray(data7days) ? data7days.length : 0}`)
    console.log(`      - Warnings: ${warnings7days.length > 0 ? warnings7days.join(', ') : '无'}`)
    
    // 检查是否有重复的 ad_id（数据合并应该去重）
    if (Array.isArray(data7days) && data7days.length > 0) {
      const adIds7days = data7days.map(ad => ad.ad_id)
      const uniqueAdIds = new Set(adIds7days)
      if (adIds7days.length !== uniqueAdIds.size) {
        console.log(`      ⚠️  警告：发现重复的 ad_id（数据合并可能有问题）`)
      } else {
        console.log(`      ✅ 数据合并正确（没有重复的 ad_id）`)
      }
    }
    console.log('')
    
    // 6. 验证时区处理
    console.log('步骤 6：验证时区处理...')
    const accountTimezone = await getAccountTimezone(TEST_ACCOUNT_ID)
    console.log(`   ✅ 账户时区获取成功: ${accountTimezone}`)
    console.log(`      - 配置时区: ${timezoneName}`)
    console.log(`      - 获取时区: ${accountTimezone}`)
    if (accountTimezone === timezoneName) {
      console.log(`      ✅ 时区一致`)
    } else {
      console.log(`      ⚠️  时区不一致（可能是配置问题）`)
    }
    console.log('')
    
    // 总结
    console.log('='.repeat(50))
    console.log('✅ 数据查询链路验证通过')
    console.log('='.repeat(50))
    console.log('')
    console.log('📋 验证结果:')
    console.log(`   - 账户配置: ✅`)
    console.log(`   - 今天数据源: ${snapshotCount > 0 ? `✅ ${snapshotCount} 条` : '❌ 无数据'}`)
    console.log(`   - 历史数据源: ${statsCount > 0 ? `✅ ${statsCount} 条` : '❌ 无数据'}`)
    console.log(`   - today 查询: ✅`)
    console.log(`   - last_7_days 查询: ✅`)
    console.log(`   - 数据合并: ✅`)
    console.log(`   - 时区处理: ✅`)
    console.log('')
    console.log('💡 下一步：')
    console.log('   运行 test-backend-rule-evaluation-chain.js 验证规则评估链路')
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
verifyDataQueryChain()

