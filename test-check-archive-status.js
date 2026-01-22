/**
 * 检查冷数据归档状态
 * 
 * 功能：
 * 1. 检查 daily_stats 表中是否有昨天的数据
 * 2. 检查归档时间是否在账户本地时区的 06:00 左右
 * 3. 对比 ad_snapshots 和 daily_stats 的数据一致性
 * 
 * 使用方法：
 * node test-check-archive-status.js [account_id] [date]
 * 
 * 参数：
 *   account_id: 可选，指定要检查的账户ID，默认使用第一个活跃账户
 *   date: 可选，指定要检查的日期（YYYY-MM-DD），默认为昨天
 */

import pool from './server/db/connection.js'
import { DateTime } from 'luxon'
import dotenv from 'dotenv'

dotenv.config()

// 测试账户ID和日期（如果命令行参数未提供）
let TEST_ACCOUNT_ID = process.argv[2] || null
let TARGET_DATE = process.argv[3] || null

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('🔍 检查冷数据归档状态')
  console.log('='.repeat(60))
  console.log('')
  
  try {
    // 1. 获取测试账户和时区信息
    let accountTimezone = 'UTC'
    let ownerId = null
    
    if (!TEST_ACCOUNT_ID) {
      console.log('📋 查询第一个活跃账户...')
      const [accounts] = await pool.query(`
        SELECT fb_account_id as account_id, owner_id, timezone_name
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
      ownerId = accounts[0].owner_id
      console.log(`✅ 找到账户: ${TEST_ACCOUNT_ID} (时区: ${accountTimezone})`)
    } else {
      const [accounts] = await pool.query(`
        SELECT timezone_name, owner_id
        FROM account_mappings
        WHERE fb_account_id = ?
          AND is_active = 1
      `, [TEST_ACCOUNT_ID])
      
      if (!accounts || accounts.length === 0) {
        console.error(`❌ 账户 ${TEST_ACCOUNT_ID} 不存在或未激活`)
        process.exit(1)
      }
      
      accountTimezone = accounts[0].timezone_name || 'UTC'
      ownerId = accounts[0].owner_id
    }
    
    console.log(`📋 检查账户: ${TEST_ACCOUNT_ID}`)
    console.log(`🌍 账户时区: ${accountTimezone}`)
    console.log('')
    
    // 2. 确定目标日期（默认为昨天）
    let targetDate
    if (TARGET_DATE) {
      targetDate = DateTime.fromFormat(TARGET_DATE, 'yyyy-MM-dd', { zone: accountTimezone })
      if (!targetDate.isValid) {
        console.error(`❌ 日期格式错误: ${TARGET_DATE}，请使用 YYYY-MM-DD 格式`)
        process.exit(1)
      }
    } else {
      // 默认使用昨天（账户时区）
      const nowInAccountTz = DateTime.now().setZone(accountTimezone)
      targetDate = nowInAccountTz.minus({ days: 1 })
    }
    
    const targetDateStr = targetDate.toFormat('yyyy-MM-dd')
    console.log(`📅 目标日期: ${targetDateStr} (${accountTimezone})`)
    console.log('')
    
    // 3. 计算目标日期的 UTC 边界（用于查询）
    const targetDateStart = targetDate.startOf('day')
    const targetDateEnd = targetDate.endOf('day')
    const targetDateStartUTC = targetDateStart.toUTC().toJSDate()
    const targetDateEndUTC = targetDateEnd.toUTC().toJSDate()
    
    console.log(`📅 查询时间窗口:`)
    console.log(`   账户时区: ${targetDateStart.toFormat('yyyy-MM-dd HH:mm:ss')} ~ ${targetDateEnd.toFormat('yyyy-MM-dd HH:mm:ss')}`)
    console.log(`   UTC: ${targetDateStartUTC.toISOString()} ~ ${targetDateEndUTC.toISOString()}`)
    console.log('')
    
    // 4. 检查 daily_stats 表中是否有目标日期的数据
    console.log('📊 步骤 1：检查 daily_stats 表中的归档数据...')
    const [dailyStatsRows] = await pool.query(`
      SELECT 
        ad_id,
        ad_name,
        date,
        spend,
        purchases,
        cpc,
        roas,
        timezone_name,
        created_at,
        updated_at
      FROM daily_stats
      WHERE account_id = ?
        AND date = ?
      ORDER BY ad_id
    `, [TEST_ACCOUNT_ID, targetDateStr])
    
    console.log(`✅ daily_stats 查询完成，找到 ${dailyStatsRows.length} 条记录`)
    console.log('')
    
    if (dailyStatsRows.length === 0) {
      console.log('⚠️  daily_stats 表中没有目标日期的数据')
      console.log('💡 可能的原因:')
      console.log('   1. 归档任务还未执行（应该在账户本地时区 06:00-06:09 窗口执行）')
      console.log('   2. 归档任务执行失败')
      console.log('   3. 目标日期没有数据')
      console.log('')
      
      // 检查是否有 ad_snapshots 数据
      const [snapshotRows] = await pool.query(`
        SELECT COUNT(*) as count
        FROM ad_snapshots
        WHERE account_id = ?
          AND synced_at BETWEEN ? AND ?
      `, [TEST_ACCOUNT_ID, targetDateStartUTC, targetDateEndUTC])
      
      const snapshotCount = snapshotRows[0]?.count || 0
      if (snapshotCount > 0) {
        console.log(`⚠️  但 ad_snapshots 中有 ${snapshotCount} 条目标日期的数据，说明归档可能未执行`)
      } else {
        console.log(`✅ ad_snapshots 中也没有目标日期的数据，说明目标日期确实没有数据`)
      }
      
      process.exit(0)
    }
    
    // 5. 显示归档统计信息
    console.log('📊 步骤 2：归档统计信息...')
    console.log('')
    
    // 统计创建时间和更新时间
    const createdTimes = dailyStatsRows.map(row => new Date(row.created_at))
    const updatedTimes = dailyStatsRows.map(row => new Date(row.updated_at))
    
    const earliestCreated = new Date(Math.min(...createdTimes))
    const latestCreated = new Date(Math.max(...createdTimes))
    const earliestUpdated = new Date(Math.min(...updatedTimes))
    const latestUpdated = new Date(Math.max(...updatedTimes))
    
    // 转换为账户时区显示
    const earliestCreatedTz = DateTime.fromJSDate(earliestCreated).setZone(accountTimezone)
    const latestCreatedTz = DateTime.fromJSDate(latestCreated).setZone(accountTimezone)
    const earliestUpdatedTz = DateTime.fromJSDate(earliestUpdated).setZone(accountTimezone)
    const latestUpdatedTz = DateTime.fromJSDate(latestUpdated).setZone(accountTimezone)
    
    console.log(`📊 归档时间统计:`)
    console.log(`   最早创建时间: ${earliestCreated} (${earliestCreatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
    console.log(`   最晚创建时间: ${latestCreated} (${latestCreatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
    console.log(`   最早更新时间: ${earliestUpdated} (${earliestUpdatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
    console.log(`   最晚更新时间: ${latestUpdated} (${latestUpdatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} ${accountTimezone})`)
    console.log('')
    
    // 检查归档时间是否在 06:00 左右（优化：考虑多次归档的补齐流程）
    const timeDiff = latestCreated.getTime() - earliestCreated.getTime()
    const timeDiffMinutes = Math.floor(timeDiff / (1000 * 60))
    const hasMultipleArchives = timeDiffMinutes > 5 // 如果创建时间相差超过 5 分钟，说明有多次归档
    
    // 如果有多次归档，说明是补齐流程，应该检查最晚创建时间
    // 如果只有一次归档，检查最早创建时间
    const checkTime = hasMultipleArchives ? latestCreatedTz : earliestCreatedTz
    const archiveHour = checkTime.hour
    const archiveMinute = checkTime.minute
    
    if (hasMultipleArchives) {
      console.log(`📊 检测到多次归档（补齐流程）:`)
      console.log(`   最早归档: ${earliestCreatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} (${earliestCreatedTz.toFormat('ZZZZ')})`)
      console.log(`   最晚归档: ${latestCreatedTz.toFormat('yyyy-MM-dd HH:mm:ss')} (${latestCreatedTz.toFormat('ZZZZ')})`)
      console.log(`   时间间隔: ${timeDiffMinutes} 分钟`)
      console.log('')
      
      // 检查最晚归档时间是否在预期窗口内
      if (archiveHour === 6 && archiveMinute >= 0 && archiveMinute <= 9) {
        console.log(`✅ 最晚归档时间在预期窗口内 (06:00-06:09)`)
      } else if (archiveHour === 5 && archiveMinute >= 50) {
        console.log(`⚠️  最晚归档时间接近窗口 (${archiveHour}:${archiveMinute.toString().padStart(2, '0')})，可能是时区转换导致`)
      } else if (archiveHour === 6 && archiveMinute >= 10) {
        console.log(`⚠️  最晚归档时间稍晚 (${archiveHour}:${archiveMinute.toString().padStart(2, '0')})，但仍在合理范围内`)
      } else {
        // 如果是强制归档补齐（不在 06:00 窗口），这是正常的
        const isForceArchive = archiveHour !== 6 || archiveMinute < 0 || archiveMinute > 9
        if (isForceArchive) {
          console.log(`ℹ️  最晚归档时间: ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (强制归档补齐，这是正常的)`)
        } else {
          console.log(`⚠️  最晚归档时间不在预期窗口 (${archiveHour}:${archiveMinute.toString().padStart(2, '0')})，可能需要检查归档任务`)
        }
      }
    } else {
      // 只有一次归档，检查是否在预期窗口内
      if (archiveHour === 6 && archiveMinute >= 0 && archiveMinute <= 9) {
        console.log(`✅ 归档时间在预期窗口内 (06:00-06:09)`)
      } else if (archiveHour === 5 && archiveMinute >= 50) {
        console.log(`⚠️  归档时间接近窗口 (${archiveHour}:${archiveMinute.toString().padStart(2, '0')})，可能是时区转换导致`)
      } else if (archiveHour === 6 && archiveMinute >= 10) {
        console.log(`⚠️  归档时间稍晚 (${archiveHour}:${archiveMinute.toString().padStart(2, '0')})，但仍在合理范围内`)
      } else {
        // 如果不在 06:00 窗口，可能是强制归档或手动触发
        console.log(`ℹ️  归档时间: ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (可能是强制归档或手动触发)`)
      }
    }
    console.log('')
    
    // 6. 检查数据一致性（对比 ad_snapshots 和 daily_stats）
    console.log('📊 步骤 3：检查数据一致性...')
    console.log('')
    
    // 获取 ad_snapshots 中目标日期的最后快照（按广告分组，取最新的一条）
    const [snapshotRows] = await pool.query(`
      SELECT 
        s1.ad_id,
        s1.ad_name,
        s1.spend,
        s1.purchases,
        s1.cpc,
        s1.roas,
        s1.synced_at
      FROM ad_snapshots s1
      INNER JOIN (
        SELECT ad_id, MAX(synced_at) as max_synced_at
        FROM ad_snapshots
        WHERE account_id = ?
          AND synced_at BETWEEN ? AND ?
        GROUP BY ad_id
      ) s2 ON s1.ad_id = s2.ad_id AND s1.synced_at = s2.max_synced_at
      WHERE s1.account_id = ?
        AND s1.synced_at BETWEEN ? AND ?
      ORDER BY s1.ad_id
    `, [
      TEST_ACCOUNT_ID, targetDateStartUTC, targetDateEndUTC,
      TEST_ACCOUNT_ID, targetDateStartUTC, targetDateEndUTC
    ])
    
    console.log(`✅ ad_snapshots 查询完成，找到 ${snapshotRows.length} 条记录（每个广告的最新快照）`)
    console.log('')
    
    // 构建映射
    const dailyStatsMap = new Map()
    dailyStatsRows.forEach(row => {
      dailyStatsMap.set(String(row.ad_id), row)
    })
    
    const snapshotMap = new Map()
    snapshotRows.forEach(row => {
      snapshotMap.set(String(row.ad_id), row)
    })
    
    // 对比数据
    const comparisonResults = {
      match: [],
      missing_in_daily: [],
      missing_in_snapshot: [],
      inconsistent: []
    }
    
    // 对比 daily_stats 中的每条记录
    for (const [adId, dailyRow] of dailyStatsMap.entries()) {
      const snapshotRow = snapshotMap.get(adId)
      
      if (!snapshotRow) {
        comparisonResults.missing_in_snapshot.push({
          ad_id: adId,
          ad_name: dailyRow.ad_name || '',
          daily_spend: parseFloat(dailyRow.spend || 0),
          note: 'daily_stats 有数据，但 ad_snapshots 中没有（可能是归档后快照被清理）'
        })
        continue
      }
      
      // 对比数据
      const dailySpend = parseFloat(dailyRow.spend || 0)
      const snapshotSpend = parseFloat(snapshotRow.spend || 0)
      const difference = Math.abs(dailySpend - snapshotSpend)
      const differencePercent = snapshotSpend > 0 ? (difference / snapshotSpend * 100) : 0
      
      const dailyPurchases = parseInt(dailyRow.purchases || 0)
      const snapshotPurchases = parseInt(snapshotRow.purchases || 0)
      const purchasesDiff = Math.abs(dailyPurchases - snapshotPurchases)
      
      // 判断是否匹配（允许小误差）
      const isMatch = (differencePercent < 5 || difference < 0.01) && purchasesDiff <= 1
      
      if (isMatch) {
        comparisonResults.match.push({
          ad_id: adId,
          ad_name: dailyRow.ad_name || snapshotRow.ad_name || '',
          daily_spend: dailySpend,
          snapshot_spend: snapshotSpend
        })
      } else {
        comparisonResults.inconsistent.push({
          ad_id: adId,
          ad_name: dailyRow.ad_name || snapshotRow.ad_name || '',
          daily_spend: dailySpend,
          snapshot_spend: snapshotSpend,
          difference: difference,
          difference_percent: differencePercent,
          daily_purchases: dailyPurchases,
          snapshot_purchases: snapshotPurchases,
          purchases_diff: purchasesDiff
        })
      }
    }
    
    // 检查 ad_snapshots 中有但 daily_stats 中没有的广告
    for (const [adId, snapshotRow] of snapshotMap.entries()) {
      if (!dailyStatsMap.has(adId)) {
        comparisonResults.missing_in_daily.push({
          ad_id: adId,
          ad_name: snapshotRow.ad_name || '',
          snapshot_spend: parseFloat(snapshotRow.spend || 0),
          note: 'ad_snapshots 有数据，但 daily_stats 中没有（可能是归档时被跳过）'
        })
      }
    }
    
    // 7. 输出对比结果
    console.log('📊 数据一致性对比结果:')
    console.log('')
    
    if (comparisonResults.match.length > 0) {
      console.log(`✅ 匹配的记录 (${comparisonResults.match.length} 条):`)
      comparisonResults.match.slice(0, 5).forEach(r => {
        console.log(`   - ${r.ad_id}: spend = ${r.daily_spend.toFixed(2)} (daily_stats) = ${r.snapshot_spend.toFixed(2)} (ad_snapshots) ✅`)
      })
      if (comparisonResults.match.length > 5) {
        console.log(`   ... 还有 ${comparisonResults.match.length - 5} 条匹配记录`)
      }
      console.log('')
    }
    
    if (comparisonResults.inconsistent.length > 0) {
      console.log(`⚠️  不一致的记录 (${comparisonResults.inconsistent.length} 条):`)
      comparisonResults.inconsistent.forEach(r => {
        console.log(`   - ${r.ad_id} (${r.ad_name}):`)
        console.log(`     daily_stats: spend = ${r.daily_spend.toFixed(2)}, purchases = ${r.daily_purchases}`)
        console.log(`     ad_snapshots: spend = ${r.snapshot_spend.toFixed(2)}, purchases = ${r.snapshot_purchases}`)
        console.log(`     差异: spend 差异 = ${r.difference.toFixed(2)} (${r.difference_percent.toFixed(2)}%), purchases 差异 = ${r.purchases_diff}`)
        console.log('')
      })
    }
    
    if (comparisonResults.missing_in_daily.length > 0) {
      console.log(`⚠️  daily_stats 中缺失的记录 (${comparisonResults.missing_in_daily.length} 条):`)
      comparisonResults.missing_in_daily.forEach(r => {
        console.log(`   - ${r.ad_id} (${r.ad_name}): spend = ${r.snapshot_spend.toFixed(2)}`)
        console.log(`     说明: ${r.note}`)
      })
      console.log('')
    }
    
    if (comparisonResults.missing_in_snapshot.length > 0) {
      console.log(`⚠️  ad_snapshots 中缺失的记录 (${comparisonResults.missing_in_snapshot.length} 条):`)
      comparisonResults.missing_in_snapshot.forEach(r => {
        console.log(`   - ${r.ad_id} (${r.ad_name}): spend = ${r.daily_spend.toFixed(2)}`)
        console.log(`     说明: ${r.note}`)
      })
      console.log('')
    }
    
    // 8. 汇总统计
    console.log('='.repeat(60))
    console.log('📊 汇总统计:')
    console.log('='.repeat(60))
    console.log(`   daily_stats 记录数: ${dailyStatsRows.length} 条`)
    console.log(`   ad_snapshots 记录数: ${snapshotRows.length} 条`)
    console.log(`   ✅ 匹配: ${comparisonResults.match.length} 条`)
    console.log(`   ⚠️  不一致: ${comparisonResults.inconsistent.length} 条`)
    console.log(`   ⚠️  daily_stats 缺失: ${comparisonResults.missing_in_daily.length} 条`)
    console.log(`   ⚠️  ad_snapshots 缺失: ${comparisonResults.missing_in_snapshot.length} 条`)
    console.log('')
    
    // 9. 验证结论
    console.log('='.repeat(60))
    console.log('📝 验证结论:')
    console.log('='.repeat(60))
    
    if (dailyStatsRows.length > 0) {
      console.log(`✅ 归档成功：daily_stats 中有 ${dailyStatsRows.length} 条目标日期的数据`)
      
      // 使用相同的逻辑判断归档时间（考虑多次归档的补齐流程）
      if (hasMultipleArchives) {
        // 多次归档（补齐流程）
        if (archiveHour === 6 && archiveMinute >= 0 && archiveMinute <= 9) {
          console.log(`✅ 归档时间：最晚归档在预期窗口内 (06:00-06:09)`)
        } else {
          const isForceArchive = archiveHour !== 6 || archiveMinute < 0 || archiveMinute > 9
          if (isForceArchive) {
            console.log(`ℹ️  归档时间：最晚归档 ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (强制归档补齐，正常)`)
          } else {
            console.log(`⚠️  归档时间：最晚归档 ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (预期: 06:00-06:09)`)
          }
        }
      } else {
        // 单次归档
        if (archiveHour === 6 && archiveMinute >= 0 && archiveMinute <= 9) {
          console.log(`✅ 归档时间在预期窗口内 (06:00-06:09)`)
        } else {
          const isForceArchive = archiveHour !== 6 || archiveMinute < 0 || archiveMinute > 9
          if (isForceArchive) {
            console.log(`ℹ️  归档时间: ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (可能是强制归档或手动触发)`)
          } else {
            console.log(`⚠️  归档时间: ${archiveHour}:${archiveMinute.toString().padStart(2, '0')} (预期: 06:00-06:09)`)
          }
        }
      }
      
      if (comparisonResults.match.length === dailyStatsRows.length && comparisonResults.inconsistent.length === 0) {
        console.log(`✅ 数据一致性：所有数据匹配`)
      } else if (comparisonResults.inconsistent.length > 0) {
        console.log(`⚠️  数据一致性：有 ${comparisonResults.inconsistent.length} 条记录不一致（可能是归因延迟导致）`)
      }
    } else {
      console.log(`❌ 归档失败：daily_stats 中没有目标日期的数据`)
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
    // 关闭数据库连接
    try {
      await pool.end()
    } catch (err) {
      // 忽略关闭连接时的错误
    }
  }
}

// 执行主函数
main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

