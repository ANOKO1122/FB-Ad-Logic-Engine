// ============================================
// 阶段A验证脚本：冷数据归档优化验证
// 目的：验证高频检查 + 本地 06:00 窗口 + 幂等/锁机制
// 创建时间：2026-01-20
// ============================================

import pool from './server/db/connection.js'
import { archiveAllAccountsDailyStats } from './server/services/ingestorService.js'
import { DateTime } from 'luxon'

/**
 * 验证 1：检查唯一索引是否存在
 */
async function verifyUniqueIndex() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 1：检查 daily_stats 唯一索引')
  console.log('='.repeat(50))
  
  try {
    const [rows] = await pool.execute(`
      SELECT 
        INDEX_NAME,
        COLUMN_NAME,
        NON_UNIQUE,
        SEQ_IN_INDEX
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'daily_stats'
        AND INDEX_NAME = 'uk_account_ad_date'
      ORDER BY SEQ_IN_INDEX
    `)
    
    if (rows.length === 0) {
      console.log('❌ 唯一索引不存在！')
      console.log('   请先执行迁移脚本：')
      console.log('   mysql -u root -p fb_ad_brain < server/db/migrations/005_add_unique_index_to_daily_stats.sql')
      return false
    }
    
    console.log('✅ 唯一索引存在：')
    rows.forEach(row => {
      console.log(`   - ${row.COLUMN_NAME} (顺序: ${row.SEQ_IN_INDEX}, 唯一: ${row.NON_UNIQUE === 0 ? '是' : '否'})`)
    })
    
    return true
  } catch (error) {
    console.error('❌ 检查唯一索引失败:', error.message)
    return false
  }
}

/**
 * 验证 2：检查账户时区配置
 */
async function verifyAccountTimezones() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 2：检查账户时区配置')
  console.log('='.repeat(50))
  
  try {
    const [rows] = await pool.execute(`
      SELECT 
        fb_account_id as account_id,
        timezone_name,
        is_active
      FROM account_mappings
      WHERE is_active = 1
      ORDER BY fb_account_id
    `)
    
    if (rows.length === 0) {
      console.log('⚠️  没有找到活跃账户')
      return false
    }
    
    console.log(`✅ 找到 ${rows.length} 个活跃账户：`)
    rows.forEach(row => {
      const timezone = row.timezone_name || 'UTC'
      const now = DateTime.now().setZone(timezone)
      const localTime = now.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')
      const hour = now.hour
      const minute = now.minute
      const inWindow = (hour === 6 && minute >= 0 && minute <= 9)
      
      console.log(`   - 账户: ${row.account_id}`)
      console.log(`     时区: ${timezone}`)
      console.log(`     本地时间: ${localTime}`)
      console.log(`     是否在归档窗口 (06:00-06:09): ${inWindow ? '✅ 是' : '❌ 否'}`)
      console.log('')
    })
    
    return true
  } catch (error) {
    console.error('❌ 检查账户时区失败:', error.message)
    return false
  }
}

/**
 * 验证 3：测试幂等性（多次触发不重复归档）
 */
