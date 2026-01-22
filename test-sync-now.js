// 测试脚本：执行一次数据同步，验证新字段是否正确提取和写入
// 注意：这会实际调用 Facebook API，需要有效的 Token

import { syncAccountTodayStats } from './server/services/ingestorService.js'
import pool from './server/db/connection.js'

async function testSync() {
  try {
    console.log('🔄 开始测试数据同步...')
    
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
    const ownerId = account.owner_id
    const timezoneName = account.timezone_name || 'UTC'
    
    console.log(`📋 找到账户: ${accountId}, owner_id: ${ownerId}, 时区: ${timezoneName}`)
    
    // 2. 执行同步
    console.log('🔄 开始同步数据...')
    const result = await syncAccountTodayStats(accountId, ownerId, timezoneName)
    
    console.log('\n✅ 同步完成！')
    console.log('结果:', JSON.stringify(result, null, 2))
    
    // 3. 检查新字段是否有数据
    console.log('\n📊 检查新字段数据...')
    const [rows] = await pool.query(`
      SELECT 
        ad_id,
        link_clicks,
        unique_link_clicks,
        purchase_value,
        add_to_cart_count,
        initiate_checkout_count,
        add_payment_info_count,
        ad_set_id
      FROM ad_snapshots
      WHERE account_id = ?
        AND sync_session_id = ?
      LIMIT 5
    `, [accountId, result.sessionId])
    
    if (rows.length === 0) {
      console.log('⚠️  没有找到数据，可能是账户下没有广告')
    } else {
      console.log(`✅ 找到 ${rows.length} 条记录，新字段数据：`)
      rows.forEach((row, index) => {
        console.log(`\n记录 ${index + 1}:`)
        console.log(`  ad_id: ${row.ad_id}`)
        console.log(`  link_clicks: ${row.link_clicks}`)
        console.log(`  unique_link_clicks: ${row.unique_link_clicks}`)
        console.log(`  purchase_value: ${row.purchase_value}`)
        console.log(`  add_to_cart_count: ${row.add_to_cart_count}`)
        console.log(`  initiate_checkout_count: ${row.initiate_checkout_count}`)
        console.log(`  add_payment_info_count: ${row.add_payment_info_count}`)
        console.log(`  ad_set_id: ${row.ad_set_id || '(null)'}`)
      })
    }
    
    // 4. 关闭数据库连接
    await pool.end()
    console.log('\n✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testSync()

