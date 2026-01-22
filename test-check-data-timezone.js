// 检查数据时间和时区问题
// 目的：查看数据库中实际的数据时间，分析为什么 today 查询返回空

import pool from './server/db/connection.js'
import { DateTime } from 'luxon'
import { calculateTimeWindow } from './server/utils/timeWindow.js'

async function checkDataTimezone() {
  try {
    console.log('🔄 检查数据时间和时区问题...\n')
    
    const accountId = process.argv[2] || 'act_927139705822379'
    
    // 1. 查看数据库中实际的数据时间
    console.log('📋 第一步：查看数据库中实际的数据时间...')
    const [rows] = await pool.query(`
      SELECT 
        ad_id,
        synced_at,
        timezone_name,
        spend,
        purchases
      FROM ad_snapshots
      WHERE account_id = ?
      ORDER BY synced_at DESC
      LIMIT 5
    `, [accountId])
    
    if (rows.length === 0) {
      console.error('❌ 没有找到数据')
      process.exit(1)
    }
    
    console.log(`✅ 找到 ${rows.length} 条记录:`)
    rows.forEach((row, index) => {
      console.log(`\n   记录 ${index + 1}:`)
      console.log(`     ad_id: ${row.ad_id}`)
      console.log(`     synced_at: ${row.synced_at} (数据库存储时间)`)
      console.log(`     timezone_name: ${row.timezone_name || 'NULL'}`)
      console.log(`     spend: $${row.spend}`)
      console.log(`     purchases: ${row.purchases}`)
    })
    console.log()
    
    // 2. 获取账户时区
    console.log('📋 第二步：获取账户时区...')
    const [accounts] = await pool.query(`
      SELECT COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings
      WHERE fb_account_id = ?
    `, [accountId])
    
    const timezoneName = accounts[0]?.timezone_name || 'UTC'
    console.log(`✅ 账户时区: ${timezoneName}\n`)
    
    // 3. 数据时区优先（混合方案C）：获取数据时区
    console.log('📋 第三步：数据时区优先（混合方案C）...')
    const dataTimezone = rows[0]?.timezone_name || timezoneName
    console.log(`   数据时区（从快照获取）: ${dataTimezone}`)
    console.log(`   账户时区（从配置获取）: ${timezoneName}`)
    console.log(`   使用的时区（数据时区优先）: ${dataTimezone}\n`)
    
    // 4. 计算 today 时间窗口（使用数据时区优先）
    console.log('📋 第四步：计算 today 时间窗口（使用数据时区优先）...')
    const { start, end } = calculateTimeWindow('today', dataTimezone)
    console.log(`✅ Today 时间窗口 (${dataTimezone}):`)
    console.log(`   开始: ${start.toISO()} (${start.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log(`   结束: ${end.toISO()} (${end.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log()
    
    // 5. 对比：如果使用账户时区会怎样
    console.log('📋 第五步：对比 - 如果使用账户时区（UTC）...')
    const { start: accountStart, end: accountEnd } = calculateTimeWindow('today', timezoneName)
    console.log(`   Today 时间窗口 (${timezoneName}):`)
    console.log(`   开始: ${accountStart.toISO()} (${accountStart.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log(`   结束: ${accountEnd.toISO()} (${accountEnd.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log()
    
    // 6. 计算 yesterday 时间窗口（使用数据时区）
    console.log('📋 第六步：计算 yesterday 时间窗口（使用数据时区）...')
    const { start: yStart, end: yEnd } = calculateTimeWindow('yesterday', dataTimezone)
    console.log(`✅ Yesterday 时间窗口 (${dataTimezone}):`)
    console.log(`   开始: ${yStart.toISO()} (${yStart.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log(`   结束: ${yEnd.toISO()} (${yEnd.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log()
    
    // 7. 检查数据是否在 today 时间窗口内（使用数据时区）
    console.log('📋 第七步：检查数据是否在 today 时间窗口内（使用数据时区优先）...')
    const startDate = start.toFormat('yyyy-MM-dd HH:mm:ss')
    const endDate = end.toFormat('yyyy-MM-dd HH:mm:ss')
    
    rows.forEach((row, index) => {
      const syncedAt = new Date(row.synced_at)
      const isInToday = syncedAt >= start.toJSDate() && syncedAt <= end.toJSDate()
      console.log(`\n   记录 ${index + 1} (${row.ad_id}):`)
      console.log(`     synced_at: ${row.synced_at}`)
      console.log(`     today 开始: ${startDate}`)
      console.log(`     today 结束: ${endDate}`)
      console.log(`     是否在 today 内: ${isInToday ? '✅ 是' : '❌ 否'}`)
      
      if (!isInToday) {
        // 检查是在之前还是之后
        if (syncedAt < start.toJSDate()) {
          const diffHours = (start.toJSDate() - syncedAt) / (1000 * 60 * 60)
          console.log(`     原因: 数据时间早于 today 开始时间 ${diffHours.toFixed(2)} 小时`)
        } else {
          const diffHours = (syncedAt - end.toJSDate()) / (1000 * 60 * 60)
          console.log(`     原因: 数据时间晚于 today 结束时间 ${diffHours.toFixed(2)} 小时`)
        }
      }
    })
    console.log()
    
    // 8. 检查数据是否在 yesterday 时间窗口内
    console.log('📋 第八步：检查数据是否在 yesterday 时间窗口内...')
    const yStartDate = yStart.toFormat('yyyy-MM-dd HH:mm:ss')
    const yEndDate = yEnd.toFormat('yyyy-MM-dd HH:mm:ss')
    
    rows.forEach((row, index) => {
      const syncedAt = new Date(row.synced_at)
      const isInYesterday = syncedAt >= yStart.toJSDate() && syncedAt <= yEnd.toJSDate()
      console.log(`\n   记录 ${index + 1} (${row.ad_id}):`)
      console.log(`     synced_at: ${row.synced_at}`)
      console.log(`     yesterday 开始: ${yStartDate}`)
      console.log(`     yesterday 结束: ${yEndDate}`)
      console.log(`     是否在 yesterday 内: ${isInYesterday ? '✅ 是' : '❌ 否'}`)
    })
    console.log()
    
    // 9. 当前时间（不同时区）
    console.log('📋 第九步：当前时间（不同时区）...')
    const nowUTC = DateTime.now().setZone('UTC')
    const nowAccount = DateTime.now().setZone(timezoneName)
    const nowData = DateTime.now().setZone(dataTimezone)
    console.log(`   当前时间 (UTC): ${nowUTC.toISO()} (${nowUTC.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log(`   当前时间 (账户时区 ${timezoneName}): ${nowAccount.toISO()} (${nowAccount.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log(`   当前时间 (数据时区 ${dataTimezone}): ${nowData.toISO()} (${nowData.toFormat('yyyy-MM-dd HH:mm:ss')})`)
    console.log()
    
    // 10. 实际查询测试（使用 ruleDataService）
    console.log('📋 第十步：实际查询测试（使用 ruleDataService.queryRuleData）...')
    try {
      const { queryRuleData } = await import('./server/services/ruleDataService.js')
      const adIds = rows.map(r => r.ad_id)
      console.log(`   查询账户: ${accountId}`)
      console.log(`   查询广告: ${adIds.slice(0, 2).join(', ')}...`)
      console.log(`   时间窗口: today`)
      console.log(`   预期使用时区: ${dataTimezone} (数据时区优先)\n`)
      
      const todayData = await queryRuleData(accountId, adIds[0], 'today')
      console.log(`   ✅ today 查询结果: ${todayData.length} 条记录`)
      if (todayData.length > 0) {
        console.log(`   ✅ 成功！数据时区优先策略生效`)
        todayData.forEach((ad, i) => {
          console.log(`      记录 ${i + 1}: ad_id=${ad.ad_id}, spend=$${ad.spend}, purchases=${ad.purchases}`)
        })
      } else {
        console.log(`   ⚠️  未查询到数据，可能原因：`)
        console.log(`      - 数据确实是昨天的（不在 today 窗口内）`)
        console.log(`      - 时区计算仍有问题`)
      }
    } catch (error) {
      console.log(`   ❌ 查询失败: ${error.message}`)
    }
    console.log()
    
    await pool.end()
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkDataTimezone()

