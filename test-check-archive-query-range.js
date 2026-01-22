/**
 * 检查归档查询的时间范围
 * 
 * 功能：
 * 1. 检查归档查询的时间范围是否正确
 * 2. 检查为什么只有部分数据被归档
 * 
 * 使用方法：
 * node test-check-archive-query-range.js [account_id] [date]
 */

import pool from './server/db/connection.js'
import { DateTime } from 'luxon'
import dotenv from 'dotenv'

dotenv.config()

let TEST_ACCOUNT_ID = process.argv[2] || null
let TARGET_DATE = process.argv[3] || null

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('🔍 检查归档查询的时间范围')
  console.log('='.repeat(60))
  console.log('')
  
  try {
    // 1. 获取账户时区
    let accountTimezone = 'UTC'
    
    if (!TEST_ACCOUNT_ID) {
      const [accounts] = await pool.query(`
        SELECT fb_account_id as account_id, timezone_name
        FROM account_mappings 
        WHERE is_active = 1
        LIMIT 1
      `)
      
      if (!accounts || accounts.length === 0) {
        console.error('❌ 没有找到活跃账户')
        process.exit(1)
      }
      
      TEST_ACCOUNT_ID = accounts[0].account_id
      accountTimezone = accounts[0].timezone_name || 'UTC'
    } else {
      const [accounts] = await pool.query(`
        SELECT timezone_name
        FROM account_mappings
        WHERE fb_account_id = ?
          AND is_active = 1
      `, [TEST_ACCOUNT_ID])
      
      if (!accounts || accounts.length === 0) {
        console.error(`❌ 账户 ${TEST_ACCOUNT_ID} 不存在或未激活`)
        process.exit(1)
      }
      
      accountTimezone = accounts[0].timezone_name || 'UTC'
    }
    
    console.log(`📋 检查账户: ${TEST_ACCOUNT_ID}`)
    console.log(`🌍 账户时区: ${accountTimezone}`)
    console.log('')
    
    // 2. 确定目标日期（默认为昨天）
    let targetDate
    if (TARGET_DATE) {
      targetDate = DateTime.fromFormat(TARGET_DATE, 'yyyy-MM-dd', { zone: accountTimezone })
      if (!targetDate.isValid) {
        console.error(`❌ 日期格式错误: ${TARGET_DATE}`)
        process.exit(1)
      }
    } else {
      const nowInAccountTz = DateTime.now().setZone(accountTimezone)
      targetDate = nowInAccountTz.minus({ days: 1 })
    }
    
    const targetDateStr = targetDate.toFormat('yyyy-MM-dd')
    console.log(`📅 目标日期: ${targetDateStr} (${accountTimezone})`)
    console.log('')
    
    // 3. 计算归档查询的时间范围（模拟归档逻辑）
    const targetDateStart = targetDate.startOf('day')
    const targetDateEnd = targetDate.endOf('day')
    const startTime = targetDateStart.toJSDate()
    const endTime = targetDateEnd.toJSDate()
    
    console.log(`📅 归档查询时间范围（模拟归档逻辑）:`)
    console.log(`   账户时区: ${targetDateStart.toFormat('yyyy-MM-dd HH:mm:ss')} ~ ${targetDateEnd.toFormat('yyyy-MM-dd HH:mm:ss')}`)
    console.log(`   UTC: ${startTime.toISOString()} ~ ${endTime.toISOString()}`)
    console.log('')
    
    // 4. 查询 ad_snapshots 中目标日期的所有数据
    console.log('📊 步骤 1：查询 ad_snapshots 中目标日期的所有数据...')
    const [allSnapshots] = await pool.query(`
      SELECT 
        ad_id,
        ad_name,
        synced_at,
        spend,
        purchases
      FROM ad_snapshots
      WHERE account_id = ?
        AND synced_at >= ? AND synced_at <= ?
      ORDER BY ad_id, synced_at DESC
    `, [TEST_ACCOUNT_ID, startTime, endTime])
    
    console.log(`✅ 找到 ${allSnapshots.length} 条记录（所有快照）`)
    console.log('')
    
    // 5. 模拟归档查询（使用 ROW_NUMBER）
    console.log('📊 步骤 2：模拟归档查询（使用 ROW_NUMBER，取每个广告的最后快照）...')
    let archivedRows
    try {
      const [result] = await pool.query(`
        SELECT 
          account_id,
          ad_id,
          ad_name,
          synced_at,
          spend,
          purchases
        FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY account_id, ad_id 
              ORDER BY synced_at DESC
            ) as rn
          FROM ad_snapshots
          WHERE synced_at >= ? AND synced_at <= ?
        ) ranked
        WHERE rn = 1 AND account_id = ?
      `, [startTime, endTime, TEST_ACCOUNT_ID])
      
      archivedRows = result
    } catch (error) {
      console.error(`❌ ROW_NUMBER() 查询失败: ${error.message}`)
      console.log('   使用兼容方案...')
      
      // 兼容方案
      const [lastSnapRows] = await pool.query(`
        SELECT 
          account_id,
          ad_id,
          MAX(synced_at) as last_synced_at
        FROM ad_snapshots
        WHERE account_id = ?
          AND synced_at >= ? AND synced_at <= ?
        GROUP BY account_id, ad_id
      `, [TEST_ACCOUNT_ID, startTime, endTime])
      
      if (lastSnapRows.length > 0) {
        const lastSnapMap = new Map()
        lastSnapRows.forEach(row => {
          lastSnapMap.set(`${row.account_id}_${row.ad_id}`, row.last_synced_at)
        })
        
        archivedRows = allSnapshots.filter(snap => {
          const key = `${snap.account_id}_${snap.ad_id}`
          const lastTime = lastSnapMap.get(key)
          return lastTime && new Date(snap.synced_at).getTime() === new Date(lastTime).getTime()
        })
      } else {
        archivedRows = []
      }
    }
    
    console.log(`✅ 归档查询结果: ${archivedRows.length} 条记录（每个广告的最后快照）`)
    console.log('')
    
    // 6. 对比分析
    console.log('📊 步骤 3：对比分析...')
    console.log('')
    
    // 按广告分组统计
    const adGroups = new Map()
    allSnapshots.forEach(snap => {
      const adId = String(snap.ad_id || '')
      if (!adGroups.has(adId)) {
        adGroups.set(adId, [])
      }
      adGroups.get(adId).push(snap)
    })
    
    const archivedAdIds = new Set(archivedRows.map(r => String(r.ad_id || '')))
    
    console.log(`📊 统计信息:`)
    console.log(`   总快照数: ${allSnapshots.length} 条`)
    console.log(`   广告数: ${adGroups.size} 个`)
    console.log(`   归档查询结果: ${archivedRows.length} 条（每个广告的最后快照）`)
    console.log('')
    
    // 检查哪些广告有多个快照
    const multiSnapshotAds = []
    adGroups.forEach((snaps, adId) => {
      if (snaps.length > 1) {
        multiSnapshotAds.push({
          ad_id: adId,
          ad_name: snaps[0].ad_name || '',
          snapshot_count: snaps.length,
          first_sync: snaps[snaps.length - 1].synced_at,
          last_sync: snaps[0].synced_at
        })
      }
    })
    
    if (multiSnapshotAds.length > 0) {
      console.log(`📊 有多个快照的广告 (${multiSnapshotAds.length} 个):`)
      multiSnapshotAds.slice(0, 5).forEach(ad => {
        console.log(`   - ${ad.ad_id} (${ad.ad_name}): ${ad.snapshot_count} 个快照`)
        console.log(`     最早: ${ad.first_sync}`)
        console.log(`     最晚: ${ad.last_sync}`)
      })
      if (multiSnapshotAds.length > 5) {
        console.log(`   ... 还有 ${multiSnapshotAds.length - 5} 个`)
      }
      console.log('')
    }
    
    // 检查 daily_stats 中的实际归档数据
    const [dailyStatsRows] = await pool.query(`
      SELECT ad_id, ad_name, date, spend, purchases, created_at
      FROM daily_stats
      WHERE account_id = ?
        AND date = ?
      ORDER BY ad_id
    `, [TEST_ACCOUNT_ID, targetDateStr])
    
    console.log(`📊 daily_stats 实际归档数据: ${dailyStatsRows.length} 条`)
    console.log('')
    
    // 对比归档查询结果和实际归档数据
    const archivedAdIdsSet = new Set(archivedRows.map(r => String(r.ad_id || '')))
    const dailyStatsAdIdsSet = new Set(dailyStatsRows.map(r => String(r.ad_id || '')))
    
    const missingInDaily = []
    archivedAdIdsSet.forEach(adId => {
      if (!dailyStatsAdIdsSet.has(adId)) {
        const archivedRow = archivedRows.find(r => String(r.ad_id) === adId)
        missingInDaily.push({
          ad_id: adId,
          ad_name: archivedRow?.ad_name || '',
          spend: archivedRow?.spend || 0,
          note: '归档查询有数据，但 daily_stats 中没有（归档可能失败）'
        })
      }
    })
    
    const extraInDaily = []
    dailyStatsAdIdsSet.forEach(adId => {
      if (!archivedAdIdsSet.has(adId)) {
        const dailyRow = dailyStatsRows.find(r => String(r.ad_id) === adId)
        extraInDaily.push({
          ad_id: adId,
          ad_name: dailyRow?.ad_name || '',
          spend: dailyRow?.spend || 0,
          note: 'daily_stats 有数据，但归档查询中没有（可能是其他时间归档的）'
        })
      }
    })
    
    if (missingInDaily.length > 0) {
      console.log(`⚠️  归档查询有但 daily_stats 没有 (${missingInDaily.length} 条):`)
      missingInDaily.forEach(r => {
        const spendValue = Number(r.spend) || 0
        console.log(`   - ${r.ad_id} (${r.ad_name}): spend = ${spendValue.toFixed(2)}`)
        console.log(`     说明: ${r.note}`)
      })
      console.log('')
    }
    
    if (extraInDaily.length > 0) {
      console.log(`⚠️  daily_stats 有但归档查询没有 (${extraInDaily.length} 条):`)
      extraInDaily.forEach(r => {
        const spendValue = Number(r.spend) || 0
        console.log(`   - ${r.ad_id} (${r.ad_name}): spend = ${spendValue.toFixed(2)}`)
        console.log(`     说明: ${r.note}`)
      })
      console.log('')
    }
    
    // 7. 检查时间范围问题
    console.log('📊 步骤 4：检查时间范围问题...')
    console.log('')
    
    // 检查 ad_snapshots 中目标日期的数据时间分布
    if (allSnapshots.length > 0) {
      const syncTimes = allSnapshots.map(s => new Date(s.synced_at))
      const earliestSync = new Date(Math.min(...syncTimes))
      const latestSync = new Date(Math.max(...syncTimes))
      
      const earliestSyncTz = DateTime.fromJSDate(earliestSync).setZone(accountTimezone)
      const latestSyncTz = DateTime.fromJSDate(latestSync).setZone(accountTimezone)
      
      console.log(`📊 ad_snapshots 时间分布:`)
      console.log(`   最早: ${earliestSync.toISOString()} (${earliestSyncTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
      console.log(`   最晚: ${latestSync.toISOString()} (${latestSyncTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
      console.log(`   查询范围: ${startTime.toISOString()} ~ ${endTime.toISOString()}`)
      
      // 检查是否有数据在查询范围外
      const outOfRange = allSnapshots.filter(snap => {
        const syncTime = new Date(snap.synced_at)
        return syncTime < startTime || syncTime > endTime
      })
      
      if (outOfRange.length > 0) {
        console.log(`   ⚠️  有 ${outOfRange.length} 条记录在查询范围外（这不应该发生）`)
      } else {
        console.log(`   ✅ 所有数据都在查询范围内`)
      }
      console.log('')
    }
    
    // 8. 汇总结论
    console.log('='.repeat(60))
    console.log('📝 分析结论:')
    console.log('='.repeat(60))
    
    if (archivedRows.length === dailyStatsRows.length && missingInDaily.length === 0 && extraInDaily.length === 0) {
      console.log('✅ 归档查询和实际归档数据一致')
    } else {
      console.log('⚠️  归档查询和实际归档数据不一致:')
      if (archivedRows.length !== dailyStatsRows.length) {
        console.log(`   - 归档查询: ${archivedRows.length} 条，实际归档: ${dailyStatsRows.length} 条`)
      }
      if (missingInDaily.length > 0) {
        console.log(`   - ${missingInDaily.length} 条记录归档查询有但未归档`)
      }
      if (extraInDaily.length > 0) {
        console.log(`   - ${extraInDaily.length} 条记录已归档但归档查询没有`)
      }
    }
    
    if (allSnapshots.length > archivedRows.length) {
      console.log(`⚠️  总快照数 (${allSnapshots.length}) > 归档查询结果 (${archivedRows.length})`)
      console.log(`   说明：归档查询只取每个广告的最后快照，这是正常的`)
    }
    
    console.log('='.repeat(60))
    console.log('')
    
  } catch (error) {
    console.error('')
    console.error('='.repeat(60))
    console.error('❌ 检查失败')
    console.error('='.repeat(60))
    console.error('')
    console.error('错误信息:', error.message)
    if (error.stack) {
      console.error('')
      console.error('错误堆栈:')
      console.error(error.stack.split('\n').slice(0, 10).join('\n'))
    }
    process.exit(1)
  } finally {
    try {
      await pool.end()
    } catch (err) {
      // 忽略关闭连接时的错误
    }
  }
}

main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

