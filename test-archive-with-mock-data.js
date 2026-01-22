// 测试脚本：使用模拟数据验证冷数据落盘逻辑
// 注意：这个脚本会手动插入测试数据，然后验证落盘逻辑

import pool from './server/db/connection.js'
import { archiveDailyStats } from './server/services/ingestorService.js'

const TEST_ACCOUNT_ID = 'act_927139705822379'
const TEST_OWNER_ID = 1  // admin
const TEST_TIMEZONE = 'Asia/Shanghai'

async function testArchiveWithMockData() {
  try {
    console.log('🔄 开始测试：使用模拟数据验证冷数据落盘逻辑...')
    
    // 步骤1：清理之前的测试数据（如果有）
    console.log('\n📊 步骤1：清理之前的测试数据...')
    await pool.query(`
      DELETE FROM ad_snapshots 
      WHERE account_id = ? AND owner_id = ? AND DATE(synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    `, [TEST_ACCOUNT_ID, TEST_OWNER_ID])
    
    await pool.query(`
      DELETE FROM daily_stats 
      WHERE account_id = ? AND date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    `, [TEST_ACCOUNT_ID])
    
    console.log('✅ 清理完成')
    
    // 步骤2：插入模拟数据（同一广告同日多次快照）
    console.log('\n📊 步骤2：插入模拟数据（同一广告同日多次快照）...')
    
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(10, 0, 0, 0)  // 10:00
    
    const testAdId = 'test_ad_123456'
    const baseTimestamp = Date.now()
    
    // 插入3个快照（模拟同一广告在同一天的不同时间点）
    // 注意：每个快照使用不同的 sync_session_id，避免唯一索引冲突
    const snapshots = [
      {
        sessionId: `test_session_${baseTimestamp}_1`,
        time: new Date(yesterday.getTime() + 2 * 60 * 60 * 1000),  // 12:00
        spend: 10.50,
        purchases: 2,
        link_clicks: 20,
        unique_link_clicks: 18,
        purchase_value: 50.00,
        add_to_cart_count: 5,
        initiate_checkout_count: 3,
        add_payment_info_count: 2
      },
      {
        sessionId: `test_session_${baseTimestamp}_2`,
        time: new Date(yesterday.getTime() + 6 * 60 * 60 * 1000),  // 16:00
        spend: 25.30,  // 累计值（不是增量）
        purchases: 5,
        link_clicks: 45,
        unique_link_clicks: 40,
        purchase_value: 120.00,
        add_to_cart_count: 12,
        initiate_checkout_count: 8,
        add_payment_info_count: 5
      },
      {
        sessionId: `test_session_${baseTimestamp}_3`,
        time: new Date(yesterday.getTime() + 10 * 60 * 60 * 1000),  // 20:00（最后快照）
        spend: 35.80,  // 累计值（最后快照）
        purchases: 8,
        link_clicks: 65,
        unique_link_clicks: 58,
        purchase_value: 180.00,
        add_to_cart_count: 18,
        initiate_checkout_count: 12,
        add_payment_info_count: 8
      }
    ]
    
    for (const snap of snapshots) {
      await pool.query(`
        INSERT INTO ad_snapshots (
          account_id, ad_id, ad_name, status, owner_id,
          spend, purchases, link_clicks, unique_link_clicks,
          purchase_value, add_to_cart_count, initiate_checkout_count,
          add_payment_info_count, ad_set_id,
          sync_session_id, synced_at, timezone_name,
          ucpc, cpa, actions, add_to_cart_cost, checkout_cost, payment_cost,
          mute_until, mute_reason, is_simulation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        TEST_ACCOUNT_ID,
        testAdId,
        '测试广告',
        'ACTIVE',
        TEST_OWNER_ID,
        snap.spend,
        snap.purchases,
        snap.link_clicks,
        snap.unique_link_clicks,
        snap.purchase_value,
        snap.add_to_cart_count,
        snap.initiate_checkout_count,
        snap.add_payment_info_count,
        'test_adset_123',
        snap.sessionId,  // 使用不同的 sessionId
        snap.time,
        TEST_TIMEZONE,
        null,  // ucpc
        null,  // cpa
        JSON.stringify([]),  // actions
        null,  // add_to_cart_cost
        null,  // checkout_cost
        null,  // payment_cost
        null,  // mute_until
        null,  // mute_reason
        0      // is_simulation
      ])
    }
    
    console.log(`✅ 插入 ${snapshots.length} 个快照完成`)
    console.log(`\n📊 快照数据：`)
    console.log(`  12:00: spend=${snapshots[0].spend}, purchases=${snapshots[0].purchases}`)
    console.log(`  16:00: spend=${snapshots[1].spend}, purchases=${snapshots[1].purchases}`)
    console.log(`  20:00: spend=${snapshots[2].spend}, purchases=${snapshots[2].purchases} (最后快照)`)
    console.log(`\n💡 关键验证点：`)
    console.log(`  - SUM(spend) = ${snapshots[0].spend + snapshots[1].spend + snapshots[2].spend} (错误，会重复累计)`)
    console.log(`  - MAX(spend) = ${snapshots[2].spend} (正确，最后快照)`)
    console.log(`  - 落盘值应该等于 ${snapshots[2].spend} (最后快照)`)
    
    // 步骤3：执行落盘
    console.log('\n📊 步骤3：执行冷数据落盘...')
    try {
      // 手动指定昨天的日期
      const targetDate = new Date(yesterday)
      const archiveResult = await archiveDailyStats(TEST_ACCOUNT_ID, TEST_TIMEZONE, targetDate)
      console.log('✅ 落盘完成:', JSON.stringify(archiveResult, null, 2))
    } catch (error) {
      console.error('❌ 落盘失败:', error.message)
      throw error
    }
    
    // 步骤4：验证落盘结果
    console.log('\n📊 步骤4：验证落盘结果...')
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
    `, [TEST_ACCOUNT_ID])
    
    if (archived.length === 0) {
      console.log('❌ 没有找到落盘数据，落盘可能失败')
      return
    }
    
    console.log(`✅ 找到 ${archived.length} 条落盘记录：`)
    const row = archived[0]
    console.log(`\n落盘数据：`)
    console.log(`  ad_id: ${row.ad_id}`)
    console.log(`  spend: ${row.spend}`)
    console.log(`  purchases: ${row.purchases}`)
    console.log(`  link_clicks: ${row.link_clicks}`)
    console.log(`  unique_link_clicks: ${row.unique_link_clicks}`)
    console.log(`  purchase_value: ${row.purchase_value}`)
    console.log(`  add_to_cart_count: ${row.add_to_cart_count}`)
    console.log(`  initiate_checkout_count: ${row.initiate_checkout_count}`)
    console.log(`  add_payment_info_count: ${row.add_payment_info_count}`)
    console.log(`  ad_set_id: ${row.ad_set_id}`)
    console.log(`  cpc: ${row.cpc}`)
    console.log(`  roas: ${row.roas}`)
    
    // 步骤5：对比验证
    console.log('\n📊 步骤5：对比验证（SUM vs 最后快照）...')
    const expectedSpend = snapshots[2].spend  // 最后快照
    const actualSpend = parseFloat(row.spend)
    const isCorrect = Math.abs(expectedSpend - actualSpend) < 0.01
    
    console.log(`\n验证结果：`)
    console.log(`  期望值（最后快照）: ${expectedSpend}`)
    console.log(`  实际值（落盘值）: ${actualSpend}`)
    console.log(`  验证: ${isCorrect ? '✅ 正确（等于最后快照）' : '❌ 错误（不等于最后快照）'}`)
    
    if (!isCorrect) {
      console.log(`\n❌ 落盘逻辑有误！`)
      console.log(`  错误做法（SUM）: ${snapshots[0].spend + snapshots[1].spend + snapshots[2].spend}`)
      console.log(`  正确做法（最后快照）: ${expectedSpend}`)
      console.log(`  实际落盘值: ${actualSpend}`)
    } else {
      console.log(`\n✅ 落盘逻辑正确！使用了最后快照，而不是 SUM`)
    }
    
    // 步骤6：清理测试数据（可选）
    console.log('\n📊 步骤6：清理测试数据...')
    console.log('💡 提示：如果要保留测试数据，可以跳过清理')
    
    await pool.end()
    console.log('\n✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testArchiveWithMockData()

