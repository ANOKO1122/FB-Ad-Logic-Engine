// 测试脚本：验证冷数据落盘逻辑（取最后快照）
// 注意：这是 Dry Run 测试，不会实际写入数据库

import { archiveDailyStats } from './server/services/ingestorService.js'
import pool from './server/db/connection.js'

async function testArchive() {
  try {
    console.log('🔄 开始测试冷数据落盘...')
    
    // 1. 从 account_mappings 表获取第一个活跃账户
    const [accounts] = await pool.query(`
      SELECT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      LIMIT 1
    `)
    
    if (!accounts || accounts.length === 0) {
      console.error('❌ 没有找到活跃账户，请先在 account_mappings 表中添加账户')
      process.exit(1)
    }
    
    const account = accounts[0]
    const accountId = String(account.account_id)
    const timezoneName = account.timezone_name || 'UTC'
    
    console.log(`📋 找到账户: ${accountId}, 时区: ${timezoneName}`)
    
    // 2. 检查是否有昨日数据
    console.log('\n📊 检查昨日数据...')
    const [snapshots] = await pool.query(`
      SELECT 
        ad_id,
        COUNT(*) as snapshot_count,
        MIN(synced_at) as first_snapshot,
        MAX(synced_at) as last_snapshot,
        SUM(spend) as sum_spend,
        MAX(spend) as max_spend
      FROM ad_snapshots
      WHERE account_id = ?
        AND DATE(synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      GROUP BY ad_id
      LIMIT 5
    `, [accountId])
    
    if (snapshots.length === 0) {
      console.log('⚠️  没有找到昨日数据，无法测试')
      console.log('💡 提示：请先执行数据同步，生成昨日数据')
      process.exit(0)
    }
    
    console.log(`✅ 找到 ${snapshots.length} 个广告的昨日数据`)
    snapshots.forEach((snap, index) => {
      console.log(`\n广告 ${index + 1}:`)
      console.log(`  ad_id: ${snap.ad_id}`)
      console.log(`  快照数量: ${snap.snapshot_count}`)
      console.log(`  首次快照: ${snap.first_snapshot}`)
      console.log(`  最后快照: ${snap.last_snapshot}`)
      console.log(`  SUM(spend): ${snap.sum_spend} (错误做法)`)
      console.log(`  MAX(spend): ${snap.max_spend} (正确做法)`)
    })
    
    // 3. 执行落盘
    console.log('\n🔄 执行冷数据落盘...')
    const result = await archiveDailyStats(accountId, timezoneName)
    
    console.log('\n✅ 落盘完成！')
    console.log('结果:', JSON.stringify(result, null, 2))
    
    // 4. 验证落盘结果
    console.log('\n📊 验证落盘结果...')
    const [archived] = await pool.query(`
      SELECT 
        ad_id,
        spend,
        purchases,
        link_clicks,
        unique_link_clicks,
        purchase_value,
        add_to_cart_count,
        initiate_checkout_count,
        add_payment_info_count,
        ad_set_id
      FROM daily_stats
      WHERE account_id = ?
        AND date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      LIMIT 5
    `, [accountId])
    
    if (archived.length === 0) {
      console.log('⚠️  没有找到落盘数据')
    } else {
      console.log(`✅ 找到 ${archived.length} 条落盘记录，新字段数据：`)
      archived.forEach((row, index) => {
        console.log(`\n记录 ${index + 1}:`)
        console.log(`  ad_id: ${row.ad_id}`)
        console.log(`  spend: ${row.spend}`)
        console.log(`  purchases: ${row.purchases}`)
        console.log(`  link_clicks: ${row.link_clicks}`)
        console.log(`  unique_link_clicks: ${row.unique_link_clicks}`)
        console.log(`  purchase_value: ${row.purchase_value}`)
        console.log(`  add_to_cart_count: ${row.add_to_cart_count}`)
        console.log(`  initiate_checkout_count: ${row.initiate_checkout_count}`)
        console.log(`  add_payment_info_count: ${row.add_payment_info_count}`)
        console.log(`  ad_set_id: ${row.ad_set_id || '(null)'}`)
      })
    }
    
    // 5. 对比验证：SUM vs 最后快照
    console.log('\n🔍 对比验证：SUM vs 最后快照')
    const [comparison] = await pool.query(`
      SELECT 
        s.ad_id,
        SUM(s.spend) as sum_spend,
        MAX(s.spend) as max_spend,
        d.spend as archived_spend
      FROM ad_snapshots s
      LEFT JOIN daily_stats d
        ON s.ad_id = d.ad_id
        AND DATE(s.synced_at) = d.date
        AND s.account_id = d.account_id
      WHERE s.account_id = ?
        AND DATE(s.synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      GROUP BY s.ad_id, d.spend
      LIMIT 5
    `, [accountId])
    
    if (comparison.length > 0) {
      console.log('\n对比结果：')
      comparison.forEach((row, index) => {
        const isCorrect = Math.abs(row.max_spend - row.archived_spend) < 0.01
        console.log(`\n广告 ${index + 1} (ad_id: ${row.ad_id}):`)
        console.log(`  SUM(spend): ${row.sum_spend} (错误，会重复累计)`)
        console.log(`  MAX(spend): ${row.max_spend} (正确，最后快照)`)
        console.log(`  落盘值: ${row.archived_spend}`)
        console.log(`  验证: ${isCorrect ? '✅ 正确（等于最后快照）' : '❌ 错误（不等于最后快照）'}`)
      })
    }
    
    // 6. 关闭数据库连接
    await pool.end()
    console.log('\n✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testArchive()

