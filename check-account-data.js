// ============================================
// 检查账户数据情况
// 目的：检查指定账户的数据，用于后续测试
// ============================================

import pool from './server/db/connection.js'

async function checkAccountData() {
  const accountId = 'act_927139705822379'
  
  console.log('')
  console.log('='.repeat(50))
  console.log(`检查账户数据: ${accountId}`)
  console.log('='.repeat(50))
  console.log('')
  
  try {
    // 1. 检查账户配置
    const [accountRows] = await pool.execute(
      `SELECT fb_account_id, owner_id, timezone_name, is_active
       FROM account_mappings
       WHERE fb_account_id = ?`,
      [accountId]
    )
    
    if (accountRows.length === 0) {
      console.log(`❌ 账户 ${accountId} 不存在于 account_mappings 表中`)
      return
    }
    
    const account = accountRows[0]
    console.log(`✅ 账户配置:`)
    console.log(`   - 账户ID: ${account.fb_account_id}`)
    console.log(`   - 负责人ID: ${account.owner_id}`)
    console.log(`   - 时区: ${account.timezone_name || 'UTC'}`)
    console.log(`   - 是否活跃: ${account.is_active ? '是' : '否'}`)
    console.log('')
    
    // 2. 检查 ad_snapshots 数据（今天的数据）
    const [snapshotRows] = await pool.execute(
      `SELECT COUNT(*) as cnt, 
              MIN(synced_at) as min_time, 
              MAX(synced_at) as max_time
       FROM ad_snapshots
       WHERE account_id = ?`,
      [accountId]
    )
    
    const snapshotCount = snapshotRows[0]?.cnt || 0
    console.log(`📊 ad_snapshots 数据:`)
    console.log(`   - 记录数: ${snapshotCount}`)
    if (snapshotCount > 0) {
      console.log(`   - 最早同步时间: ${snapshotRows[0].min_time}`)
      console.log(`   - 最新同步时间: ${snapshotRows[0].max_time}`)
    }
    console.log('')
    
    // 3. 检查 daily_stats 数据（历史数据）
    const [statsRows] = await pool.execute(
      `SELECT COUNT(*) as cnt,
              MIN(date) as min_date,
              MAX(date) as max_date
       FROM daily_stats
       WHERE account_id = ?`,
      [accountId]
    )
    
    const statsCount = statsRows[0]?.cnt || 0
    console.log(`📊 daily_stats 数据:`)
    console.log(`   - 记录数: ${statsCount}`)
    if (statsCount > 0) {
      console.log(`   - 最早日期: ${statsRows[0].min_date}`)
      console.log(`   - 最新日期: ${statsRows[0].max_date}`)
    }
    console.log('')
    
    // 4. 检查广告数量
    const [adRows] = await pool.execute(
      `SELECT COUNT(DISTINCT ad_id) as ad_count
       FROM ad_snapshots
       WHERE account_id = ?`,
      [accountId]
    )
    
    const adCount = adRows[0]?.ad_count || 0
    console.log(`📊 广告数量:`)
    console.log(`   - 唯一广告数: ${adCount}`)
    console.log('')
    
    // 5. 检查规则数量（关联到这个账户的规则）
    const [ruleRows] = await pool.execute(
      `SELECT COUNT(*) as cnt
       FROM rules r
       INNER JOIN users u ON r.user_id = u.id
       INNER JOIN account_mappings am ON u.owner_id = am.owner_id
       WHERE am.fb_account_id = ? AND r.enabled = 1`,
      [accountId]
    )
    
    const ruleCount = ruleRows[0]?.cnt || 0
    console.log(`📊 关联规则数量:`)
    console.log(`   - 启用规则数: ${ruleCount}`)
    console.log('')
    
    // 总结
    console.log('='.repeat(50))
    console.log('📋 总结:')
    console.log(`   - 账户配置: ${account.is_active ? '✅ 活跃' : '❌ 未激活'}`)
    console.log(`   - 今天数据: ${snapshotCount > 0 ? `✅ ${snapshotCount} 条` : '❌ 无数据'}`)
    console.log(`   - 历史数据: ${statsCount > 0 ? `✅ ${statsCount} 条` : '❌ 无数据'}`)
    console.log(`   - 广告数量: ${adCount > 0 ? `✅ ${adCount} 个` : '❌ 无广告'}`)
    console.log(`   - 关联规则: ${ruleCount > 0 ? `✅ ${ruleCount} 条` : '❌ 无规则'}`)
    console.log('='.repeat(50))
    console.log('')
    
    if (snapshotCount === 0 && statsCount === 0) {
      console.log('⚠️  账户没有数据，需要先同步数据')
      console.log('💡 提示：运行数据同步任务，或等待定时任务同步数据')
    }
    
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error('   错误堆栈:', error.stack)
  } finally {
    await pool.end()
  }
}

// 执行检查
checkAccountData()

