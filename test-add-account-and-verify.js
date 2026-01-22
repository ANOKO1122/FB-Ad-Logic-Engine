// 测试脚本：添加测试账户并验证冷数据落盘
// 注意：需要有效的 Facebook Token 和账户ID

import pool from './server/db/connection.js'
import { syncAccountTodayStats } from './server/services/ingestorService.js'
import { archiveDailyStats } from './server/services/ingestorService.js'

async function testAddAccountAndVerify() {
  try {
    console.log('🔄 开始测试：添加账户并验证落盘...')
    
    // 1. 检查 users 表，获取 admin 用户ID
    const [users] = await pool.query(`
      SELECT id, username, role
      FROM users
      WHERE role = 'admin'
      LIMIT 1
    `)
    
    if (!users || users.length === 0) {
      console.error('❌ 没有找到 admin 用户，请先创建用户')
      process.exit(1)
    }
    
    const adminUser = users[0]
    console.log(`✅ 找到 admin 用户: ${adminUser.username} (id: ${adminUser.id})`)
    
    // 2. 检查是否已有账户
    const [existingAccounts] = await pool.query(`
      SELECT fb_account_id, owner_id, is_active, timezone_name
      FROM account_mappings
      WHERE owner_id = ?
      LIMIT 5
    `, [adminUser.id])
    
    if (existingAccounts.length > 0) {
      console.log(`\n📋 找到 ${existingAccounts.length} 个已有账户：`)
      existingAccounts.forEach((acc, index) => {
        console.log(`  ${index + 1}. ${acc.fb_account_id} (活跃: ${acc.is_active}, 时区: ${acc.timezone_name || 'UTC'})`)
      })
      
      // 询问是否使用已有账户
      console.log('\n💡 提示：可以使用已有账户进行测试')
      console.log('   如果要添加新账户，请提供 Facebook 账户ID')
    }
    
    // 3. 添加测试账户（需要你提供 Facebook 账户ID）
    const testAccountId = process.env.TEST_FB_ACCOUNT_ID || null
    
    if (!testAccountId) {
      console.log('\n⚠️  未设置 TEST_FB_ACCOUNT_ID 环境变量')
      console.log('💡 提示：')
      console.log('   1. 如果你有 Facebook 账户ID，可以在 .env 文件中设置：')
      console.log('      TEST_FB_ACCOUNT_ID=act_xxxxx')
      console.log('   2. 或者直接修改此脚本，在 testAccountId 变量中填入账户ID')
      console.log('   3. 如果已有账户，可以直接使用上面的账户进行测试')
      
      if (existingAccounts.length > 0) {
        const useExisting = existingAccounts[0]
        console.log(`\n✅ 使用已有账户进行测试: ${useExisting.fb_account_id}`)
        await runTest(useExisting.fb_account_id, adminUser.id, useExisting.timezone_name || 'UTC')
      } else {
        console.log('\n❌ 没有可用账户，无法继续测试')
        process.exit(1)
      }
    } else {
      console.log(`\n📋 使用环境变量中的账户ID: ${testAccountId}`)
      
      // 检查账户是否已存在
      const [checkAccount] = await pool.query(`
        SELECT fb_account_id, owner_id, is_active, timezone_name
        FROM account_mappings
        WHERE fb_account_id = ?
      `, [testAccountId])
      
      if (checkAccount.length > 0) {
        console.log('✅ 账户已存在，使用现有配置')
        const account = checkAccount[0]
        await runTest(account.fb_account_id, account.owner_id, account.timezone_name || 'UTC')
      } else {
        // 添加新账户
        console.log('📝 添加新账户到 account_mappings 表...')
        await pool.query(`
          INSERT INTO account_mappings (
            fb_account_id, owner_id, is_active, timezone_name
          ) VALUES (?, ?, 1, 'Asia/Shanghai')
        `, [testAccountId, adminUser.id])
        
        console.log('✅ 账户添加成功')
        await runTest(testAccountId, adminUser.id, 'Asia/Shanghai')
      }
    }
    
    await pool.end()
    console.log('\n✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

async function runTest(accountId, ownerId, timezoneName) {
  console.log(`\n🔄 开始测试账户: ${accountId}`)
  console.log(`📋 使用 owner_id: ${ownerId} (测试用，不影响原负责人)`)
  
  // 步骤1：执行数据同步（生成 ad_snapshots 数据）
  // 注意：这里使用传入的 ownerId，但实际数据同步时，ad_snapshots 会记录这个 ownerId
  // 如果担心数据混淆，可以在测试后清理测试数据
  console.log('\n📊 步骤1：执行数据同步...')
  try {
    // 注意：syncAccountTodayStats 会使用传入的 ownerId 写入 ad_snapshots
    // 但原负责人的数据不会受影响（因为 ad_snapshots 有 owner_id 字段隔离）
    const syncResult = await syncAccountTodayStats(accountId, ownerId, timezoneName)
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
  
  // 步骤2：检查 ad_snapshots 数据
  console.log('\n📊 步骤2：检查 ad_snapshots 数据...')
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
    console.log('⚠️  没有找到昨日数据')
    console.log('💡 提示：')
    console.log('   1. 数据同步生成的是"今日"数据，不是"昨日"数据')
    console.log('   2. 如果要测试落盘，需要等待到明天，或者手动修改日期')
    console.log('   3. 或者可以手动执行落盘，指定昨天的日期')
    
    // 检查今日数据
    const [todaySnapshots] = await pool.query(`
      SELECT COUNT(*) as count
      FROM ad_snapshots
      WHERE account_id = ?
        AND DATE(synced_at) = CURDATE()
    `, [accountId])
    
    console.log(`\n📊 今日数据: ${todaySnapshots[0].count} 条快照`)
    return
  }
  
  console.log(`✅ 找到 ${snapshots.length} 个广告的昨日数据`)
  snapshots.forEach((snap, index) => {
    console.log(`\n广告 ${index + 1}:`)
    console.log(`  ad_id: ${snap.ad_id}`)
    console.log(`  快照数量: ${snap.snapshot_count}`)
    console.log(`  SUM(spend): ${snap.sum_spend} (错误做法)`)
    console.log(`  MAX(spend): ${snap.max_spend} (正确做法)`)
  })
  
  // 步骤3：执行落盘
  console.log('\n📊 步骤3：执行冷数据落盘...')
  try {
    const archiveResult = await archiveDailyStats(accountId, timezoneName)
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
    LIMIT 5
  `, [accountId])
  
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
    
    // 步骤5：对比验证
    console.log('\n📊 步骤5：对比验证（SUM vs 最后快照）...')
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
        AND DATE(s.synced_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      GROUP BY s.ad_id, d.spend
      HAVING snapshot_count > 1
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
    } else {
      console.log('⚠️  没有找到同日多快照的广告，无法进行对比验证')
    }
  }
}

testAddAccountAndVerify()

