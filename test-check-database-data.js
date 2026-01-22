// 检查数据库中是否有数据
// 用于验证 API 返回空数组的原因

import pool from './server/db/connection.js'

async function checkDatabaseData() {
  try {
    console.log('🔍 检查数据库中的数据...\n')
    
    const accountId = 'act_927139705822379'
    
    // 1. 检查 ad_snapshots 表（热数据）
    console.log('📋 第一步：检查 ad_snapshots 表（热数据）...')
    const [snapshots] = await pool.execute(`
      SELECT 
        ad_id,
        ad_name,
        synced_at,
        timezone_name,
        spend,
        purchases
      FROM ad_snapshots
      WHERE account_id = ?
      ORDER BY synced_at DESC
      LIMIT 10
    `, [accountId])
    
    console.log(`✅ 找到 ${snapshots.length} 条快照记录:`)
    snapshots.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, ad_name: ${row.ad_name}`)
      console.log(`      synced_at: ${row.synced_at}, timezone: ${row.timezone_name}`)
      console.log(`      spend: $${row.spend}, purchases: ${row.purchases}`)
    })
    
    // 2. 检查 daily_stats 表（冷数据）
    console.log('\n📋 第二步：检查 daily_stats 表（冷数据）...')
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
      ORDER BY date DESC
      LIMIT 10
    `, [accountId])
    
    console.log(`✅ 找到 ${dailyStats.length} 条日统计数据:`)
    dailyStats.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, ad_name: ${row.ad_name}`)
      console.log(`      date: ${row.date}, timezone: ${row.timezone_name}`)
      console.log(`      spend: $${row.spend}, purchases: ${row.purchases}`)
    })
    
    // 3. 检查 today 时间范围内的数据
    console.log('\n📋 第三步：检查 today 时间范围内的数据（2026-01-20）...')
    const todayStart = '2026-01-20 00:00:00'
    const todayEnd = '2026-01-20 23:59:59'
    
    const [todayData] = await pool.execute(`
      SELECT 
        ad_id,
        ad_name,
        synced_at,
        spend,
        purchases
      FROM ad_snapshots
      WHERE account_id = ?
        AND synced_at >= ?
        AND synced_at <= ?
      ORDER BY synced_at DESC
    `, [accountId, todayStart, todayEnd])
    
    console.log(`✅ 找到 ${todayData.length} 条 today 数据:`)
    todayData.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, synced_at: ${row.synced_at}`)
    })
    
    // 4. 检查 custom_range 时间范围内的数据（daily_stats）
    console.log('\n📋 第四步：检查 custom_range 时间范围内的数据（2026-01-14 到 2026-01-20）...')
    const rangeStart = '2026-01-14'
    const rangeEnd = '2026-01-20'
    
    const [rangeData] = await pool.execute(`
      SELECT 
        ad_id,
        ad_name,
        date,
        spend,
        purchases
      FROM daily_stats
      WHERE account_id = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date DESC
    `, [accountId, rangeStart, rangeEnd])
    
    console.log(`✅ 找到 ${rangeData.length} 条 custom_range 数据:`)
    rangeData.forEach((row, index) => {
      console.log(`   ${index + 1}. ad_id: ${row.ad_id}, date: ${row.date}`)
    })
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 检查完成！')
    console.log('\n💡 分析：')
    if (todayData.length === 0) {
      console.log('   ⚠️  today 查询返回空数组：数据库中 2026-01-20 没有数据')
      console.log('      可能原因：1) 今天还没有同步数据 2) 数据在其他日期')
    }
    if (rangeData.length === 0) {
      console.log('   ⚠️  custom_range 查询返回空数组：daily_stats 表中没有数据')
      console.log('      可能原因：1) 冷数据还未归档（需要在 06:00 后归档）')
      console.log('                 2) 该时间范围内确实没有数据')
    }
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkDatabaseData()

