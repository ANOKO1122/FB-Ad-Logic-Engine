// 验证脚本：检查数据库热数据表和冷数据表的数据是否与 Facebook API 一致
// 使用方法：node server/scripts/verify-data-consistency.js
//
// 【验证逻辑】
// 1. 热数据（Today）：对比 ad_snapshots 和 Facebook API 的 today 数据，允许15分钟误差
// 2. 冷数据（Yesterday）：对比 daily_stats 和 Facebook API 的指定日期数据，必须完全一致

import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'
import { DateTime } from 'luxon'
import pLimit from 'p-limit'

// 受控并发配置
const CONCURRENT_LIMIT = 8
const verifyLimiter = pLimit(CONCURRENT_LIMIT)

// 允许的时间误差（分钟）
const HOT_DATA_TOLERANCE_MINUTES = 15

console.log('')
console.log('='.repeat(60))
console.log('🔍 验证数据库与 Facebook API 数据一致性')
console.log('='.repeat(60))
console.log('')

try {
  // 1. 获取所有活跃账户
  const [accounts] = await pool.query(`
    SELECT DISTINCT 
      fb_account_id as account_id, 
      owner_id, 
      COALESCE(timezone_name, 'UTC') as timezone_name
    FROM account_mappings 
    WHERE is_active = 1
    ORDER BY fb_account_id
  `)
  
  if (!accounts || accounts.length === 0) {
    console.log('⚠️  没有找到活跃账户，跳过验证')
    process.exit(0)
  }
  
  console.log(`📋 找到 ${accounts.length} 个活跃账户`)
  console.log(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
  console.log('')
  
  // 2. 创建 Facebook API 客户端实例
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
  }
  const facebookApi = new FacebookMarketingAPI(accessToken)
  
  // 3. 计算目标日期
  const today = DateTime.now().setZone('UTC')
  const yesterday = today.minus({ days: 1 })
  const todayStr = today.toFormat('yyyy-MM-dd')
  const yesterdayStr = yesterday.toFormat('yyyy-MM-dd')
  
  console.log(`📅 验证日期:`)
  console.log(`   - 热数据（Today）: ${todayStr}`)
  console.log(`   - 冷数据（Yesterday）: ${yesterdayStr}`)
  console.log(`   - 热数据允许误差: ±${HOT_DATA_TOLERANCE_MINUTES} 分钟`)
  console.log(`   - 冷数据要求: 完全一致`)
  console.log('')
  
  // 4. 验证每个账户
  const verifyTasks = accounts.map(account => 
    verifyLimiter(async () => {
      const { account_id: accountId, timezone_name: timezoneName } = account
      
      try {
        console.log(`\n[账户 ${accountId}] 时区: ${timezoneName}`)
        
        // 4.1 验证热数据（Today）
        console.log(`   🔥 验证热数据（Today）...`)
        const hotDataResult = await verifyHotData(accountId, timezoneName, todayStr, facebookApi)
        
        // 4.2 验证冷数据（Yesterday）
        console.log(`   ❄️  验证冷数据（Yesterday）...`)
        const coldDataResult = await verifyColdData(accountId, timezoneName, yesterdayStr, facebookApi)
        
        return {
          accountId,
          success: true,
          hotData: hotDataResult,
          coldData: coldDataResult
        }
      } catch (error) {
        console.error(`   ❌ 验证账户 ${accountId} 失败: ${error.message}`)
        return { 
          accountId, 
          success: false, 
          error: error.message 
        }
      }
    })
  )
  
  // 5. 等待所有任务完成
  const results = await Promise.all(verifyTasks)
  
  // 6. 统计结果
  const successResults = results.filter(r => r.success)
  const failedResults = results.filter(r => !r.success)
  
  const hotDataPassed = successResults.filter(r => r.hotData?.isConsistent !== false).length
  const hotDataFailed = successResults.filter(r => r.hotData?.isConsistent === false).length
  const coldDataPassed = successResults.filter(r => r.coldData?.isConsistent !== false).length
  const coldDataFailed = successResults.filter(r => r.coldData?.isConsistent === false).length
  
  console.log('')
  console.log('='.repeat(60))
  console.log(`✅ 验证完成`)
  console.log('='.repeat(60))
  console.log(`📊 总体统计:`)
  console.log(`   - 验证账户数: ${accounts.length}`)
  console.log(`   - 成功验证: ${successResults.length} 个`)
  console.log(`   - 验证失败: ${failedResults.length} 个`)
  console.log('')
  console.log(`🔥 热数据（Today）验证:`)
  console.log(`   - 通过: ${hotDataPassed} 个账户`)
  console.log(`   - 失败: ${hotDataFailed} 个账户`)
  console.log('')
  console.log(`❄️  冷数据（Yesterday）验证:`)
  console.log(`   - 通过: ${coldDataPassed} 个账户`)
  console.log(`   - 失败: ${coldDataFailed} 个账户`)
  console.log('')
  
  // 7. 详细报告 - 热数据误差
  console.log('🔥 热数据（Today）详细误差报告:')
  successResults
    .sort((a, b) => {
      const aDiff = a.hotData?.adCountDiffPercentage || 0
      const bDiff = b.hotData?.adCountDiffPercentage || 0
      return bDiff - aDiff
    })
    .forEach(r => {
      const hotData = r.hotData
      if (hotData) {
        const status = hotData.isConsistent ? '✅' : '⚠️'
        console.log(`   ${status} ${r.accountId}:`)
        console.log(`     广告数量: API=${hotData.apiAdCount}, DB=${hotData.dbAdCount}, 差异=${hotData.diffCount} (${hotData.adCountDiffPercentage.toFixed(2)}%)`)
        console.log(`     Spend总额: API=$${hotData.totalApiSpend.toFixed(2)}, DB=$${hotData.totalDbSpend.toFixed(2)}, 差异=$${hotData.totalSpendDiff.toFixed(2)} (${hotData.spendDiffPercentage.toFixed(2)}%)`)
        if (hotData.topSpendDiffs && hotData.topSpendDiffs.length > 0) {
          console.log(`     误差最大的广告（前3个）:`)
          hotData.topSpendDiffs.slice(0, 3).forEach(diff => {
            console.log(`       - ${diff.adId}: API=$${diff.apiSpend.toFixed(2)}, DB=$${diff.dbSpend.toFixed(2)}, 差异=$${diff.diff.toFixed(2)}`)
          })
        }
      }
    })
  console.log('')
  
  // 8. 详细报告 - 冷数据误差
  console.log('❄️  冷数据（Yesterday）详细误差报告:')
  successResults
    .filter(r => r.coldData?.isConsistent === false)
    .sort((a, b) => {
      const aDiff = a.coldData?.adCountDiffPercentage || 0
      const bDiff = b.coldData?.adCountDiffPercentage || 0
      return bDiff - aDiff
    })
    .forEach(r => {
      const coldData = r.coldData
      if (coldData) {
        console.log(`   ❌ ${r.accountId}:`)
        console.log(`     广告数量: API=${coldData.apiAdCount}, DB=${coldData.dbAdCount}, 差异=${coldData.diffCount} (${coldData.adCountDiffPercentage.toFixed(2)}%)`)
        console.log(`     Spend总额: API=$${coldData.totalApiSpend.toFixed(2)}, DB=$${coldData.totalDbSpend.toFixed(2)}, 差异=$${coldData.totalSpendDiff.toFixed(2)} (${coldData.spendDiffPercentage.toFixed(2)}%)`)
        if (coldData.missingInDb && coldData.missingInDb.length > 0) {
          console.log(`     缺失广告ID（前5个）: ${coldData.missingInDb.slice(0, 5).join(', ')}${coldData.missingInDb.length > 5 ? '...' : ''}`)
        }
        if (coldData.topSpendDiffs && coldData.topSpendDiffs.length > 0) {
          console.log(`     误差最大的广告（前5个）:`)
          coldData.topSpendDiffs.slice(0, 5).forEach(diff => {
            console.log(`       - ${diff.adId}: API=$${diff.apiSpend.toFixed(2)}, DB=$${diff.dbSpend.toFixed(2)}, 差异=$${diff.diff.toFixed(2)}`)
          })
        }
      }
    })
  console.log('')
  
  // 9. 热数据不一致的账户（简化版）
  if (hotDataFailed > 0) {
    console.log('⚠️  热数据不一致的账户（简化）:')
    successResults
      .filter(r => r.hotData?.isConsistent === false)
      .forEach(r => {
        console.log(`   - ${r.accountId}: 差异 ${r.hotData?.diffCount || 0} 个广告 (${r.hotData?.adCountDiffPercentage.toFixed(2)}%), Spend差异 $${r.hotData?.totalSpendDiff.toFixed(2)} (${r.hotData?.spendDiffPercentage.toFixed(2)}%)`)
      })
    console.log('')
  }
  
  if (failedResults.length > 0) {
    console.log('❌ 验证失败的账户:')
    failedResults.forEach(r => {
      console.log(`   - ${r.accountId}: ${r.error || '未知错误'}`)
    })
    console.log('')
  }
  
  // 8. 结论
  if (hotDataFailed === 0 && coldDataFailed === 0 && successResults.length > 0) {
    console.log('✅ 结论: 所有数据都与 Facebook API 一致！')
  } else if (coldDataFailed > 0) {
    console.log(`❌ 结论: 发现 ${coldDataFailed} 个账户的冷数据不一致，需要检查归档逻辑`)
  } else if (hotDataFailed > 0) {
    console.log(`⚠️  结论: 发现 ${hotDataFailed} 个账户的热数据不一致（可能是在15分钟误差范围内）`)
  } else {
    console.log('ℹ️  结论: 无法确定一致性（验证失败或没有数据）')
  }
  
  console.log('='.repeat(60))
  console.log('')
  
  process.exit(0)
} catch (error) {
  console.error('')
  console.error('='.repeat(60))
  console.error('❌ 执行失败:', error.message)
  console.error('错误堆栈:', error.stack)
  console.error('='.repeat(60))
  process.exit(1)
}

