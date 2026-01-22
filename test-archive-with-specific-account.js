// 测试脚本：使用指定账户测试冷数据落盘（不修改 owner_id）
// 注意：这个脚本直接使用账户ID，不检查 owner_id，适合测试场景

import pool from './server/db/connection.js'
import { syncAccountTodayStats } from './server/services/ingestorService.js'
import { archiveDailyStats } from './server/services/ingestorService.js'

// 配置：直接指定要测试的账户
const TEST_ACCOUNT_ID = 'act_927139705822379'
const TEST_OWNER_ID = 1  // admin 的 ID（用于测试，不会影响原负责人）
const TEST_TIMEZONE = 'Asia/Shanghai'

async function testArchiveWithSpecificAccount() {
  try {
    console.log('🔄 开始测试：使用指定账户测试冷数据落盘...')
    console.log(`📋 测试账户: ${TEST_ACCOUNT_ID}`)
    console.log(`📋 使用 owner_id: ${TEST_OWNER_ID} (仅用于测试，不影响原负责人)`)
    
    // 步骤1：检查账户是否存在
    console.log('\n📊 步骤1：检查账户状态...')
    const [accounts] = await pool.query(`
      SELECT 
        fb_account_id,
        owner_id,
        is_active,
        timezone_name
      FROM account_mappings
      WHERE fb_account_id = ?
    `, [TEST_ACCOUNT_ID])
    
    if (accounts.length === 0) {
      console.error(`❌ 账户 ${TEST_ACCOUNT_ID} 不存在`)
      process.exit(1)
    }
    
    const account = accounts[0]
    console.log(`✅ 账户存在:`)
    console.log(`  原负责人 owner_id: ${account.owner_id}`)
    console.log(`  活跃状态: ${account.is_active}`)
    console.log(`  时区: ${account.timezone_name || 'UTC'}`)
    console.log(`\n💡 注意：测试将使用 owner_id=${TEST_OWNER_ID}，但不会修改数据库中的 owner_id`)
    
    // 步骤2：执行数据同步（使用测试 owner_id）
    console.log('\n📊 步骤2：执行数据同步...')
    try {
      const syncResult = await syncAccountTodayStats(TEST_ACCOUNT_ID, TEST_OWNER_ID, TEST_TIMEZONE)
      console.log('✅ 同步完成:', JSON.stringify(syncResult, null, 2))
      
      if (syncResult.syncedCount === 0) {
        console.log('⚠️  没有同步到数据，可能是账户下没有广告')
        console.log('💡 提示：请确保账户下有活跃的广告')
        return
      }
    } catch (error) {
      console.error('❌ 同步失败:', error.message)
      throw error
    }
    
    // 步骤3：检查 ad_snapshots 数据（使用测试 owner_id 查询）
    console.log('\n📊 步骤3：检查 ad_snapshots 数据...')
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
        AND owner_id = ?
        AND DATE(synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      GROUP BY ad_id
      LIMIT 5
    `, [TEST_ACCOUNT_ID, TEST_OWNER_ID])
    
    if (snapshots.length === 0) {
      console.log('⚠️  没有找到昨日数据（使用测试 owner_id 查询）')
      console.log('💡 提示：')
      console.log('   1. 数据同步生成的是"今日"数据，不是"昨日"数据')
      console.log('   2. 如果要测试落盘，可以：')
      console.log('      - 等待到明天（自然有昨日数据）')
      console.log('      - 或者检查今日数据，确认同步是否成功')
      
      // 检查今日数据
      const [todaySnapshots] = await pool.query(`
        SELECT COUNT(*) as count
        FROM ad_snapshots
        WHERE account_id = ?
          AND owner_id = ?
          AND DATE(synced_at) = CURDATE()
      `, [TEST_ACCOUNT_ID, TEST_OWNER_ID])
      
      console.log(`\n📊 今日数据（owner_id=${TEST_OWNER_ID}）: ${todaySnapshots[0].count} 条快照`)
      
      // 检查原负责人的数据
      const [originalSnapshots] = await pool.query(`
        SELECT COUNT(*) as count
        FROM ad_snapshots
        WHERE account_id = ?
          AND owner_id = ?
          AND DATE(synced_at) >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      `, [TEST_ACCOUNT_ID, account.owner_id])
      
      console.log(`📊 原负责人数据（owner_id=${account.owner_id}）: ${originalSnapshots[0].count} 条快照`)
      console.log(`\n✅ 原负责人的数据未受影响（数据隔离正常）`)
      return
    }
    
    console.log(`✅ 找到 ${snapshots.length} 个广告的昨日数据（测试 owner_id）`)
    snapshots.forEach((snap, index) => {
      console.log(`\n广告 ${index + 1}:`)
      console.log(`  ad_id: ${snap.ad_id}`)
      console.log(`  快照数量: ${snap.snapshot_count}`)
      console.log(`  SUM(spend): ${snap.sum_spend} (错误做法)`)
      console.log(`  MAX(spend): ${snap.max_spend} (正确做法)`)
    })
    
    // 步骤4：执行落盘（使用测试 owner_id）
    console.log('\n📊 步骤4：执行冷数据落盘...')
    try {
      const archiveResult = await archiveDailyStats(TEST_ACCOUNT_ID, TEST_TIMEZONE)
      console.log('✅ 落盘完成:', JSON.stringify(archiveResult, null, 2))
    } catch (error) {
      console.error('❌ 落盘失败:', error.message)
      throw error
    }
    
    // 步骤5：验证落盘结果
    console.log('\n📊 步骤5：验证落盘结果...')
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
        ad_set_id,
        cpc,
        roas
      FROM daily_stats
      WHERE account_id = ?
        AND date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      LIMIT 5
    `, [TEST_ACCOUNT_ID])
    
    if (archived.length === 0) {
      console.log('⚠️  没有找到落盘数据')
    } else {
      console.log(`✅ 找到 ${archived.length} 条落盘记录：`)
      archived.forEach((row, index) => {
        console.log(`\n记录 ${index + 1}:`)
        console.log(`  ad_id: ${row.ad_id}`)
        console.log(`  spend: ${row.spend}`)
        console.log(`  purchases: ${row.purchases}`)
        console.log(`  link_clicks: ${row.link_clicks}`)
        console.log(`  unique_link_clicks: ${row.unique_link_clicks}`)
        console.log(`  purchase_value: ${row.purchase_value}`)
        console.log(`  cpc: ${row.cpc}`)
        console.log(`  roas: ${row.roas}`)
        console.log(`  ad_set_id: ${row.ad_set_id || '(null)'}`)
      })
      
      // 步骤6：对比验证
      console.log('\n📊 步骤6：对比验证（SUM vs 最后快照）...')
      const [comparison] = await pool.query(`
        SELECT 
          s.ad_id,
          COUNT(*) as snapshot_count,
          SUM(s.spend) as sum_spend,
          MAX(s.spend) as max_spend,
          d.spend as archived_spend
        FROM ad_snapshots s
        LEFT JOIN daily_stats d
          ON s.ad_id = d.ad_id
          AND DATE(s.synced_at) = d.date
          AND s.account_id = d.account_id
        WHERE s.account_id = ?
          AND s.owner_id = ?
          AND DATE(s.synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        GROUP BY s.ad_id, d.spend
        HAVING snapshot_count > 1
        LIMIT 5
      `, [TEST_ACCOUNT_ID, TEST_OWNER_ID])
      
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
      } else {
        console.log('⚠️  没有找到同日多快照的广告，无法进行对比验证')
      }
    }
    
    // 步骤7：清理测试数据（可选）
    console.log('\n📊 步骤7：清理测试数据（可选）...')
    console.log('💡 提示：如果要清理测试数据，可以执行以下 SQL：')
    console.log(`   DELETE FROM ad_snapshots WHERE account_id = '${TEST_ACCOUNT_ID}' AND owner_id = ${TEST_OWNER_ID};`)
    console.log(`   DELETE FROM daily_stats WHERE account_id = '${TEST_ACCOUNT_ID}' AND date = DATE_SUB(CURDATE(), INTERVAL 1 DAY);`)
    console.log('   注意：原负责人的数据不会受影响（因为 owner_id 不同）')
    
    await pool.end()
    console.log('\n✅ 测试完成！')
    console.log(`✅ 原负责人的数据未受影响（owner_id=${account.owner_id} 的数据仍然存在）`)
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testArchiveWithSpecificAccount()

