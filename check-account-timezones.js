// ============================================
// 检查账户时区配置
// 目的：检查 account_mappings 表中的时区配置情况
// ============================================

import pool from './server/db/connection.js'
import { DateTime } from 'luxon'

async function checkAccountTimezones() {
  console.log('')
  console.log('='.repeat(50))
  console.log('检查账户时区配置')
  console.log('='.repeat(50))
  console.log('')
  
  try {
    // 1. 检查服务器时间
    const serverTimeUTC = DateTime.now().toUTC()
    const serverTimeLocal = DateTime.now().toLocal()
    const serverTimeShanghai = DateTime.now().setZone('Asia/Shanghai')
    
    console.log('📅 服务器时间:')
    console.log(`   - UTC: ${serverTimeUTC.toISO()}`)
    console.log(`   - 本地: ${serverTimeLocal.toISO()} (${serverTimeLocal.offsetNameShort})`)
    console.log(`   - Asia/Shanghai: ${serverTimeShanghai.toISO()} (${serverTimeShanghai.offsetNameShort})`)
    console.log('')
    
    // 2. 检查 account_mappings 表中的时区配置
    console.log('📊 检查 account_mappings 表中的时区配置...')
    const [accountRows] = await pool.execute(
      `SELECT 
        fb_account_id,
        timezone_name,
        is_active,
        owner_id
       FROM account_mappings
       WHERE is_active = 1
       ORDER BY fb_account_id
       LIMIT 10`
    )
    
    if (accountRows.length === 0) {
      console.log('⚠️  没有找到活跃账户')
      return
    }
    
    console.log(`✅ 找到 ${accountRows.length} 个活跃账户（显示前10个）:`)
    console.log('')
    
    const timezoneStats = {}
    
    for (const account of accountRows) {
      const timezoneName = account.timezone_name || 'UTC（NULL）'
      const accountId = account.fb_account_id
      
      // 统计时区分布
      if (!timezoneStats[timezoneName]) {
        timezoneStats[timezoneName] = 0
      }
      timezoneStats[timezoneName]++
      
      // 计算账户本地时间
      let localTime = null
      let inArchiveWindow = false
      
      if (account.timezone_name) {
        try {
          localTime = DateTime.now().setZone(account.timezone_name)
          const hour = localTime.hour
          const minute = localTime.minute
          inArchiveWindow = (hour === 6 && minute >= 0 && minute <= 9)
        } catch (error) {
          // 时区无效
        }
      }
      
      console.log(`   - 账户: ${accountId}`)
      console.log(`     时区配置: ${timezoneName}`)
      if (localTime) {
        console.log(`     本地时间: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}`)
        console.log(`     是否在归档窗口 (06:00-06:09): ${inArchiveWindow ? '✅ 是' : '❌ 否'}`)
      }
      console.log('')
    }
    
    // 3. 统计时区分布
    console.log('📊 时区分布统计:')
    Object.entries(timezoneStats).forEach(([tz, count]) => {
      console.log(`   - ${tz}: ${count} 个账户`)
    })
    console.log('')
    
    // 4. 检查测试账户的时区
    const testAccountId = 'act_927139705822379'
    const [testAccountRows] = await pool.execute(
      `SELECT timezone_name FROM account_mappings WHERE fb_account_id = ?`,
      [testAccountId]
    )
    
    if (testAccountRows.length > 0) {
      const testTimezone = testAccountRows[0].timezone_name || 'UTC（NULL）'
      console.log(`📊 测试账户 ${testAccountId} 的时区:`)
      console.log(`   - 配置时区: ${testTimezone}`)
      
      if (testAccountRows[0].timezone_name) {
        const testLocalTime = DateTime.now().setZone(testAccountRows[0].timezone_name)
        console.log(`   - 本地时间: ${testLocalTime.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}`)
        const hour = testLocalTime.hour
        const minute = testLocalTime.minute
        const inWindow = (hour === 6 && minute >= 0 && minute <= 9)
        console.log(`   - 是否在归档窗口: ${inWindow ? '✅ 是' : '❌ 否'} (当前时间: ${testLocalTime.toFormat('HH:mm')})`)
      }
      console.log('')
    }
    
    // 5. 检查数据同步时是否从 Facebook API 获取时区
    console.log('💡 时区配置说明:')
    console.log('   1. 账户时区应该从 Facebook API 获取（/account_id?fields=timezone_name）')
    console.log('   2. 数据同步时会获取时区并写入 account_mappings.timezone_name')
    console.log('   3. 如果 timezone_name 为 NULL，会使用默认值 UTC')
    console.log('   4. 归档检查会根据账户本地时区判断是否在 06:00-06:09 窗口')
    console.log('')
    
    // 6. 检查是否有 timezone_name 为 NULL 的账户
    const [nullTimezoneRows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM account_mappings WHERE is_active = 1 AND (timezone_name IS NULL OR timezone_name = '')`
    )
    
    const nullCount = nullTimezoneRows[0]?.cnt || 0
    if (nullCount > 0) {
      console.log(`⚠️  发现 ${nullCount} 个账户的时区为 NULL 或空字符串`)
      console.log('💡 提示：这些账户会使用默认值 UTC')
      console.log('   建议：运行数据同步任务，从 Facebook API 获取时区并更新数据库')
      console.log('')
    }
    
    // 7. 前端时区显示说明
    console.log('💡 前端时区显示说明:')
    console.log('   1. 后端返回的数据使用 UTC 时区（数据库会话时区）')
    console.log('   2. 前端应该使用 Luxon 将时间转换为用户本地时区（如 Asia/Shanghai）')
    console.log('   3. 显示时区应该从账户配置或用户设置中获取')
    console.log('   4. 例如：DateTime.fromISO(utcTime).setZone("Asia/Shanghai")')
    console.log('')
    
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error('   错误堆栈:', error.stack)
  } finally {
    await pool.end()
  }
}

// 执行检查
checkAccountTimezones()