/**
 * 验证热数据（Today）
 * 允许15分钟误差
 */
async function verifyHotData(accountId, timezoneName, dateStr, facebookApi) {
  try {
    // 1. 从 Facebook API 查询 Today 数据
    console.log(`      📡 从 Facebook API 查询 Today 数据...`)
    // getAdInsights 的第二个参数是 timeRange，可以是字符串（preset）或对象
    const apiInsights = await facebookApi.getAdInsights(accountId, { preset: 'today' }, {
      level: 'ad'
    })
    
    // 过滤 spend > 0 的广告
    const apiAds = apiInsights.filter(insight => parseFloat(insight.spend || 0) > 0)
    const apiAdIds = new Set(apiAds.map(insight => String(insight.ad_id || '')).filter(id => id))
    const apiSpendMap = new Map()
    apiAds.forEach(insight => {
      const adId = String(insight.ad_id || '')
      const spend = parseFloat(insight.spend || 0)
      apiSpendMap.set(adId, spend)
    })
    
    console.log(`      ✅ API 返回: ${apiAdIds.size} 个 spend>0 的广告`)
    
    // 2. 从数据库查询 Today 数据（使用 data_date）
    console.log(`      💾 从数据库查询 Today 数据（data_date = ${dateStr}）...`)
    const [dbRows] = await pool.query(`
      SELECT DISTINCT ad_id, spend
      FROM ad_snapshots
      WHERE account_id = ? 
        AND data_date = ?
        AND spend > 0
    `, [accountId, dateStr])
    
    const dbAdIds = new Set(dbRows.map(row => String(row.ad_id || '')).filter(id => id))
    const dbSpendMap = new Map()
    dbRows.forEach(row => {
      const adId = String(row.ad_id || '')
      const spend = parseFloat(row.spend || 0)
      dbSpendMap.set(adId, spend)
    })
    
    console.log(`      ✅ 数据库返回: ${dbAdIds.size} 个 spend>0 的广告`)
    
    // 3. 对比数据
    const missingInDb = Array.from(apiAdIds).filter(adId => !dbAdIds.has(adId))
    const extraInDb = Array.from(dbAdIds).filter(adId => !apiAdIds.has(adId))
    const diffCount = missingInDb.length + extraInDb.length
    
    // 4. 检查 spend 差异（允许15分钟误差）
    const spendDiffs = []
    for (const adId of apiAdIds) {
      if (dbAdIds.has(adId)) {
        const apiSpend = apiSpendMap.get(adId) || 0
        const dbSpend = dbSpendMap.get(adId) || 0
        const diff = Math.abs(apiSpend - dbSpend)
        if (diff > 0.01) { // 允许 $0.01 的误差
          spendDiffs.push({ adId, apiSpend, dbSpend, diff })
        }
      }
    }
    
    // 5. 计算总 Spend 差异
    let totalApiSpend = 0
    let totalDbSpend = 0
    apiSpendMap.forEach(spend => totalApiSpend += spend)
    dbSpendMap.forEach(spend => totalDbSpend += spend)
    const totalSpendDiff = Math.abs(totalApiSpend - totalDbSpend)
    const spendDiffPercentage = totalApiSpend > 0 ? (totalSpendDiff / totalApiSpend * 100).toFixed(2) : '0.00'
    
    // 6. 计算广告数量差异百分比
    const adCountDiffPercentage = apiAdIds.size > 0 ? (diffCount / apiAdIds.size * 100).toFixed(2) : '0.00'
    
    // 7. 判断是否一致（热数据允许15分钟误差，允许1%的差异）
    const isConsistent = diffCount === 0 && spendDiffs.length === 0
    const isWithinTolerance = parseFloat(adCountDiffPercentage) <= 1.0 && totalSpendDiff <= (totalApiSpend * 0.01) // 允许1%的误差
    
    if (!isConsistent) {
      console.log(`      ⚠️  数据不一致:`)
      console.log(`         广告数量差异: ${diffCount} 个 (${adCountDiffPercentage}%)`)
      console.log(`         Spend 总差异: $${totalSpendDiff.toFixed(2)} (${spendDiffPercentage}%)`)
      if (missingInDb.length > 0) {
        console.log(`         缺失广告: ${missingInDb.length} 个`)
      }
      if (extraInDb.length > 0) {
        console.log(`         多余广告: ${extraInDb.length} 个`)
      }
      if (spendDiffs.length > 0) {
        console.log(`         Spend 差异广告: ${spendDiffs.length} 个`)
      }
      if (isWithinTolerance) {
        console.log(`         ✅ 差异在允许范围内（≤1%）`)
      }
    } else {
      console.log(`      ✅ 数据完全一致`)
    }
    
    // 8. 找出误差最大的广告（按 Spend 差异排序）
    const topSpendDiffs = spendDiffs
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 5)
    
    return {
      isConsistent: isConsistent || isWithinTolerance, // 如果在允许范围内，认为一致
      apiAdCount: apiAdIds.size,
      dbAdCount: dbAdIds.size,
      diffCount,
      adCountDiffPercentage: parseFloat(adCountDiffPercentage),
      totalApiSpend,
      totalDbSpend,
      totalSpendDiff,
      spendDiffPercentage: parseFloat(spendDiffPercentage),
      missingInDb: missingInDb.slice(0, 10),
      extraInDb: extraInDb.slice(0, 10),
      spendDiffs: spendDiffs.slice(0, 10),
      topSpendDiffs, // 误差最大的广告
      diffDetails: diffCount > 0 ? `缺失:${missingInDb.length}, 多余:${extraInDb.length}, Spend差异:${spendDiffs.length}` : null
    }
  } catch (error) {
    console.error(`      ❌ 验证热数据失败: ${error.message}`)
    return { isConsistent: false, error: error.message }
  }
}

