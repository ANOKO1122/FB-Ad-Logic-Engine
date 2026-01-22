/**
 * 测试脚本：验证时区修复效果
 * 
 * 功能：
 * 1. 显示同步前的时区状态（account_mappings 和 ad_snapshots）
 * 2. 手动触发一次数据同步
 * 3. 显示同步后的时区状态
 * 4. 验证时区是否已从 Facebook API 正确获取并更新
 * 
 * 使用方法：
 * node test-timezone-fix-verification.js
 */

import pool from './server/db/connection.js'
import { syncAccountTodayStats } from './server/services/ingestorService.js'

// 测试账户ID（根据你的实际情况修改）
const TEST_ACCOUNT_ID = 'act_927139705822379'

/**
 * 查询账户的 owner_id 和时区配置
 */
async function getAccountInfo(accountId) {
  const [rows] = await pool.query(`
    SELECT 
      fb_account_id,
      owner_id,
      timezone_name,
      is_active
    FROM account_mappings
    WHERE fb_account_id = ?
  `, [accountId])
  
  return rows[0] || null
}

/**
 * 查询 ad_snapshots 表中的时区分布
 */
async function getSnapshotTimezoneDistribution(accountId) {
  const [rows] = await pool.query(`
    SELECT 
      timezone_name,
      COUNT(*) as count,
      MAX(synced_at) as latest_sync,
      MIN(synced_at) as earliest_sync
    FROM ad_snapshots
    WHERE account_id = ?
    GROUP BY timezone_name
    ORDER BY latest_sync DESC
  `, [accountId])
  
  return rows
}

/**
 * 显示时区状态（同步前）
 */
async function showTimezoneStatusBefore(accountId) {
  console.log('\n' + '='.repeat(60))
  console.log('📊 同步前时区状态')
  console.log('='.repeat(60))
  
  // 1. 查询 account_mappings 表的时区配置
  const accountInfo = await getAccountInfo(accountId)
  if (!accountInfo) {
    console.error(`❌ 账户 ${accountId} 不存在于 account_mappings 表中`)
    return null
  }
  
  console.log(`\n📋 account_mappings 表:`)
  console.log(`   账户ID: ${accountInfo.fb_account_id}`)
  console.log(`   负责人ID: ${accountInfo.owner_id}`)
  console.log(`   时区配置: ${accountInfo.timezone_name || '(NULL)'}`)
  console.log(`   是否活跃: ${accountInfo.is_active ? '是' : '否'}`)
  
  // 2. 查询 ad_snapshots 表的时区分布
  const snapshotTz = await getSnapshotTimezoneDistribution(accountId)
  console.log(`\n📋 ad_snapshots 表时区分布:`)
  if (snapshotTz.length === 0) {
    console.log(`   ⚠️  没有数据`)
  } else {
    snapshotTz.forEach(row => {
      console.log(`   - ${row.timezone_name || '(NULL)'}: ${row.count} 条记录`)
      console.log(`     最新同步: ${row.latest_sync}`)
      console.log(`     最早同步: ${row.earliest_sync}`)
    })
  }
  
  return accountInfo
}

/**
 * 显示时区状态（同步后）
 */
async function showTimezoneStatusAfter(accountId) {
  console.log('\n' + '='.repeat(60))
  console.log('📊 同步后时区状态')
  console.log('='.repeat(60))
  
  // 1. 查询 account_mappings 表的时区配置
  const accountInfo = await getAccountInfo(accountId)
  if (!accountInfo) {
    console.error(`❌ 账户 ${accountId} 不存在于 account_mappings 表中`)
    return
  }
  
  console.log(`\n📋 account_mappings 表:`)
  console.log(`   账户ID: ${accountInfo.fb_account_id}`)
  console.log(`   时区配置: ${accountInfo.timezone_name || '(NULL)'}`)
  
  // 2. 查询 ad_snapshots 表的时区分布（只显示最新的）
  const [latestSnapshot] = await pool.query(`
    SELECT 
      timezone_name,
      synced_at,
      COUNT(*) as count
    FROM ad_snapshots
    WHERE account_id = ?
    GROUP BY timezone_name, DATE(synced_at)
    ORDER BY synced_at DESC
    LIMIT 5
  `, [accountId])
  
  console.log(`\n📋 ad_snapshots 表最新时区:`)
  if (latestSnapshot.length === 0) {
    console.log(`   ⚠️  没有数据`)
  } else {
    latestSnapshot.forEach(row => {
      console.log(`   - ${row.timezone_name || '(NULL)'}: ${row.count} 条记录 (${row.synced_at})`)
    })
  }
}

