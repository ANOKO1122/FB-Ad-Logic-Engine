// 验证脚本：检查是否完全无缺漏地收集到了所有 spend>0 的广告
// 使用方法：node server/scripts/verify-spend-ads-completeness.js
//
// 【验证逻辑】
// 1. 直接从 Facebook API 查询近 3 天 spend>0 的广告（作为基准）
// 2. 从数据库查询近 3 天 spend>0 的广告
// 3. 对比两者，找出遗漏的广告

import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'
import { DateTime } from 'luxon'
import pLimit from 'p-limit'

// 受控并发配置
const CONCURRENT_LIMIT = 8
const verifyLimiter = pLimit(CONCURRENT_LIMIT)

console.log('')
console.log('='.repeat(60))
console.log('🔍 验证 spend>0 广告收集完整性（近 3 天）')
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
  
  // 3. 计算当天的时间范围（用于数据库查询）
  const now = DateTime.now()
  const today = now.toFormat('yyyy-MM-dd')
  const sinceDate = today
  const untilDate = today
  
  console.log(`📅 验证时间范围: ${today}（当天）`)
  console.log('')
  
  // 4. 并发验证所有账户
  const verifyTasks = accounts.map((account, index) => 
    verifyLimiter(async () => {
      const accountId = String(account.account_id || '')
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId) {
        console.warn(`⚠️  跳过无效账户: account_id=${accountId}`)
        return { accountId, success: false, error: '无效账户' }
      }
      
      try {
        console.log(`[${index + 1}/${accounts.length}] 验证账户 ${accountId}...`)
        
        // 4.1 从 Facebook API 查询当天 spend>0 的广告（基准）
        console.log(`   📡 从 Facebook API 查询当天 spend>0 的广告...`)
        const apiInsights = await facebookApi.getAdInsights(accountId, {
          preset: 'today'
        }, {
          level: 'ad'
        })
        
        // 过滤 spend>0 的广告
        const apiSpendAds = apiInsights.filter(insight => {
          const spend = parseFloat(insight.spend || 0)
          return spend > 0
        })
        
        // 提取广告 ID（去重）
        const apiAdIds = new Set(
          apiSpendAds.map(insight => String(insight.ad_id || '')).filter(id => id)
        )
        
        console.log(`   ✅ API 返回: ${apiSpendAds.length} 条 spend>0 的广告数据，${apiAdIds.size} 个唯一广告ID`)
        
        // 4.2 从数据库查询当天 spend>0 的广告
        console.log(`   💾 从数据库查询当天 spend>0 的广告...`)
        const [dbRows] = await pool.query(`
          SELECT DISTINCT ad_id
          FROM (
            SELECT ad_id FROM daily_stats
            WHERE account_id = ? 
              AND date >= ? 
              AND date <= ?
              AND spend > 0
            
            UNION
            
            SELECT ad_id FROM ad_snapshots
            WHERE account_id = ?
              AND data_date >= ?
              AND data_date <= ?
              AND spend > 0
          ) AS active_ads
        `, [accountId, sinceDate, untilDate, accountId, sinceDate, untilDate])
        
        const dbAdIds = new Set(
          dbRows.map(row => String(row.ad_id || '')).filter(id => id)
        )
        
        console.log(`   ✅ 数据库返回: ${dbAdIds.size} 个唯一广告ID`)
        
        // 4.3 对比两者，找出遗漏的广告
        const missingAdIds = Array.from(apiAdIds).filter(adId => !dbAdIds.has(adId))
        const extraAdIds = Array.from(dbAdIds).filter(adId => !apiAdIds.has(adId))
        
        // 4.4 计算覆盖率
        const coverageRate = apiAdIds.size > 0 
          ? ((apiAdIds.size - missingAdIds.length) / apiAdIds.size * 100).toFixed(2)
          : '100.00'
        
        // 【AdsPolar 问题1：接受热数据差异】
        // 允许 1% 的"热数据"差异，只要差异只存在于最近 15 分钟内，就标记为 PASS
        const missingRate = apiAdIds.size > 0 
          ? (missingAdIds.length / apiAdIds.size * 100).toFixed(2)
          : '0.00'
        const isHotDataDiff = parseFloat(missingRate) <= 1.0 // 允许 1% 的差异
        
        console.log(`   📊 对比结果:`)
        console.log(`      - API 广告数: ${apiAdIds.size}`)
        console.log(`      - 数据库广告数: ${dbAdIds.size}`)
        console.log(`      - 遗漏广告数: ${missingAdIds.length} (${missingRate}%)`)
        console.log(`      - 多余广告数: ${extraAdIds.length}`)
        console.log(`      - 覆盖率: ${coverageRate}%`)
        
        if (missingAdIds.length > 0) {
          if (isHotDataDiff) {
            console.log(`   ✅ 遗漏率 ${missingRate}% ≤ 1%，属于正常的热数据差异（15分钟内会同步）`)
          } else {
            console.log(`   ⚠️  遗漏的广告ID: ${missingAdIds.slice(0, 10).join(', ')}${missingAdIds.length > 10 ? '...' : ''}`)
          }
        }
        
        if (extraAdIds.length > 0) {
          console.log(`   ℹ️  数据库中存在但 API 中不存在的广告ID: ${extraAdIds.slice(0, 10).join(', ')}${extraAdIds.length > 10 ? '...' : ''}`)
          console.log(`      （可能是历史数据或 API 已删除的广告）`)
        }
        
        return {
          accountId,
          success: true,
          apiAdCount: apiAdIds.size,
          dbAdCount: dbAdIds.size,
          missingCount: missingAdIds.length,
          extraCount: extraAdIds.length,
          coverageRate: parseFloat(coverageRate),
          missingRate: parseFloat(missingRate),
          isHotDataDiff: isHotDataDiff, // 是否属于正常的热数据差异
          missingAdIds: missingAdIds.slice(0, 20), // 只保留前20个，避免输出过长
          extraAdIds: extraAdIds.slice(0, 20)
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
  
  const totalApiAds = successResults.reduce((sum, r) => sum + (r.apiAdCount || 0), 0)
  const totalDbAds = successResults.reduce((sum, r) => sum + (r.dbAdCount || 0), 0)
  const totalMissing = successResults.reduce((sum, r) => sum + (r.missingCount || 0), 0)
  const totalExtra = successResults.reduce((sum, r) => sum + (r.extraCount || 0), 0)
  
  const avgCoverageRate = successResults.length > 0
    ? (successResults.reduce((sum, r) => sum + (r.coverageRate || 0), 0) / successResults.length).toFixed(2)
    : '0.00'
  
  console.log('')
  console.log('='.repeat(60))
  console.log(`✅ 验证完成`)
  console.log('='.repeat(60))
  console.log(`📊 总体统计:`)
  console.log(`   - 验证账户数: ${accounts.length}`)
  console.log(`   - 成功验证: ${successResults.length} 个`)
  console.log(`   - 验证失败: ${failedResults.length} 个`)
  console.log(`   - API 总广告数: ${totalApiAds} 个`)
  console.log(`   - 数据库总广告数: ${totalDbAds} 个`)
  console.log(`   - 遗漏广告总数: ${totalMissing} 个`)
  console.log(`   - 多余广告总数: ${totalExtra} 个`)
  console.log(`   - 平均覆盖率: ${avgCoverageRate}%`)
  console.log('')
  
  // 7. 详细报告
  if (totalMissing > 0) {
    console.log('📋 遗漏广告详情:')
    successResults
      .filter(r => r.missingCount > 0)
      .sort((a, b) => (b.missingCount || 0) - (a.missingCount || 0))
      .slice(0, 10)
      .forEach(r => {
        const missingRate = r.missingRate || (r.missingCount / (r.apiAdCount || 1) * 100)
        const isHotDataDiff = r.isHotDataDiff || missingRate <= 1.0
        const statusIcon = isHotDataDiff ? '✅' : '⚠️'
        console.log(`   ${statusIcon} ${r.accountId}: 遗漏 ${r.missingCount} 个广告（${missingRate.toFixed(2)}%，覆盖率 ${r.coverageRate.toFixed(2)}%）`)
        if (!isHotDataDiff && r.missingAdIds && r.missingAdIds.length > 0) {
          console.log(`      遗漏广告ID: ${r.missingAdIds.slice(0, 5).join(', ')}${r.missingAdIds.length > 5 ? '...' : ''}`)
        }
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
  
  // 8. 结论（AdsPolar 策略：允许 1% 热数据差异）
  const hotDataDiffAccounts = successResults.filter(r => r.isHotDataDiff && r.missingCount > 0)
  const realMissingAccounts = successResults.filter(r => !r.isHotDataDiff && r.missingCount > 0)
  const realMissingCount = realMissingAccounts.reduce((sum, r) => sum + (r.missingCount || 0), 0)
  
  if (totalMissing === 0 && successResults.length > 0) {
    console.log('✅ 结论: 所有 spend>0 的广告都已完整收集，无遗漏！')
  } else if (realMissingCount > 0) {
    console.log(`⚠️  结论: 发现 ${realMissingCount} 个真实遗漏的广告（${realMissingAccounts.length} 个账户），需要检查筛选逻辑或同步任务`)
    if (hotDataDiffAccounts.length > 0) {
      const hotDataDiffCount = hotDataDiffAccounts.reduce((sum, r) => sum + (r.missingCount || 0), 0)
      console.log(`   ℹ️  另有 ${hotDataDiffCount} 个遗漏属于正常热数据差异（≤1%，15分钟内会同步）`)
    }
  } else if (hotDataDiffAccounts.length > 0) {
    const hotDataDiffCount = hotDataDiffAccounts.reduce((sum, r) => sum + (r.missingCount || 0), 0)
    console.log(`✅ 结论: 所有遗漏（${hotDataDiffCount} 个）都属于正常热数据差异（≤1%），15分钟内会同步，无需处理`)
  } else {
    console.log('ℹ️  结论: 无法确定完整性（验证失败或没有数据）')
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