/**
 * 验证冷数据（Yesterday）
 * 必须完全一致
 */
async function verifyColdData(accountId, timezoneName, dateStr, facebookApi) {
  try {
    // 1. 从 Facebook API 查询指定日期的数据
    console.log(`      📡 从 Facebook API 查询 ${dateStr} 的数据...`)
    // getAdInsights 的第二个参数是 timeRange，使用 since/until 指定日期范围
    const apiInsights = await facebookApi.getAdInsights(accountId, {
      since: dateStr,
      until: dateStr
    }, {
      level: 'ad'
    })
    
    // 过滤 spend > 0 的广告
    const apiAds = apiInsights.filter(insight => parseFloat(insight.spend || 0) > 0)
    const apiAdIds = new Set(apiAds.map(insight => String(insight.ad_id || '')).filter(id => id))
    const apiSpendMap = new Map()
    apiAds.forEach(insight => {
      const adId = String(insight.ad_id || '')
      const spend = parseFloat(insight.spend || 0)
      apiSpendMap.set(adId, spend)
    })
    
    console.log(`      ✅ API 返回: ${apiAdIds.size} 个 spend>0 的广告`)
    
    // 2. 从数据库查询冷数据（daily_stats）
    console.log(`      💾 从数据库查询冷数据（daily_stats.date = ${dateStr}）...`)
    const [dbRows] = await pool.query(`
      SELECT DISTINCT ad_id, spend
      FROM daily_stats
      WHERE account_id = ? 
        AND date = ?
        AND spend > 0
    `, [accountId, dateStr])
    
    const dbAdIds = new Set(dbRows.map(row => String(row.ad_id || '')).filter(id => id))
    const dbSpendMap = new Map()
    dbRows.forEach(row => {
      const adId = String(row.ad_id || '')
      const spend = parseFloat(row.spend || 0)
      dbSpendMap.set(adId, spend)
    })
    
    console.log(`      ✅ 数据库返回: ${dbAdIds.size} 个 spend>0 的广告`)
    
    // 3. 对比数据（必须完全一致）
    const missingInDb = Array.from(apiAdIds).filter(adId => !dbAdIds.has(adId))
    const extraInDb = Array.from(dbAdIds).filter(adId => !apiAdIds.has(adId))
    const diffCount = missingInDb.length + extraInDb.length
    
    // 4. 检查 spend 差异（必须完全一致）
    const spendDiffs = []
    for (const adId of apiAdIds) {
      if (dbAdIds.has(adId)) {
        const apiSpend = apiSpendMap.get(adId) || 0
        const dbSpend = dbSpendMap.get(adId) || 0
        const diff = Math.abs(apiSpend - dbSpend)
        if (diff > 0.01) { // 允许 $0.01 的误差（浮点数精度）
          spendDiffs.push({ adId, apiSpend, dbSpend, diff })
        }
      }
    }
    
    // 5. 计算总 Spend 差异
    let totalApiSpend = 0
    let totalDbSpend = 0
    apiSpendMap.forEach(spend => totalApiSpend += spend)
    dbSpendMap.forEach(spend => totalDbSpend += spend)
    const totalSpendDiff = Math.abs(totalApiSpend - totalDbSpend)
    const spendDiffPercentage = totalApiSpend > 0 ? (totalSpendDiff / totalApiSpend * 100).toFixed(2) : '0.00'
    
    // 6. 计算广告数量差异百分比
    const adCountDiffPercentage = apiAdIds.size > 0 ? (diffCount / apiAdIds.size * 100).toFixed(2) : '0.00'
    
    // 7. 判断是否一致（必须完全一致）
    const isConsistent = diffCount === 0 && spendDiffs.length === 0
    
    if (!isConsistent) {
      console.log(`      ❌ 数据不一致（冷数据必须完全一致）:`)
      console.log(`         广告数量差异: ${diffCount} 个 (${adCountDiffPercentage}%)`)
      console.log(`         Spend 总差异: $${totalSpendDiff.toFixed(2)} (${spendDiffPercentage}%)`)
      if (missingInDb.length > 0) {
        console.log(`         缺失广告: ${missingInDb.length} 个`)
        console.log(`         缺失广告ID: ${missingInDb.slice(0, 5).join(', ')}${missingInDb.length > 5 ? '...' : ''}`)
      }
      if (extraInDb.length > 0) {
        console.log(`         多余广告: ${extraInDb.length} 个`)
        console.log(`         多余广告ID: ${extraInDb.slice(0, 5).join(', ')}${extraInDb.length > 5 ? '...' : ''}`)
      }
      if (spendDiffs.length > 0) {
        console.log(`         Spend 差异: ${spendDiffs.length} 个广告`)
        spendDiffs.slice(0, 3).forEach(diff => {
          console.log(`           - ${diff.adId}: API=${diff.apiSpend.toFixed(2)}, DB=${diff.dbSpend.toFixed(2)}, 差异=${diff.diff.toFixed(2)}`)
        })
      }
    } else {
      console.log(`      ✅ 数据完全一致`)
    }
    
    // 8. 找出误差最大的广告（按 Spend 差异排序）
    const topSpendDiffs = spendDiffs
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 5)
    
    return {
      isConsistent,
      apiAdCount: apiAdIds.size,
      dbAdCount: dbAdIds.size,
      diffCount,
      adCountDiffPercentage: parseFloat(adCountDiffPercentage),
      totalApiSpend,
      totalDbSpend,
      totalSpendDiff,
      spendDiffPercentage: parseFloat(spendDiffPercentage),
      missingInDb: missingInDb.slice(0, 20),
      extraInDb: extraInDb.slice(0, 20),
      spendDiffs: spendDiffs.slice(0, 20),
      topSpendDiffs, // 误差最大的广告
      diffDetails: diffCount > 0 ? `缺失:${missingInDb.length}, 多余:${extraInDb.length}, Spend差异:${spendDiffs.length}` : null
    }
  } catch (error) {
    console.error(`      ❌ 验证冷数据失败: ${error.message}`)
    return { isConsistent: false, error: error.message }
  }
}