/**
 * 验证时区修复效果
 */
async function verifyTimezoneFix(accountId, beforeAccountInfo) {
  console.log('\n' + '='.repeat(60))
  console.log('✅ 验证时区修复效果')
  console.log('='.repeat(60))
  
  const afterAccountInfo = await getAccountInfo(accountId)
  
  // 1. 检查 account_mappings 是否已更新
  const tzBefore = beforeAccountInfo.timezone_name || 'NULL'
  const tzAfter = afterAccountInfo.timezone_name || 'NULL'
  
  console.log(`\n📋 account_mappings.timezone_name:`)
  console.log(`   同步前: ${tzBefore}`)
  console.log(`   同步后: ${tzAfter}`)
  
  if (tzBefore !== tzAfter) {
    console.log(`   ✅ 时区已更新: ${tzBefore} → ${tzAfter}`)
  } else if (tzAfter !== 'NULL' && tzAfter !== 'UTC') {
    console.log(`   ✅ 时区已正确配置: ${tzAfter}`)
  } else {
    console.log(`   ⚠️  时区未更新或仍为默认值`)
  }
  
  // 2. 检查 ad_snapshots 最新数据的时区
  const [latestSnapshots] = await pool.query(`
    SELECT 
      timezone_name,
      COUNT(*) as count,
      MAX(synced_at) as latest_sync
    FROM ad_snapshots
    WHERE account_id = ?
      AND synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    GROUP BY timezone_name
    ORDER BY latest_sync DESC
    LIMIT 1
  `, [accountId])
  
  if (latestSnapshots.length > 0) {
    const latestTz = latestSnapshots[0].timezone_name
    console.log(`\n📋 ad_snapshots 最新数据时区:`)
    console.log(`   ${latestTz || '(NULL)'} (${latestSnapshots[0].count} 条记录)`)
    
    if (latestTz === tzAfter && tzAfter !== 'UTC' && tzAfter !== 'NULL') {
      console.log(`   ✅ 时区一致，修复成功！`)
    } else {
      console.log(`   ⚠️  时区不一致或仍为默认值`)
    }
  } else {
    console.log(`\n⚠️  最近1小时内没有同步数据`)
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('🚀 开始验证时区修复效果')
  console.log(`📋 测试账户: ${TEST_ACCOUNT_ID}`)
  
  try {
    // 步骤1：显示同步前的时区状态
    const beforeAccountInfo = await showTimezoneStatusBefore(TEST_ACCOUNT_ID)
    if (!beforeAccountInfo) {
      console.error('❌ 无法获取账户信息，退出')
      process.exit(1)
    }
    
    // 步骤2：手动触发数据同步
    console.log('\n' + '='.repeat(60))
    console.log('🔄 开始手动触发数据同步...')
    console.log('='.repeat(60))
    
    const ownerId = beforeAccountInfo.owner_id
    console.log(`\n📋 使用参数:`)
    console.log(`   账户ID: ${TEST_ACCOUNT_ID}`)
    console.log(`   负责人ID: ${ownerId}`)
    console.log(`   传入时区: ${beforeAccountInfo.timezone_name || 'null (将从 API 获取)'}`)
    
    const syncResult = await syncAccountTodayStats(
      TEST_ACCOUNT_ID,
      ownerId,
      beforeAccountInfo.timezone_name || null
    )
    
    console.log(`\n✅ 同步完成:`)
    console.log(`   会话ID: ${syncResult.sessionId}`)
    console.log(`   同步记录数: ${syncResult.syncedCount}`)
    
    // 步骤3：显示同步后的时区状态
    await showTimezoneStatusAfter(TEST_ACCOUNT_ID)
    
    // 步骤4：验证时区修复效果
    await verifyTimezoneFix(TEST_ACCOUNT_ID, beforeAccountInfo)
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 验证完成')
    console.log('='.repeat(60))
    
  } catch (error) {
    console.error('\n❌ 验证失败:', error.message)
    if (error.stack) {
      console.error('   堆栈:', error.stack.split('\n').slice(0, 5).join('\n'))
    }
    process.exit(1)
  } finally {
    // 关闭数据库连接
    await pool.end()
  }
}

// 执行主函数
main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

