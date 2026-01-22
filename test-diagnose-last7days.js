// 诊断 last_7_days 查询返回空数组的原因
// 目的：分析数据源选择、时区匹配、数据存在性等问题

import pool from './server/db/connection.js'
import { calculateTimeWindow } from './server/utils/timeWindow.js'
import { DateTime } from 'luxon'

async function diagnoseLast7Days() {
  try {
    console.log('🔍 诊断 last_7_days 查询返回空数组的原因...\n')
    
    const accountId = 'act_927139705822379'
    const timeWindow = 'last_7_days'
    const timezoneName = 'UTC'
    
    // 1. 计算时间窗口
    console.log('📋 第一步：计算时间窗口...')
    const { start, end } = calculateTimeWindow(timeWindow, timezoneName)
    const startDate = start.toFormat('yyyy-MM-dd')
    const endDate = end.toFormat('yyyy-MM-dd')
    console.log(`✅ 时间窗口: ${startDate} 到 ${endDate}`)
    console.log(`   开始时间 (UTC): ${start.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')}`)
    console.log(`   结束时间 (UTC): ${end.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')}\n`)
    
    // 2. 检查 daily_stats 表中的数据
    console.log('📋 第二步：检查 daily_stats 表中的数据...')
    const [dailyStats] = await pool.execute(`
      SELECT 
        ad_id,
        ad_name,
        date,
        timezone_name,
        spend,
        purchases
      FROM daily_stats
      WHERE account_id = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date DESC
    `, [accountId, startDate, endDate])
    
    console.log(`✅ 找到 ${dailyStats.length} 条 daily_stats 数据:`)
    dailyStats.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, date: ${row.date}, timezone: ${row.timezone_name}`)
    })
    
    // 3. 检查时区匹配情况
    console.log('\n📋 第三步：检查时区匹配情况...')
    const [timezoneStats] = await pool.execute(`
      SELECT 
        COUNT(*) as count,
        timezone_name
      FROM daily_stats
      WHERE account_id = ?
        AND date >= ?
        AND date <= ?
      GROUP BY timezone_name
    `, [accountId, startDate, endDate])
    
    console.log(`✅ 时区分布:`)
    timezoneStats.forEach(row => {
      console.log(`   ${row.timezone_name}: ${row.count} 条`)
    })
    console.log(`   查询使用的时区: ${timezoneName}`)
    
    // 4. 检查 ad_snapshots 表中的数据（今天的数据）
    console.log('\n📋 第四步：检查 ad_snapshots 表中的数据（今天的数据）...')
    const todayStart = DateTime.now().setZone(timezoneName).startOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
    const todayEnd = DateTime.now().setZone(timezoneName).endOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
    
    const [todaySnapshots] = await pool.execute(`
      SELECT 
        ad_id,
        ad_name,
        synced_at,
        timezone_name,
        spend,
        purchases
      FROM ad_snapshots
      WHERE account_id = ?
        AND synced_at >= ?
        AND synced_at <= ?
      ORDER BY synced_at DESC
      LIMIT 10
    `, [accountId, todayStart, todayEnd])
    
    console.log(`✅ 找到 ${todaySnapshots.length} 条今天的快照数据:`)
    todaySnapshots.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, synced_at: ${row.synced_at}`)
    })
    
    // 5. 分析问题
    console.log('\n' + '='.repeat(60))
    console.log('📊 问题分析:')
    console.log('='.repeat(60))
    
    if (dailyStats.length === 0) {
      console.log('❌ 问题1: daily_stats 表中没有数据')
      console.log('   原因: 冷数据还未归档（需要在每天 06:00 归档）')
      console.log('   解决方案: 等待归档任务执行，或手动触发归档')
    } else {
      const timezoneMatch = dailyStats.some(row => row.timezone_name === timezoneName)
      if (!timezoneMatch) {
        console.log('❌ 问题2: 时区不匹配')
        console.log(`   查询使用的时区: ${timezoneName}`)
        console.log(`   数据中的时区: ${dailyStats.map(r => r.timezone_name).join(', ')}`)
        console.log('   解决方案: 修改查询逻辑，支持时区匹配或降级到 ad_snapshots')
      }
    }
    
    if (todaySnapshots.length > 0) {
      console.log('⚠️  问题3: last_7_days 应该包含今天的数据')
      console.log('   当前实现: 只查询 daily_stats（不包含今天）')
      console.log('   建议: 合并查询 daily_stats（历史）和 ad_snapshots（今天）')
    }
    
    console.log('\n💡 建议:')
    console.log('   1. 如果 daily_stats 中没有数据，应该降级到 ad_snapshots 查询')
    console.log('   2. last_7_days 应该合并 today 的数据（从 ad_snapshots）和历史数据（从 daily_stats）')
    console.log('   3. 或者，如果 daily_stats 为空，直接从 ad_snapshots 查询过去 7 天的数据')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 诊断失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

diagnoseLast7Days()