async function verifyIdempotency() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 3：测试幂等性（多次触发不重复归档）')
  console.log('='.repeat(50))
  
  try {
    // 获取一个测试账户
    const [accountRows] = await pool.execute(`
      SELECT fb_account_id as account_id, timezone_name
      FROM account_mappings
      WHERE is_active = 1
      LIMIT 1
    `)
    
    if (accountRows.length === 0) {
      console.log('⚠️  没有找到测试账户')
      return false
    }
    
    const account = accountRows[0]
    const accountId = account.account_id
    const timezoneName = account.timezone_name || 'UTC'
    
    // 计算目标日期（昨日）
    const localNow = DateTime.now().setZone(timezoneName)
    const yesterday = localNow.minus({ days: 1 })
    const targetDateStr = yesterday.toFormat('yyyy-MM-dd')
    
    console.log(`📋 测试账户: ${accountId}`)
    console.log(`📅 目标日期: ${targetDateStr}`)
    console.log('')
    
    // 第一次归档（强制归档，忽略时区窗口）
    console.log('🔄 第一次归档（强制模式）...')
    const result1 = await archiveAllAccountsDailyStats(yesterday.toJSDate(), true)
    console.log(`   结果: 归档 ${result1.totalArchivedCount} 条记录`)
    
    // 等待 2 秒
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // 第二次归档（应该跳过，因为已归档）
    console.log('\n🔄 第二次归档（应该跳过）...')
    const result2 = await archiveAllAccountsDailyStats(yesterday.toJSDate(), true)
    console.log(`   结果: 归档 ${result2.totalArchivedCount} 条记录，跳过 ${result2.skippedAccounts} 个账户`)
    
    // 验证数据库中的记录数
    const [checkRows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM daily_stats WHERE account_id = ? AND date = ?`,
      [accountId, targetDateStr]
    )
    const recordCount = checkRows[0]?.cnt || 0
    
    console.log(`\n📊 数据库记录数: ${recordCount}`)
    
    if (result2.totalArchivedCount === 0 && result2.skippedAccounts > 0) {
      console.log('✅ 幂等性验证通过：第二次归档被正确跳过')
      return true
    } else {
      console.log('❌ 幂等性验证失败：第二次归档仍然执行了')
      return false
    }
  } catch (error) {
    console.error('❌ 幂等性验证失败:', error.message)
    return false
  }
}

/**
 * 验证 4：测试时区窗口判断
 */
async function verifyTimezoneWindow() {
  console.log('\n' + '='.repeat(50))
  console.log('验证 4：测试时区窗口判断')
  console.log('='.repeat(50))
  
  try {
    // 获取所有账户
    const [accountRows] = await pool.execute(`
      SELECT fb_account_id as account_id, timezone_name
      FROM account_mappings
      WHERE is_active = 1
    `)
    
    if (accountRows.length === 0) {
      console.log('⚠️  没有找到测试账户')
      return false
    }
    
    console.log(`📋 检查 ${accountRows.length} 个账户的归档窗口...`)
    console.log('')
    
    let inWindowCount = 0
    let outWindowCount = 0
    
    for (const account of accountRows) {
      const timezoneName = account.timezone_name || 'UTC'
      const now = DateTime.now().setZone(timezoneName)
      const hour = now.hour
      const minute = now.minute
      const inWindow = (hour === 6 && minute >= 0 && minute <= 9)
      
      if (inWindow) {
        inWindowCount++
        console.log(`✅ 账户 ${account.account_id} (${timezoneName}): 在归档窗口 (${now.toFormat('HH:mm')})`)
      } else {
        outWindowCount++
        // 不打印不在窗口的账户，避免日志过多
      }
    }
    
    console.log(`\n📊 统计:`)
    console.log(`   - 在归档窗口: ${inWindowCount} 个账户`)
    console.log(`   - 不在归档窗口: ${outWindowCount} 个账户`)
    
    if (inWindowCount > 0) {
      console.log('\n💡 提示：如果有账户在归档窗口，执行归档检查应该会归档这些账户')
    } else {
      console.log('\n💡 提示：当前没有账户在归档窗口，归档检查会跳过所有账户')
      console.log('   你可以手动修改系统时间或等待到 06:00-06:09 窗口进行测试')
    }
    
    return true
  } catch (error) {
    console.error('❌ 时区窗口验证失败:', error.message)
    return false
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('')
  console.log('='.repeat(50))
  console.log('阶段A验证：冷数据归档优化')
  console.log('='.repeat(50))
  
  try {
    // 验证 1：检查唯一索引
    const indexOk = await verifyUniqueIndex()
    if (!indexOk) {
      console.log('\n❌ 唯一索引检查失败，请先执行迁移脚本')
      process.exit(1)
    }
    
    // 验证 2：检查账户时区配置
    await verifyAccountTimezones()
    
    // 验证 3：测试幂等性
    await verifyIdempotency()
    
    // 验证 4：测试时区窗口判断
    await verifyTimezoneWindow()
    
    console.log('\n' + '='.repeat(50))
    console.log('✅ 验证完成')
    console.log('='.repeat(50))
    console.log('\n💡 下一步：')
    console.log('   1. 确保唯一索引已创建')
    console.log('   2. 观察日志，确认归档检查按账户本地时区执行')
    console.log('   3. 稳定运行一段时间后，可以移除旧版本的 06:00 任务')
    console.log('')
  } catch (error) {
    console.error('\n❌ 验证失败:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// 执行验证
main()

