// Data Ingestor 服务 - 数据同步服务
// 按照 DEV_PLAN.md M2 的要求实现
// 负责从 Facebook API 拉取广告数据并存入数据库

import { FacebookMarketingAPI } from '../index.js'
import { db } from '../db/drizzle.js'
import { adSnapshots } from '../db/schema.js'
import pool from '../db/connection.js'
import { eq, and, gte } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { 
  parseUsageHeader, 
  sleepBasedOnUsage,
  getCircuitBreakerStatus
} from './rateLimitService.js'

// ============================================
// 核心功能：数据同步
// ============================================

/**
 * 同步单个账户的今日广告数据（两步拉取：流派2）
 * @param {string} accountId - Facebook 账户ID（字符串格式）
 * @param {number} ownerId - 负责人ID（用于数据隔离）
 * @param {string} timezoneName - 账户时区（如 'Asia/Shanghai'，可选，如果不提供则从 Facebook API 获取）
 * @returns {Promise<Object>} 同步结果 { success: boolean, syncedCount: number, sessionId: string }
 * 
 * 【两步拉取流程】
 * 1. 先调用 Facebook API 获取账户时区：/{accountId}?fields=timezone_name
 * 2. 使用该时区计算 time_range 拉取 insights
 * 3. 写入时把 timezone_name 落库，便于后续"数据时区优先"查询
 */
export async function syncAccountTodayStats(accountId, ownerId, timezoneName = null) {
  console.log(`🔄 开始同步账户 ${accountId} 的今日数据...`)
  
  // 检查 Token 熔断器状态
  const breakerStatus = getCircuitBreakerStatus()
  if (breakerStatus.isLocked) {
    throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
  }
  
  try {
    // 1. 生成唯一的 sync_session_id（时间戳 + 随机串）
    const syncSessionId = generateSyncSessionId()
    const syncedAt = new Date()
    
    // 2. 创建 Facebook API 客户端实例
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      throw new Error('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
    }
    const facebookApi = new FacebookMarketingAPI(accessToken)
    
    // 3. 两步拉取：先获取账户时区（流派2）
    // 为什么需要这一步？
    // - Facebook API 的账户时区是最可靠的来源（比数据库配置更准确）
    // - 在拉取 insights 前先获取时区，确保 time_range 计算与账户时区对齐
    // - 写入时把 timezone_name 落库，便于后续"数据时区优先"查询
    // 【修复】无论是否传入 timezoneName，都从 Facebook API 获取最新时区，确保数据一致性
    console.log(`📡 从 Facebook API 获取账户 ${accountId} 的时区...`)
    const apiTimezone = await facebookApi.getAccountTimezone(accountId)
    console.log(`✅ 账户 ${accountId} 时区（从 API 获取）: ${apiTimezone}`)
    
    // 如果 API 返回的时区与传入的时区不一致，更新数据库
    if (timezoneName && timezoneName !== apiTimezone) {
      console.log(`⚠️  时区不一致：数据库=${timezoneName}，API=${apiTimezone}，更新数据库...`)
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        console.log(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        console.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
    } else if (!timezoneName) {
      // 如果数据库中没有时区，也更新数据库
      console.log(`📝 数据库中没有时区配置，更新为 ${apiTimezone}...`)
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        console.log(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        console.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
    }
    
    // 使用从 API 获取的时区（最准确）
    timezoneName = apiTimezone
    
    // 3. 获取账户下所有广告ID列表
    console.log(`📋 获取账户 ${accountId} 的广告列表...`)
    const ads = await facebookApi.getAds(accountId)
    
    if (!ads || ads.length === 0) {
      console.log(`⚠️  账户 ${accountId} 没有广告，跳过同步`)
      return {
        success: true,
        syncedCount: 0,
        sessionId: syncSessionId
      }
    }
    
    // 提取广告ID列表
    const adIds = ads.map(ad => String(ad.id || ad.ad_id || '')).filter(id => id)
    
    if (adIds.length === 0) {
      console.log(`⚠️  账户 ${accountId} 的广告列表为空，跳过同步`)
      return {
        success: true,
        syncedCount: 0,
        sessionId: syncSessionId
      }
    }
    
    console.log(`📋 找到 ${adIds.length} 个广告，开始批量拉取数据...`)
    
    // 4. 获取广告状态（从 /ads API 获取）
    console.log(`📋 获取账户 ${accountId} 的广告状态...`)
    const adsWithStatus = await facebookApi.getAds(accountId)
    
    // 创建广告状态映射表（ad_id -> status），便于后续合并
    const statusMap = new Map()
    adsWithStatus.forEach(ad => {
      const adId = String(ad.id || ad.ad_id || '')
      // 优先使用 effective_status（实际生效状态），如果没有则使用 status
      const status = ad.effective_status || ad.status || null
      if (adId) {
        statusMap.set(adId, status)
      }
    })
    
    // 5. 使用 20-Batch 聚合拉取数据
    const insights = await fetchInsightsInBatches(accountId, adIds, facebookApi)
    
    if (!insights || insights.length === 0) {
      console.log(`⚠️  账户 ${accountId} 没有拉取到数据，跳过写入`)
      return {
        success: true,
        syncedCount: 0,
        sessionId: syncSessionId
      }
    }
    
    // 6. 合并广告状态到 insights 数据中
    insights.forEach(insight => {
      const adId = String(insight.ad_id || '')
      if (statusMap.has(adId)) {
        insight.status = statusMap.get(adId)
      }
    })
    
    // 7. 批量写入 ad_snapshots 表
    const syncedCount = await saveSnapshotsToDb(insights, accountId, ownerId, syncSessionId, syncedAt, timezoneName)
    
    console.log(`✅ 账户 ${accountId} 同步完成，会话ID: ${syncSessionId}，共同步 ${syncedCount} 条记录`)
    
    return {
      success: true,
      syncedCount: syncedCount,
      sessionId: syncSessionId
    }
  } catch (error) {
    console.error(`❌ 同步账户 ${accountId} 失败:`, error.message)
    throw error
  }
}

/**
 * 按日拉取广告数据（使用 time_increment=1）
 * 解决 Facebook 归因延迟：将"迟到事件"修复到正确的自然日
 * @param {string} accountId - Facebook 账户ID
 * @param {Array<string>} adIds - 广告ID列表
 * @param {FacebookMarketingAPI} facebookApi - Facebook API 客户端
 * @param {string} sinceDate - 开始日期（YYYY-MM-DD，账户时区）
 * @param {string} untilDate - 结束日期（YYYY-MM-DD，账户时区）
 * @returns {Promise<Array>} 按日数据数组，每个元素包含 date 字段
 */
async function fetchInsightsByDay(accountId, adIds, facebookApi, sinceDate, untilDate) {
  console.log(`📅 按日拉取数据: ${sinceDate} ~ ${untilDate}，共 ${adIds.length} 个广告`)
  
  if (!adIds || adIds.length === 0) {
    return []
  }
  
  const BATCH_SIZE = 20
  const adIdChunks = chunkArray(adIds, BATCH_SIZE)
  const allDailyInsights = []
  
  const fields = 'ad_id,ad_name,adset_id,spend,cpc,actions,action_values,cost_per_action_type,cost_per_unique_link_click,cost_per_unique_inline_link_click,inline_link_clicks,unique_inline_link_clicks,purchase_roas'
  const useAccountAttributionSetting = 'true'
  
  // 遍历每个批次
  for (let i = 0; i < adIdChunks.length; i++) {
    const chunk = adIdChunks[i]
    console.log(`📦 处理第 ${i + 1}/${adIdChunks.length} 批，共 ${chunk.length} 个广告`)
    
    try {
      // 构造 Batch API 请求
      // 使用 time_increment=1 获取按日数据，since/until 指定日期范围
      const batchRequests = chunk.map(adId => ({
        method: 'GET',
        relative_url: `${adId}/insights?fields=${fields}&time_increment=1&since=${sinceDate}&until=${untilDate}&use_account_attribution_setting=${useAccountAttributionSetting}`
      }))
      
      const FACEBOOK_API_VERSION = 'v24.0'
      const batchUrl = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/`
      const batchParams = {
        batch: JSON.stringify(batchRequests),
        access_token: facebookApi.accessToken
      }
      
      const response = await facebookApi.makeRequest(batchUrl, batchParams, 'POST', null, { 
        returnHeaders: true,
        timeout: 45000 
      })
      
      const responseData = (response && typeof response === 'object' && 'data' in response) 
        ? response.data 
        : response
      const responseHeaders = (response && typeof response === 'object' && 'headers' in response)
        ? response.headers
        : {}
      
      if (responseData.error) {
        console.error(`❌ Batch API 请求失败:`, responseData.error)
        continue
      }
      
      // 解析响应头并动态休眠
      const usageHeader = responseHeaders['x-business-use-case-usage'] || responseHeaders['x-business-use-case-usage'.toLowerCase()]
      if (usageHeader) {
        const usageInfo = parseUsageHeader(usageHeader)
        await sleepBasedOnUsage(usageInfo)
      } else if (i < adIdChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
      // 解析 Batch API 响应
      const batchResponses = Array.isArray(responseData) ? responseData : []
      
      batchResponses.forEach((item, index) => {
        try {
          const adId = chunk[index]
          
          if (item.code === 200 && item.body) {
            const bodyData = JSON.parse(item.body)
            
            if (bodyData.error) {
              console.warn(`⚠️  广告 ${adId} 拉取失败:`, bodyData.error.message)
              return
            }
            
            // time_increment=1 返回的是数组，每个元素代表一天的数据
            const dailyData = Array.isArray(bodyData.data) ? bodyData.data : (bodyData.data ? [bodyData.data] : [])
            
            // 每个 dailyData 元素包含 date_start 字段（YYYY-MM-DD）
            dailyData.forEach(dayInsight => {
              if (dayInsight.date_start) {
                allDailyInsights.push({
                  ...dayInsight,
                  date: dayInsight.date_start  // 添加 date 字段，便于后续处理
                })
              }
            })
          }
        } catch (parseError) {
          console.error(`❌ 解析广告 ${chunk[index]} 的响应失败:`, parseError.message)
        }
      })
    } catch (error) {
      console.error(`❌ 第 ${i + 1} 批请求失败:`, error.message)
      continue
    }
  }
  
  console.log(`✅ 按日拉取完成，共获取 ${allDailyInsights.length} 条按日数据`)
  return allDailyInsights
}

/**
 * 将按日数据更新到 daily_stats 表
 * @param {Array} dailyInsights - 按日数据数组
 * @param {string} accountId - 账户ID
 * @param {number} ownerId - 负责人ID
 * @param {string} timezoneName - 时区
 * @returns {Promise<number>} 更新的记录数
 */
async function updateDailyStatsFromInsights(dailyInsights, accountId, ownerId, timezoneName) {
  if (!dailyInsights || dailyInsights.length === 0) {
    return 0
  }
  
  console.log(`💾 开始更新 daily_stats 表，共 ${dailyInsights.length} 条按日数据`)
  
  const values = dailyInsights.map(insight => {
    // 解析 actions 和 action_values
    const actions = insight.actions || []
    const purchases = parseActions(actions)
    const purchaseValue = extractPurchaseValue(insight.action_values)
    
    // 提取成本字段
    const costPerActionType = insight.cost_per_action_type || []
    const cpa = pickCostPerActionType(costPerActionType, [
      'offsite_conversion.fb_pixel_purchase',
      'purchase'
    ])
    
    // 提取原始计数字段
    const linkClicks = parseInt(insight.inline_link_clicks || 0)
    const uniqueLinkClicks = parseInt(insight.unique_inline_link_clicks || 0)
    const addToCartCount = extractActionCount(actions, [
      'offsite_conversion.fb_pixel_add_to_cart',
      'add_to_cart'
    ])
    const initiateCheckoutCount = extractActionCount(actions, [
      'offsite_conversion.fb_pixel_initiate_checkout',
      'initiate_checkout'
    ])
    const addPaymentInfoCount = extractActionCount(actions, [
      'offsite_conversion.fb_pixel_add_payment_info',
      'add_payment_info'
    ])
    
    // 计算 CPC 和 ROAS
    const spend = parseFloat(insight.spend || 0)
    const cpc = insight.cpc != null ? parseFloat(insight.cpc) : (linkClicks > 0 ? spend / linkClicks : null)
    const roas = extractRoas(insight, spend, purchaseValue)
    
    return [
      accountId,
      String(insight.ad_id || ''),
      insight.ad_name || null,
      ownerId,
      insight.date || insight.date_start,  // 使用 date_start 作为自然日
      timezoneName,
      spend,
      cpc,
      roas,
      purchases,
      parseInt(addToCartCount || 0),  // add_to_cart 字段（兼容旧字段名）
      actions ? JSON.stringify(actions) : null,
      linkClicks,
      uniqueLinkClicks,
      purchaseValue,
      addToCartCount,
      initiateCheckoutCount,
      addPaymentInfoCount,
      insight.adset_id ? String(insight.adset_id) : null
    ]
  })
  
  // 使用 ON DUPLICATE KEY UPDATE 更新 daily_stats
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  
  const sql = `
    INSERT INTO daily_stats (
      account_id, ad_id, ad_name, owner_id, date, timezone_name,
      spend, cpc, roas, purchases, add_to_cart, actions,
      link_clicks, unique_link_clicks, purchase_value,
      add_to_cart_count, initiate_checkout_count, add_payment_info_count,
      ad_set_id
    ) VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE
      ad_name = VALUES(ad_name),
      timezone_name = VALUES(timezone_name),
      spend = VALUES(spend),
      cpc = VALUES(cpc),
      roas = VALUES(roas),
      purchases = VALUES(purchases),
      actions = VALUES(actions),
      link_clicks = VALUES(link_clicks),
      unique_link_clicks = VALUES(unique_link_clicks),
      purchase_value = VALUES(purchase_value),
      add_to_cart_count = VALUES(add_to_cart_count),
      initiate_checkout_count = VALUES(initiate_checkout_count),
      add_payment_info_count = VALUES(add_payment_info_count),
      ad_set_id = VALUES(ad_set_id),
      updated_at = NOW()
  `
  
  const params = values.flat()
  const [result] = await pool.execute(sql, params)
  const updatedCount = result.affectedRows || 0
  
  console.log(`✅ 成功更新 ${updatedCount} 条记录到 daily_stats 表`)
  return updatedCount
}

/**
 * 筛选近 N 天内有花费或转化的广告（用于优化 API 配额）
 * @param {string} accountId - 账户ID
 * @param {Array<string>} adIds - 所有广告ID列表
 * @param {string} timezoneName - 账户时区
 * @param {number} daysBack - 回溯天数（默认 7 天）
 * @returns {Promise<Array<string>>} 筛选后的广告ID列表
 */
async function filterActiveAds(accountId, adIds, timezoneName, daysBack = 7) {
  if (!adIds || adIds.length === 0) {
    return []
  }
  
  try {
    // 计算日期范围（账户时区）
    const now = DateTime.now().setZone(timezoneName)
    const sinceDate = now.minus({ days: daysBack }).toFormat('yyyy-MM-dd')
    const untilDate = now.toFormat('yyyy-MM-dd')  // 包含今天
    
    // 查询 daily_stats 和 ad_snapshots，找出近 N 天内有花费或转化的广告
    const [rows] = await pool.query(`
      SELECT DISTINCT ad_id
      FROM (
        SELECT ad_id FROM daily_stats
        WHERE account_id = ? 
          AND date >= ? 
          AND date <= ?
          AND (spend > 0 OR purchases > 0 OR link_clicks > 0)
        
        UNION
        
        SELECT ad_id FROM ad_snapshots
        WHERE account_id = ?
          AND DATE(synced_at) >= ?
          AND DATE(synced_at) <= ?
          AND (spend > 0 OR purchases > 0 OR link_clicks > 0)
      ) AS active_ads
    `, [accountId, sinceDate, untilDate, accountId, sinceDate, untilDate])
    
    const activeAdIds = rows.map(row => String(row.ad_id))
    
    // 如果查询到的活跃广告数量较少，说明大部分广告都没有数据
    // 返回筛选后的列表；如果筛选后数量仍然很多，说明大部分广告都有数据，返回原列表
    if (activeAdIds.length > 0 && activeAdIds.length < adIds.length * 0.5) {
      console.log(`📊 筛选活跃广告: ${adIds.length} → ${activeAdIds.length} (近 ${daysBack} 天内有数据)`)
      return activeAdIds
    }
    
    // 如果大部分广告都有数据，或者查询失败，返回原列表
    return adIds
  } catch (error) {
    console.warn(`⚠️  筛选活跃广告失败，使用全部广告:`, error.message)
    return adIds
  }
}

/**
 * 统一刷新账户的历史时区（一次性任务）
 * 用于修复历史数据中 timezone_name 不一致的问题
 * @param {string} accountId - 账户ID
 * @param {string} timezoneName - 新的时区（如果不提供，从 account_mappings 获取）
 * @returns {Promise<Object>} 刷新结果 { success: boolean, updatedCount: number }
 */
export async function refreshAccountTimezoneHistory(accountId, timezoneName = null) {
  console.log(`🔄 开始刷新账户 ${accountId} 的历史时区...`)
  
  try {
    // 1. 获取账户时区
    if (!timezoneName) {
      const [rows] = await pool.query(`
        SELECT COALESCE(timezone_name, 'UTC') as timezone_name
        FROM account_mappings
        WHERE fb_account_id = ?
      `, [accountId])
      
      if (rows.length === 0) {
        throw new Error(`账户 ${accountId} 不存在`)
      }
      
      timezoneName = rows[0].timezone_name || 'UTC'
    }
    
    console.log(`📋 目标时区: ${timezoneName}`)
    
    // 2. 统计需要更新的记录数
    const [countRows] = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM daily_stats
      WHERE account_id = ? AND timezone_name != ?
    `, [accountId, timezoneName])
    
    const needUpdateCount = countRows[0]?.cnt || 0
    
    if (needUpdateCount === 0) {
      console.log(`✅ 账户 ${accountId} 的历史时区已一致，无需更新`)
      return {
        success: true,
        updatedCount: 0
      }
    }
    
    console.log(`📊 需要更新 ${needUpdateCount} 条记录`)
    
    // 3. 批量更新 timezone_name
    const [result] = await pool.execute(`
      UPDATE daily_stats
      SET timezone_name = ?, updated_at = NOW()
      WHERE account_id = ? AND timezone_name != ?
    `, [timezoneName, accountId, timezoneName])
    
    const updatedCount = result.affectedRows || 0
    
    console.log(`✅ 账户 ${accountId} 的历史时区刷新完成，共更新 ${updatedCount} 条记录`)
    
    return {
      success: true,
      updatedCount: updatedCount
    }
  } catch (error) {
    console.error(`❌ 刷新账户 ${accountId} 历史时区失败:`, error.message)
    throw error
  }
}

/**
 * 同步单个账户的滑动窗口数据（修复归因延迟）
 * 【核心改进】严格按自然日语义：
 * - today 数据写入 ad_snapshots（实时快照）
 * - 过去 N 天的按日数据更新到 daily_stats（修复迟到归因）
 * @param {string} accountId - Facebook 账户ID（字符串格式）
 * @param {number} ownerId - 负责人ID（用于数据隔离）
 * @param {string} timezoneName - 账户时区（如 'Asia/Shanghai'）
 * @param {number} daysBack - 回溯天数（默认 7 天）
 * @param {boolean} optimizeQuota - 是否优化配额（只拉取有数据的广告，默认 false）
 * @returns {Promise<Object>} 同步结果 { success: boolean, todayCount: number, dailyStatsCount: number, sessionId: string }
 */
export async function syncAccountSlidingWindow(accountId, ownerId, timezoneName = 'UTC', daysBack = 7, optimizeQuota = false) {
  console.log(`🔄 开始同步账户 ${accountId} 的滑动窗口数据（修复归因延迟）...`)
  
  // 检查 Token 熔断器状态
  const breakerStatus = getCircuitBreakerStatus()
  if (breakerStatus.isLocked) {
    throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
  }
  
  try {
    // 1. 生成唯一的 sync_session_id
    const syncSessionId = generateSyncSessionId()
    const syncedAt = new Date()
    
    // 2. 创建 Facebook API 客户端实例
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      throw new Error('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
    }
    const facebookApi = new FacebookMarketingAPI(accessToken)
    
    // 3. 从 Facebook API 获取账户时区
    console.log(`📡 从 Facebook API 获取账户 ${accountId} 的时区...`)
    const apiTimezone = await facebookApi.getAccountTimezone(accountId)
    console.log(`✅ 账户 ${accountId} 时区（从 API 获取）: ${apiTimezone}`)
    
    // 更新数据库时区（如果不一致）
    if (timezoneName && timezoneName !== apiTimezone) {
      console.log(`⚠️  时区不一致：数据库=${timezoneName}，API=${apiTimezone}，更新数据库...`)
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        console.log(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        console.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
    } else if (!timezoneName || timezoneName === 'UTC') {
      console.log(`📝 数据库时区为默认值，更新为 ${apiTimezone}...`)
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        console.log(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        console.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
    }
    
    timezoneName = apiTimezone
    
    // 4. 获取账户下所有广告ID列表
    console.log(`📋 获取账户 ${accountId} 的广告列表...`)
    const ads = await facebookApi.getAds(accountId)
    
    if (!ads || ads.length === 0) {
      console.log(`⚠️  账户 ${accountId} 没有广告，跳过同步`)
      return {
        success: true,
        todayCount: 0,
        dailyStatsCount: 0,
        sessionId: syncSessionId
      }
    }
    
    const adIds = ads.map(ad => String(ad.id || ad.ad_id || '')).filter(id => id)
    
    if (adIds.length === 0) {
      console.log(`⚠️  账户 ${accountId} 的广告列表为空，跳过同步`)
      return {
        success: true,
        todayCount: 0,
        dailyStatsCount: 0,
        sessionId: syncSessionId
      }
    }
    
    console.log(`📋 找到 ${adIds.length} 个广告，开始滑动窗口同步...`)
    
    // 5. 配额优化：如果启用，只拉取近 N 天内有数据的广告
    let targetAdIds = adIds
    if (optimizeQuota) {
      targetAdIds = await filterActiveAds(accountId, adIds, timezoneName, daysBack)
      if (targetAdIds.length === 0) {
        console.log(`⚠️  没有找到活跃广告，跳过滑动窗口同步`)
        return {
          success: true,
          todayCount: 0,
          dailyStatsCount: 0,
          sessionId: syncSessionId
        }
      }
    }
    
    // 6. 获取广告状态
    const adsWithStatus = await facebookApi.getAds(accountId)
    const statusMap = new Map()
    adsWithStatus.forEach(ad => {
      const adId = String(ad.id || ad.ad_id || '')
      const status = ad.effective_status || ad.status || null
      if (adId) {
        statusMap.set(adId, status)
      }
    })
    
    // 7. 同步 Today 数据 → 写入 ad_snapshots（实时快照）
    console.log(`📅 同步 Today 数据 → ad_snapshots...`)
    const todayInsights = await fetchInsightsInBatches(accountId, targetAdIds, facebookApi, 'today')
    
    // 合并广告状态到 today 数据
    todayInsights.forEach(insight => {
      const adId = String(insight.ad_id || '')
      if (statusMap.has(adId)) {
        insight.status = statusMap.get(adId)
      }
    })
    
    // 写入 ad_snapshots（只存 today 数据）
    const todayCount = await saveSnapshotsToDb(todayInsights, accountId, ownerId, syncSessionId, syncedAt, timezoneName)
    console.log(`✅ Today 数据已写入 ad_snapshots，共 ${todayCount} 条记录`)
    
    // 8. 同步过去 N 天的按日数据 → 更新 daily_stats（修复迟到归因）
    console.log(`📅 同步过去 ${daysBack} 天的按日数据 → daily_stats...`)
    
    // 计算日期范围（账户时区）
    const now = DateTime.now().setZone(timezoneName)
    const untilDate = now.minus({ days: 1 }).toFormat('yyyy-MM-dd')  // 昨天（不包含今天）
    const sinceDate = now.minus({ days: daysBack }).toFormat('yyyy-MM-dd')  // N 天前
    
    console.log(`📅 日期范围: ${sinceDate} ~ ${untilDate} (账户时区: ${timezoneName})`)
    
    // 拉取按日数据（使用筛选后的广告列表）
    const dailyInsights = await fetchInsightsByDay(accountId, targetAdIds, facebookApi, sinceDate, untilDate)
    
    if (dailyInsights.length === 0) {
      console.log(`⚠️  没有拉取到按日数据，跳过更新 daily_stats`)
      return {
        success: true,
        todayCount: todayCount,
        dailyStatsCount: 0,
        sessionId: syncSessionId
      }
    }
    
    // 更新 daily_stats（按日修复迟到归因）
    const dailyStatsCount = await updateDailyStatsFromInsights(dailyInsights, accountId, ownerId, timezoneName)
    
    console.log(`✅ 账户 ${accountId} 滑动窗口同步完成`)
    console.log(`   - Today 数据: ${todayCount} 条（ad_snapshots）`)
    console.log(`   - 按日数据: ${dailyStatsCount} 条（daily_stats）`)
    console.log(`   会话ID: ${syncSessionId}`)
    
    return {
      success: true,
      todayCount: todayCount,
      dailyStatsCount: dailyStatsCount,
      sessionId: syncSessionId
    }
  } catch (error) {
    console.error(`❌ 同步账户 ${accountId} 滑动窗口数据失败:`, error.message)
    throw error
  }
}

/**
 * 同步所有账户的滑动窗口数据（修复归因延迟）
 * 【核心改进】严格按自然日语义：
 * - today 数据写入 ad_snapshots（实时快照）
 * - 过去 N 天的按日数据更新到 daily_stats（修复迟到归因）
 * @param {number} daysBack - 回溯天数（默认 7 天）
 * @param {boolean} optimizeQuota - 是否优化配额（只拉取有数据的广告，默认 false）
 * @returns {Promise<Object>} 同步结果汇总
 */
export async function syncAllAccountsSlidingWindow(daysBack = 7, optimizeQuota = false) {
  console.log('🔄 开始同步所有账户的滑动窗口数据（修复归因延迟）...')
  
  // 分布式锁：防止多实例重复执行
  const lockName = 'sync:sliding_window'
  const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
  const lockAcquired = lockRows[0]?.acquired === 1
  
  if (!lockAcquired) {
    console.log('⏸️  另一个实例正在执行滑动窗口同步（DB锁已占用），跳过本次执行')
    return {
      success: true,
      totalAccounts: 0,
      skipped: true,
      message: '另一个实例正在执行，跳过'
    }
  }
  
  try {
    // 1. 从 account_mappings 表获取所有账户列表
    const [accounts] = await pool.query(`
      SELECT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      ORDER BY fb_account_id
    `)
    
    if (!accounts || accounts.length === 0) {
      console.log('⚠️  没有找到活跃账户，跳过滑动窗口同步')
      return {
        success: true,
        totalAccounts: 0,
        results: []
      }
    }
    
    console.log(`📋 找到 ${accounts.length} 个活跃账户，开始滑动窗口同步...`)
    
    // 2. 遍历每个账户，调用 syncAccountSlidingWindow
    const results = []
    let totalTodayCount = 0
    let totalDailyStatsCount = 0
    
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        console.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
        continue
      }
      
      try {
        console.log(`\n[${i + 1}/${accounts.length}] 滑动窗口同步账户 ${accountId}...`)
        const result = await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, optimizeQuota)
        results.push({
          accountId,
          ownerId,
          ...result
        })
        
        totalTodayCount += result.todayCount || 0
        totalDailyStatsCount += result.dailyStatsCount || 0
        
        // 在账户之间休眠，避免频率超限
        if (i < accounts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)) // 休眠 1 秒
        }
      } catch (error) {
        console.error(`❌ 账户 ${accountId} 滑动窗口同步失败:`, error.message)
        results.push({
          accountId,
          ownerId,
          success: false,
          error: error.message,
          todayCount: 0,
          dailyStatsCount: 0
        })
        // 继续处理下一个账户，不中断整个流程
      }
    }
    
    // 3. 汇总结果
    const successCount = results.filter(r => r.success).length
    
    console.log(`\n✅ 所有账户滑动窗口同步完成`)
    console.log(`📊 统计:`)
    console.log(`   - 账户总数: ${accounts.length}`)
    console.log(`   - 成功账户: ${successCount}`)
    console.log(`   - Today 数据: ${totalTodayCount} 条（ad_snapshots）`)
    console.log(`   - 按日数据: ${totalDailyStatsCount} 条（daily_stats）`)
    
    return {
      success: true,
      totalAccounts: accounts.length,
      successCount: successCount,
      totalTodayCount: totalTodayCount,
      totalDailyStatsCount: totalDailyStatsCount,
      results
    }
  } catch (error) {
    console.error('❌ 同步所有账户滑动窗口数据失败:', error.message)
    throw error
  } finally {
    // 释放锁
    try {
      await pool.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
    } catch (lockError) {
      console.warn(`⚠️  释放锁失败: ${lockError.message}`)
    }
  }
}

/**
 * 同步所有账户的今日广告数据
 * @returns {Promise<Object>} 同步结果汇总
 */
export async function syncAllAccountsTodayStats() {
  console.log('🔄 开始同步所有账户的今日数据...')
  
  try {
    // 1. 从 account_mappings 表获取所有账户列表
    // 注意：这里获取所有账户，不按 owner_id 过滤（因为这是系统级同步任务）
    // 如果需要按 owner_id 过滤，可以在调用时传入参数
    // ⚠️ 注意：account_mappings 表的字段名是 fb_account_id，不是 account_id
    // 从 account_mappings 表获取所有活跃账户，包括时区信息
    const [accounts] = await pool.query(`
      SELECT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      ORDER BY fb_account_id
    `)
    
    if (!accounts || accounts.length === 0) {
      console.log('⚠️  没有找到活跃账户，跳过同步')
      return {
        success: true,
        totalAccounts: 0,
        results: []
      }
    }
    
    console.log(`📋 找到 ${accounts.length} 个活跃账户，开始同步...`)
    
    // 2. 遍历每个账户，调用 syncAccountTodayStats
    const results = []
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      // 从数据库读取时区，如果没有则使用默认值 'UTC'
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        console.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
        continue
      }
      
      try {
        console.log(`\n[${i + 1}/${accounts.length}] 同步账户 ${accountId}...`)
        const result = await syncAccountTodayStats(accountId, ownerId, timezoneName)
        results.push({
          accountId,
          ownerId,
          ...result
        })
        
        // 在账户之间休眠，避免频率超限
        if (i < accounts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)) // 休眠 1 秒
        }
      } catch (error) {
        console.error(`❌ 账户 ${accountId} 同步失败:`, error.message)
        results.push({
          accountId,
          ownerId,
          success: false,
          error: error.message,
          syncedCount: 0
        })
        // 继续处理下一个账户，不中断整个流程
      }
    }
    
    // 3. 汇总结果（增强统计：区分成功且有数据、成功但无数据、失败）
    const successWithData = results.filter(r => r.success && (r.syncedCount || 0) > 0).length
    const successNoData = results.filter(r => r.success && (r.syncedCount || 0) === 0).length
    const failed = results.filter(r => !r.success).length
    const totalSyncedCount = results.reduce((sum, r) => sum + (r.syncedCount || 0), 0)
    
    console.log(`\n✅ 所有账户同步完成，共 ${accounts.length} 个账户`)
    console.log(`📊 详细统计:`)
    console.log(`   - 成功且有数据: ${successWithData} 个`)
    console.log(`   - 成功但无数据: ${successNoData} 个`)
    console.log(`   - 失败: ${failed} 个`)
    console.log(`   - 共同步 ${totalSyncedCount} 条记录`)
    
    // 如果有失败账户，列出详细信息
    if (failed > 0) {
      const failedAccounts = results.filter(r => !r.success)
      console.log(`\n⚠️  失败的账户详情:`)
      failedAccounts.forEach(r => {
        console.log(`   - ${r.accountId}: ${r.error || '未知错误'}`)
      })
    }
    
    // 如果无数据账户过多，给出提示
    if (successNoData > accounts.length * 0.5) {
      console.log(`\n💡 提示: 超过 50% 的账户没有数据，可能是:`)
      console.log(`   - 账户下没有活跃广告`)
      console.log(`   - 广告今天没有花费数据`)
      console.log(`   - 数据同步时间窗口问题`)
    }
    
    return {
      success: true,
      totalAccounts: accounts.length,
      successCount: successWithData + successNoData,
      successWithData,
      successNoData,
      failed,
      totalSyncedCount: totalSyncedCount,
      results
    }
  } catch (error) {
    console.error('❌ 同步所有账户失败:', error.message)
    throw error
  }
}

// ============================================
// 辅助函数：工具方法
// ============================================

/**
 * 生成唯一的同步会话ID
 * @returns {string} 格式：sync_20260109_143025_abc123
 */
function generateSyncSessionId() {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15) // 20260109T143025
  const random = Math.random().toString(36).substring(2, 8) // 6位随机字符串
  return `sync_${timestamp}_${random}`
}

/**
 * 将数组按指定大小切分成多个子数组
 * @param {Array} array - 要切分的数组
 * @param {number} size - 每个子数组的大小
 * @returns {Array<Array>} 切分后的二维数组
 */
function chunkArray(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

/**
 * 使用 Facebook Batch API 批量拉取广告数据
 * @param {string} accountId - 账户ID（用于日志）
 * @param {Array<string>} adIds - 广告ID列表
 * @param {FacebookMarketingAPI} facebookApi - Facebook API 客户端实例
 * @param {string} datePreset - 时间范围预设（'today' | 'last_7d'），默认 'today'
 * @returns {Promise<Array>} 广告洞察数据列表
 */
async function fetchInsightsInBatches(accountId, adIds, facebookApi, datePreset = 'today') {
  console.log(`📦 开始批量拉取账户 ${accountId} 的广告数据（${datePreset}），共 ${adIds.length} 个广告`)
  
  // 如果没有广告，直接返回空数组
  if (!adIds || adIds.length === 0) {
    return []
  }
  
  // 将广告ID列表按 20 个一组切分（Facebook Batch API 限制）
  const BATCH_SIZE = 20
  const adIdChunks = chunkArray(adIds, BATCH_SIZE)
  const allInsights = []
  
  // 定义需要请求的字段（只请求需要的字段，避免浪费）
  // 注意：cost_per_action_type 是数组，包含各种 action_type 的成本
  // cost_per_unique_link_click 或 cost_per_unique_inline_link_click 是 uCPC
  // 新增：inline_link_clicks, unique_inline_link_clicks（用于提取原始计数）
  // 新增：adset_id（广告组ID，用于规则动作：增减预算）
  // 重要：ROAS 字段名是 purchase_roas（不是 roas），返回格式是数组，需要提取
  // 兜底：如果 purchase_roas 不可用，则通过计算：ROAS = purchase_value / spend
  const fields = 'ad_id,ad_name,adset_id,spend,cpc,actions,action_values,cost_per_action_type,cost_per_unique_link_click,cost_per_unique_inline_link_click,inline_link_clicks,unique_inline_link_clicks,purchase_roas'
  const useAccountAttributionSetting = 'true'
  
  // 遍历每一组，发送 Batch API 请求
  for (let i = 0; i < adIdChunks.length; i++) {
    const chunk = adIdChunks[i]
    console.log(`📦 处理第 ${i + 1}/${adIdChunks.length} 批，共 ${chunk.length} 个广告`)
    
    try {
      // 构造 Batch API 请求体
      // 每个子请求的 relative_url 格式：{ad_id}/insights?fields=...&date_preset=today&use_account_attribution_setting=true
      const batchRequests = chunk.map(adId => ({
        method: 'GET',
        relative_url: `${adId}/insights?fields=${fields}&date_preset=${datePreset}&use_account_attribution_setting=${useAccountAttributionSetting}`
      }))
      
      // Facebook Batch API 端点
      const FACEBOOK_API_VERSION = 'v24.0'
      const batchUrl = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/`
      
      // 构造请求参数（Batch API 使用 form-urlencoded 格式）
      // batch 字段必须是 JSON 字符串，access_token 作为普通参数
      const batchParams = {
        batch: JSON.stringify(batchRequests), // Facebook API 要求 batch 是 JSON 字符串
        access_token: facebookApi.accessToken
      }
      
      // 发送 Batch API 请求
      // 注意：makeRequest 方法会将 params 作为 query string 或 form data 发送
      // 对于 POST 请求，Facebook Batch API 期望 form-urlencoded 格式
      // 使用 returnHeaders 选项获取响应头，用于频率控制
      const response = await facebookApi.makeRequest(batchUrl, batchParams, 'POST', null, { 
        returnHeaders: true,
        timeout: 45000 
      })
      
      // 提取数据和响应头
      // 注意：如果 makeRequest 返回 { data, headers }，则提取 data；否则直接使用 response（向后兼容）
      const responseData = (response && typeof response === 'object' && 'data' in response) 
        ? response.data 
        : response
      const responseHeaders = (response && typeof response === 'object' && 'headers' in response)
        ? response.headers
        : {}
      
      // 检查是否有错误
      if (responseData.error) {
        console.error(`❌ Batch API 请求失败:`, responseData.error)
        // 继续处理下一批，不中断整个流程
        continue
      }
      
      // 解析响应头并动态休眠（在批次之间）
      const usageHeader = responseHeaders['x-business-use-case-usage'] || responseHeaders['x-business-use-case-usage'.toLowerCase()]
      if (usageHeader) {
        const usageInfo = parseUsageHeader(usageHeader)
        // 注意：这里在批次之间休眠，而不是在每次请求后休眠
        // 因为 Batch API 是一次请求包含多个子请求
        await sleepBasedOnUsage(usageInfo)
      } else if (i < adIdChunks.length - 1) {
        // 如果没有响应头，使用默认休眠时间（保守策略）
        console.log(`⏸️  未获取到使用率信息，使用默认休眠时间: 1000ms`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
      // 解析 Batch API 响应
      // Batch API 返回的是一个数组，每个元素对应一个子请求的响应
      const batchResponses = Array.isArray(responseData) ? responseData : []
      
      // 遍历每个子请求的响应
      batchResponses.forEach((item, index) => {
        try {
          const adId = chunk[index]
          
          // 每个响应包含 code（HTTP 状态码）和 body（JSON 字符串）
          if (item.code === 200 && item.body) {
            const bodyData = JSON.parse(item.body)
            
            // 检查是否有错误
            if (bodyData.error) {
              // 增强错误信息：打印完整的错误详情
              const error = bodyData.error
              console.warn(`⚠️  广告 ${adId} 拉取失败:`)
              console.warn(`   错误码: ${error.code || '未知'}`)
              console.warn(`   错误类型: ${error.type || '未知'}`)
              console.warn(`   错误消息: ${error.message || '无消息'}`)
              
              // 特殊处理：如果是"今天没有数据"的错误，记录但不中断
              if (error.message && (
                error.message.includes('No data available') ||
                error.message.includes('no data') ||
                error.message.includes('insufficient data')
              )) {
                console.log(`   💡 提示: 广告 ${adId} 今天没有数据，这是正常情况（可能是新广告或已暂停）`)
              }
              
              return
            }
            
            // 提取 insights 数据（可能是单个对象或数组）
            const insights = Array.isArray(bodyData.data) ? bodyData.data : (bodyData.data ? [bodyData.data] : [])
            
            // 添加到结果列表
            allInsights.push(...insights)
          } else {
            // 非 200 状态码：尝试解析 body 获取详细错误信息
            let errorDetails = `状态码: ${item.code}`
            
            if (item.body) {
              try {
                const bodyData = JSON.parse(item.body)
                if (bodyData.error) {
                  const error = bodyData.error
                  errorDetails = `状态码: ${item.code}, 错误码: ${error.code || '未知'}, 错误类型: ${error.type || '未知'}, 错误消息: ${error.message || '无消息'}`
                  
                  // 特殊处理：400 错误通常是参数或数据问题
                  if (item.code === 400) {
                    console.warn(`⚠️  广告 ${adId} 请求返回 400 错误:`)
                    console.warn(`   ${errorDetails}`)
                    
                    // 常见 400 错误原因分析
                    if (error.message) {
                      if (error.message.includes('No data available') || error.message.includes('no data')) {
                        console.log(`   💡 原因: 今天没有数据（可能是新广告、已暂停或今天未投放）`)
                      } else if (error.message.includes('Invalid parameter') || error.message.includes('invalid')) {
                        console.log(`   💡 原因: 参数无效（可能是广告ID格式问题）`)
                      } else if (error.message.includes('permission') || error.message.includes('access')) {
                        console.log(`   💡 原因: 权限不足（Token可能没有该广告的访问权限）`)
                      } else {
                        console.log(`   💡 原因: ${error.message}`)
                      }
                    }
                  } else {
                    console.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${errorDetails}`)
                  }
                } else {
                  console.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${errorDetails}`)
                }
              } catch (parseError) {
                // 如果 body 不是 JSON，直接打印原始内容（截断前200字符）
                const bodyPreview = String(item.body).substring(0, 200)
                console.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${item.code}`)
                console.warn(`   响应内容预览: ${bodyPreview}${item.body.length > 200 ? '...' : ''}`)
              }
            } else {
              console.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${item.code} (无响应体)`)
            }
          }
        } catch (parseError) {
          console.error(`❌ 解析广告 ${chunk[index]} 的响应失败:`, parseError.message)
          if (parseError.stack) {
            console.error(`   堆栈: ${parseError.stack.split('\n').slice(0, 3).join('\n')}`)
          }
        }
      })
      
      // 注意：动态休眠已在上面处理（基于响应头），这里不再需要固定休眠
      
    } catch (error) {
      console.error(`❌ 第 ${i + 1} 批请求失败:`, error.message)
      // 继续处理下一批，不中断整个流程
      continue
    }
  }
  
  console.log(`✅ 批量拉取完成，共获取 ${allInsights.length} 条广告数据`)
  return allInsights
}

/**
 * 将广告快照数据批量写入数据库
 * @param {Array<Object>} insights - 广告洞察数据列表
 * @param {string} accountId - 账户ID
 * @param {number} ownerId - 负责人ID
 * @param {string} syncSessionId - 同步会话ID
 * @param {Date} syncedAt - 同步时间
 * @param {string} timezoneName - 时区
 * @returns {Promise<number>} 成功写入的记录数
 */
async function saveSnapshotsToDb(insights, accountId, ownerId, syncSessionId, syncedAt, timezoneName) {
  console.log(`💾 开始写入数据库，共 ${insights.length} 条记录`)
  
  // 如果没有数据，直接返回 0
  if (!insights || insights.length === 0) {
    return 0
  }
  
  try {
    // 将 insights 数据转换为 ad_snapshots 表的格式
    const values = insights.map(insight => {
      // 解析 actions 字段，提取购买次数
      const actions = insight.actions || []
      const purchases = parseActions(actions)
      
      // 注意：ROAS 不入库（当天数据从 API 获取，历史数据通过计算得出）
      // 如果需要 ROAS，可以在查询时计算：ROAS = 购买总金额 / 花费
      
      // 提取成本字段（使用辅助函数，做好防御性编程）
      // 注意：Facebook API 的"不值不显"原则，如果值为 0 或不存在，字段可能不存在
      const costPerActionType = insight.cost_per_action_type || []
      
      // CPA：从 cost_per_action_type 中提取 purchase 的成本
      const cpa = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ])
      
      // 加购费：从 cost_per_action_type 中提取 add_to_cart 的成本
      const addToCartCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_add_to_cart',
        'add_to_cart'
      ])
      
      // 结账费：从 cost_per_action_type 中提取 initiate_checkout 的成本
      const checkoutCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_initiate_checkout',
        'initiate_checkout'
      ])
      
      // 支付费：从 cost_per_action_type 中提取 add_payment_info 的成本
      const paymentCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_add_payment_info',
        'add_payment_info'
      ])
      
      // uCPC：从 cost_per_unique_link_click 或 cost_per_unique_inline_link_click 提取
      const ucpc = extractUcpc(insight)
      
      // 提取原始计数字段（方案B+优化版）
      // 1. link_clicks：从 inline_link_clicks 提取（Insights API 专用字段）
      const linkClicks = parseInt(insight.inline_link_clicks || 0)
      
      // 2. unique_link_clicks：从 unique_inline_link_clicks 提取（Insights API 专用字段）
      const uniqueLinkClicks = parseInt(insight.unique_inline_link_clicks || 0)
      
      // 3. purchase_value：从 action_values 中提取购买总转化金额
      const purchaseValue = extractPurchaseValue(insight.action_values)
      
      // 4. ROAS：优先从 purchase_roas 提取，缺失时用 purchase_value / spend 计算
      const spend = parseFloat(insight.spend || 0)
      const roas = extractRoas(insight, spend, purchaseValue)
      
      // 5-7. 从 actions 中提取三个 count 字段（兼容多种变体）
      const addToCartCount = extractActionCount(actions, [
        'offsite_conversion.fb_pixel_add_to_cart',
        'add_to_cart'
      ])
      
      const initiateCheckoutCount = extractActionCount(actions, [
        'offsite_conversion.fb_pixel_initiate_checkout',
        'initiate_checkout'
      ])
      
      const addPaymentInfoCount = extractActionCount(actions, [
        'offsite_conversion.fb_pixel_add_payment_info',
        'add_payment_info'
      ])
      
      // 7. ad_set_id：从 Insights API 响应中获取（用于规则动作：增减预算）
      const adSetId = insight.adset_id ? String(insight.adset_id) : null
      
      return {
        accountId: String(accountId), // 确保是字符串
        adId: String(insight.ad_id || ''), // 确保是字符串，避免精度丢失
        adName: insight.ad_name || null,
        status: insight.status || null, // 广告状态（从 /ads API 获取并合并）
        ownerId: ownerId,
        spend: parseFloat(insight.spend || 0),
        cpc: insight.cpc != null ? parseFloat(insight.cpc) : null, // 直接从 API 获取
        ucpc: ucpc, // 可能为 null
        roas: roas, // 优先从 purchase_roas 提取，缺失时计算
        cpa: cpa, // 可能为 null（从 cost_per_action_type 提取）
        actions: actions, // JSON 字段，Drizzle 会自动序列化
        purchases: purchases,
        addToCartCost: addToCartCost, // 可能为 null
        checkoutCost: checkoutCost, // 可能为 null
        paymentCost: paymentCost, // 可能为 null
        // 新增：原始计数字段（方案B+优化版）
        linkClicks: linkClicks,
        uniqueLinkClicks: uniqueLinkClicks,
        purchaseValue: purchaseValue,
        addToCartCount: addToCartCount,
        initiateCheckoutCount: initiateCheckoutCount,
        addPaymentInfoCount: addPaymentInfoCount,
        adSetId: adSetId, // 广告组ID
        syncSessionId: syncSessionId,
        syncedAt: syncedAt,
        timezoneName: timezoneName || 'UTC',
        muteUntil: null, // 默认为 null
        muteReason: null,
        isSimulation: false
      }
    })
    
    // 使用 Drizzle ORM 批量插入
    // 注意：使用 ON DUPLICATE KEY UPDATE 来更新已存在的记录（基于唯一索引 uk_ad_session）
    // 但 Drizzle 不直接支持 ON DUPLICATE KEY UPDATE，我们需要使用原生 SQL
    // 或者先删除旧记录再插入新记录
    
    // 方案1：使用原生 SQL 的 ON DUPLICATE KEY UPDATE（推荐，性能更好）
    if (values.length > 0) {
      // 构建批量插入 SQL（使用 ON DUPLICATE KEY UPDATE 更新已存在的记录）
      // 注意：字段数量已更新，现在是 26 个字段（新增 7 个原始计数字段）
      const placeholders = values.map(() => 
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).join(', ')
      
      const sql = `
        INSERT INTO ad_snapshots (
          account_id, ad_id, ad_name, status, owner_id,
          spend, cpc, ucpc, roas, cpa, actions, purchases,
          add_to_cart_cost, checkout_cost, payment_cost,
          link_clicks, unique_link_clicks, purchase_value,
          add_to_cart_count, initiate_checkout_count, add_payment_info_count,
          ad_set_id,
          sync_session_id, synced_at, timezone_name, mute_until, mute_reason, is_simulation
        ) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          ad_name = VALUES(ad_name),
          status = VALUES(status),
          spend = VALUES(spend),
          cpc = VALUES(cpc),
          ucpc = VALUES(ucpc),
          roas = VALUES(roas),
          cpa = VALUES(cpa),
          actions = VALUES(actions),
          purchases = VALUES(purchases),
          add_to_cart_cost = VALUES(add_to_cart_cost),
          checkout_cost = VALUES(checkout_cost),
          payment_cost = VALUES(payment_cost),
          link_clicks = VALUES(link_clicks),
          unique_link_clicks = VALUES(unique_link_clicks),
          purchase_value = VALUES(purchase_value),
          add_to_cart_count = VALUES(add_to_cart_count),
          initiate_checkout_count = VALUES(initiate_checkout_count),
          add_payment_info_count = VALUES(add_payment_info_count),
          ad_set_id = VALUES(ad_set_id),
          synced_at = VALUES(synced_at),
          timezone_name = VALUES(timezone_name)
      `
      
      // 准备参数数组（按顺序，共 28 个字段，新增 cpc 和 roas）
      const params = values.flatMap(v => [
        v.accountId,
        v.adId,
        v.adName,
        v.status,
        v.ownerId,
        v.spend,
        v.cpc, // 直接从 API 获取
        v.ucpc,
        v.roas, // 优先从 purchase_roas 提取，缺失时计算
        v.cpa,
        JSON.stringify(v.actions), // JSON 字段需要手动序列化
        v.purchases,
        v.addToCartCost,
        v.checkoutCost,
        v.paymentCost,
        // 新增：原始计数字段（方案B+优化版）
        v.linkClicks,
        v.uniqueLinkClicks,
        v.purchaseValue,
        v.addToCartCount,
        v.initiateCheckoutCount,
        v.addPaymentInfoCount,
        v.adSetId, // 广告组ID
        v.syncSessionId,
        v.syncedAt,
        v.timezoneName,
        v.muteUntil,
        v.muteReason,
        v.isSimulation ? 1 : 0 // MySQL 的 BOOLEAN 类型实际是 TINYINT(1)，需要转换为 0/1
      ])
      
      // 执行批量插入
      const [result] = await pool.execute(sql, params)
      const insertedCount = result.affectedRows || 0
      
      console.log(`✅ 成功写入 ${insertedCount} 条记录到数据库`)
      return insertedCount
    }
    
    return 0
  } catch (error) {
    console.error('❌ 写入数据库失败:', error.message)
    throw error
  }
}

/**
 * 解析 Facebook API 响应中的 actions 字段，提取购买次数
 * @param {Array} actions - Facebook API 返回的 actions 数组
 * @returns {number} 购买次数
 */
function parseActions(actions) {
  let purchases = 0
  
  // 如果 actions 不是数组，直接返回 0
  if (!Array.isArray(actions)) {
    return purchases
  }
  
  // 遍历 actions 数组，累加购买次数
  actions.forEach(action => {
    if (!action || !action.action_type) return
    
    // 购买：精确匹配 offsite_conversion.fb_pixel_purchase（避免累加其他包含 purchase 的 action_type）
    if (action.action_type === 'offsite_conversion.fb_pixel_purchase') {
      purchases += parseInt(action.value || 0)
    }
  })
  
  return purchases
}

/**
 * 从 cost_per_action_type 数组中提取指定 action_type 的成本
 * 注意：Facebook API 的"不值不显"原则，如果值为 0 或不存在，字段可能不存在
 * @param {Array} costPerActionType - Facebook API 返回的 cost_per_action_type 数组
 * @param {string|Array<string>} actionTypes - 要查找的 action_type（可以是字符串或数组）
 * @returns {number|null} 成本值，如果不存在则返回 null
 */
function pickCostPerActionType(costPerActionType, actionTypes) {
  // 防御性编程：如果 costPerActionType 不存在或不是数组，返回 null
  if (!costPerActionType || !Array.isArray(costPerActionType)) {
    return null
  }
  
  // 将 actionTypes 转换为数组（如果传入的是字符串）
  const types = Array.isArray(actionTypes) ? actionTypes : [actionTypes]
  
  // 标准化函数：将字符串转为小写，便于匹配
  const normalize = (s) => String(s || '').toLowerCase()
  
  // 遍历 costPerActionType 数组，查找匹配的 action_type
  for (const type of types) {
    const normalizedType = normalize(type)
    
    // 先尝试精确匹配
    const exactMatch = costPerActionType.find(
      item => item && item.action_type && normalize(item.action_type) === normalizedType
    )
    if (exactMatch && exactMatch.value) {
      const value = parseFloat(exactMatch.value)
      return Number.isNaN(value) ? null : value
    }
    
    // 如果精确匹配失败，尝试包含匹配（例如 'purchase' 匹配 'offsite_conversion.fb_pixel_purchase'）
    const containsMatch = costPerActionType.find(
      item => item && item.action_type && normalize(item.action_type).includes(normalizedType)
    )
    if (containsMatch && containsMatch.value) {
      const value = parseFloat(containsMatch.value)
      return Number.isNaN(value) ? null : value
    }
  }
  
  // 如果都没找到，返回 null（而不是 0，因为 Facebook API 可能不返回该字段）
  return null
}

/**
 * 提取 uCPC（独立单次链接点击费用）
 * 注意：Facebook API 可能返回 cost_per_unique_link_click 或 cost_per_unique_inline_link_click
 * @param {Object} insight - Facebook API 返回的 insight 对象
 * @returns {number|null} uCPC 值，如果不存在则返回 null
 */
function extractUcpc(insight) {
  // 优先使用 cost_per_unique_link_click
  if (insight.cost_per_unique_link_click) {
    const value = parseFloat(insight.cost_per_unique_link_click)
    if (!Number.isNaN(value) && value > 0) {
      return value
    }
  }
  
  // 如果 cost_per_unique_link_click 不存在，尝试 cost_per_unique_inline_link_click
  if (insight.cost_per_unique_inline_link_click) {
    const value = parseFloat(insight.cost_per_unique_inline_link_click)
    if (!Number.isNaN(value) && value > 0) {
      return value
    }
  }
  
  // 如果都不存在，返回 null（而不是 0）
  return null
}

/**
 * 提取 ROAS（广告支出回报率）
 * @param {Object} insight - 广告洞察数据
 * @param {number} spend - 花费（用于兜底计算）
 * @param {number} purchaseValue - 购买总金额（用于兜底计算）
 * @returns {number|null} ROAS 值，如果不存在则返回 null
 */
function extractRoas(insight, spend, purchaseValue) {
  // 优先从 purchase_roas 数组中提取（API 直接返回的 ROAS）
  if (insight.purchase_roas && Array.isArray(insight.purchase_roas)) {
    // 查找 omni_purchase 或 offsite_conversion.fb_pixel_purchase 类型的 ROAS
    const roasEntry = insight.purchase_roas.find(item => 
      item.action_type === 'omni_purchase' || 
      item.action_type === 'offsite_conversion.fb_pixel_purchase' ||
      item.action_type === 'purchase'
    )
    if (roasEntry && roasEntry.value != null) {
      return parseFloat(roasEntry.value)
    }
  }
  
  // 降级：从 website_purchase_roas 提取（如果存在）
  if (insight.website_purchase_roas && Array.isArray(insight.website_purchase_roas)) {
    const roasEntry = insight.website_purchase_roas.find(item => 
      item.action_type === 'website_purchase' || 
      item.action_type === 'offsite_conversion.fb_pixel_purchase'
    )
    if (roasEntry && roasEntry.value != null) {
      return parseFloat(roasEntry.value)
    }
  }
  
  // 兜底：通过计算得出（purchase_value / spend）
  if (spend > 0 && purchaseValue > 0) {
    return purchaseValue / spend
  }
  
  return null
}

/**
 * 从 action_values 中提取购买总转化金额（purchase_value）
 * 注意：Facebook API 的 action_values 是数组，需要查找 offsite_conversion.fb_pixel_purchase
 * @param {Array} actionValues - Facebook API 返回的 action_values 数组
 * @returns {number} 购买总转化金额，如果不存在则返回 0
 */
function extractPurchaseValue(actionValues) {
  // 防御性编程：如果 actionValues 不存在或不是数组，返回 0
  if (!actionValues || !Array.isArray(actionValues)) {
    return 0
  }
  
  // 遍历 action_values 数组，查找购买转化金额
  for (const item of actionValues) {
    if (!item || !item.action_type) continue
    
    // 查找购买转化（兼容多种变体）
    const actionType = String(item.action_type || '').toLowerCase()
    if (actionType === 'offsite_conversion.fb_pixel_purchase' || actionType === 'purchase') {
      const value = parseFloat(item.value || 0)
      return Number.isNaN(value) ? 0 : value
    }
  }
  
  // 如果没找到，返回 0（而不是 null，因为这是计数字段，应该有默认值）
  return 0
}

/**
 * 从 actions 数组中提取指定 action_type 的计数
 * 注意：Facebook API 的 actions 是数组，需要查找匹配的 action_type
 * @param {Array} actions - Facebook API 返回的 actions 数组
 * @param {Array<string>} actionTypes - 要查找的 action_type 列表（按优先级排序）
 * @returns {number} 计数，如果不存在则返回 0
 */
function extractActionCount(actions, actionTypes) {
  // 防御性编程：如果 actions 不存在或不是数组，返回 0
  if (!actions || !Array.isArray(actions)) {
    return 0
  }
  
  // 如果 actionTypes 不是数组，转换为数组
  const types = Array.isArray(actionTypes) ? actionTypes : [actionTypes]
  
  // 标准化函数：将字符串转为小写，便于匹配
  const normalize = (s) => String(s || '').toLowerCase()
  
  // 按优先级遍历 actionTypes，找到第一个匹配的
  for (const targetType of types) {
    const normalizedTarget = normalize(targetType)
    
    // 遍历 actions 数组，查找匹配的 action_type
    for (const action of actions) {
      if (!action || !action.action_type) continue
      
      const actionType = normalize(action.action_type)
      
      // 精确匹配
      if (actionType === normalizedTarget) {
        const value = parseInt(action.value || 0)
        return Number.isNaN(value) ? 0 : value
      }
    }
  }
  
  // 如果都没找到，返回 0（而不是 null，因为这是计数字段，应该有默认值）
  return 0
}

// ============================================
// 冷数据落盘：将昨日数据写入 daily_stats
// ============================================

/**
 * 将昨日数据汇总写入 daily_stats 表（冷数据落盘）
 * 重要修正：取每个广告当日的最后快照（不是 SUM），避免重复累计
 * @param {string} accountId - 账户ID（可选，如果为空则处理所有账户）
 * @param {string} timezoneName - 账户时区（如 'Asia/Shanghai'），用于计算"昨日"
 * @param {Date} targetDate - 目标日期（可选，默认是"昨日"）
 * @returns {Promise<Object>} 落盘结果 { success: boolean, archivedCount: number }
 */
export async function archiveDailyStats(accountId = null, timezoneName = 'UTC', targetDate = null) {
  console.log(`📦 开始冷数据落盘...`)
  
  try {
    // 1. 计算目标日期（昨日）- 使用账户时区
    // 注意：必须根据账户时区计算"昨日"自然日边界，而不是服务器时区
    let targetDateTime
    if (targetDate) {
      // 如果提供了目标日期，转换为指定时区的 DateTime
      targetDateTime = DateTime.fromJSDate(targetDate, { zone: timezoneName })
    } else {
      // 否则计算"昨日"（账户时区的昨天）
      const now = DateTime.now().setZone(timezoneName)
      targetDateTime = now.minus({ days: 1 })
    }
    
    // 获取自然日边界（00:00:00）
    const targetDateStart = targetDateTime.startOf('day')
    const targetDateEnd = targetDateTime.endOf('day')
    const dateStr = targetDateTime.toFormat('yyyy-MM-dd') // YYYY-MM-DD
    
    console.log(`📅 目标日期: ${dateStr} (时区: ${timezoneName})`)
    console.log(`📅 时间范围: ${targetDateStart.toISO()} ~ ${targetDateEnd.toISO()}`)
    
    // 2. 查询 ad_snapshots 表中该日期的数据
    // 重要修正：取每个广告当日的最后快照（不是 SUM）
    // 使用 ROW_NUMBER() 窗口函数（MySQL 8.0+）或最大时间戳连接法（兼容方案）
    
    // 先检查 MySQL 版本，决定使用哪种方案
    // 注意：这里简化处理，直接使用 ROW_NUMBER()（如果报错，可以降级到兼容方案）
    let query = `
      SELECT 
        account_id,
        ad_id,
        ad_name,
        ad_set_id,
        owner_id,
        spend,
        purchases,
        link_clicks,
        unique_link_clicks,
        purchase_value,
        add_to_cart_count,
        initiate_checkout_count,
        add_payment_info_count,
        ucpc,
        cpa,
        actions
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY account_id, ad_id 
            ORDER BY synced_at DESC, id DESC
          ) as rn
        FROM ad_snapshots
        WHERE synced_at >= ? AND synced_at <= ?
      ) ranked
      WHERE rn = 1
    `
    
    // 将 Luxon DateTime 转换为 MySQL DATETIME 格式
    const startTime = targetDateStart.toJSDate()
    const endTime = targetDateEnd.toJSDate()
    const params = [startTime, endTime]
    
    if (accountId) {
      query = query.replace('WHERE rn = 1', 'WHERE rn = 1 AND account_id = ?')
      params.push(accountId)
    }
    
    let rows
    try {
      const [result] = await pool.execute(query, params)
      rows = result
    } catch (error) {
      // 如果 ROW_NUMBER() 不支持（非 MySQL 8.0），降级到兼容方案
      if (error.message.includes('ROW_NUMBER') || error.message.includes('syntax')) {
        console.log('⚠️  ROW_NUMBER() 不支持，使用兼容方案（最大时间戳连接法）')
        rows = await queryLastSnapshotCompatible(accountId, startTime, endTime)
      } else {
        throw error
      }
    }
    
    if (!rows || rows.length === 0) {
      console.log(`⚠️  没有找到 ${dateStr} 的数据，跳过落盘`)
      return {
        success: true,
        archivedCount: 0
      }
    }
    
    console.log(`📋 找到 ${rows.length} 条记录需要落盘（最后快照）`)
    
    // 3. 拉取昨日 API 比值字段（cpc），用于单日值入库；缺失时用原始计数兜底计算
    // 注意：roas 不是 Insights API 的有效字段，需要通过计算得出：ROAS = purchase_value / spend
    let yesterdayMap = new Map()
    if (accountId) {
      try {
        const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
        if (accessToken) {
          const facebookApi = new FacebookMarketingAPI(accessToken)
          const adIds = rows.map(r => String(r.ad_id)).filter(Boolean)
          const yInsights = await fetchInsightsInBatches(accountId, adIds, facebookApi, 'yesterday')
          yesterdayMap = new Map(
            yInsights.map(ins => {
              const adId = String(ins.ad_id || '')
              const spend = parseFloat(ins.spend || 0)
              // ROAS 需要通过计算得出：从 action_values 中提取 purchase_value，然后计算
              const purchaseValue = extractPurchaseValue(ins.action_values)
              const roas = spend > 0 ? purchaseValue / spend : 0
              
              return [
                adId,
                {
                  cpc: ins.cpc != null ? parseFloat(ins.cpc) : null,
                  roas: roas > 0 ? roas : null  // 如果计算结果为 0，返回 null
                }
              ]
            }).filter(([k]) => k)
          )
        }
      } catch {}
    }
    
    // 4. 批量写入 daily_stats（移除 CTR/CPM；cpc/roas 单日优先 API 值，缺失用计数兜底）
    const values = rows.map(row => {
      const spend = parseFloat(row.spend || 0)
      const linkClicks = parseInt(row.link_clicks || 0)
      const purchaseValue = parseFloat(row.purchase_value || 0)
      const y = yesterdayMap.get(String(row.ad_id)) || {}
      const cpc = y.cpc != null ? y.cpc : (linkClicks > 0 ? spend / linkClicks : 0)
      const roas = y.roas != null ? y.roas : (spend > 0 ? purchaseValue / spend : 0)
      const addToCart = parseInt(row.add_to_cart_count || 0)
      
      return [
        row.account_id,
        row.ad_id,
        row.ad_name || null,
        row.owner_id,
        dateStr,
        timezoneName,
        spend,
        cpc,
        roas,
        parseInt(row.purchases || 0),
        addToCart,
        row.actions ? (typeof row.actions === 'string' ? row.actions : JSON.stringify(row.actions)) : null,
        parseInt(row.link_clicks || 0),
        parseInt(row.unique_link_clicks || 0),
        purchaseValue,
        parseInt(row.add_to_cart_count || 0),
        parseInt(row.initiate_checkout_count || 0),
        parseInt(row.add_payment_info_count || 0),
        row.ad_set_id || null
      ]
    })
    
    // 使用 ON DUPLICATE KEY UPDATE 更新已存在的记录
    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    
    const sql = `
      INSERT INTO daily_stats (
        account_id, ad_id, ad_name, owner_id, date, timezone_name,
        spend, cpc, roas, purchases, add_to_cart, actions,
        link_clicks, unique_link_clicks, purchase_value,
        add_to_cart_count, initiate_checkout_count, add_payment_info_count,
        ad_set_id
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        ad_name = VALUES(ad_name),
        spend = VALUES(spend),
        cpc = VALUES(cpc),
        roas = VALUES(roas),
        purchases = VALUES(purchases),
        actions = VALUES(actions),
        link_clicks = VALUES(link_clicks),
        unique_link_clicks = VALUES(unique_link_clicks),
        purchase_value = VALUES(purchase_value),
        add_to_cart_count = VALUES(add_to_cart_count),
        initiate_checkout_count = VALUES(initiate_checkout_count),
        add_payment_info_count = VALUES(add_payment_info_count),
        ad_set_id = VALUES(ad_set_id),
        updated_at = NOW()
    `
    
    
    const params2 = values.flat()
    const [result] = await pool.execute(sql, params2)
    const archivedCount = result.affectedRows || 0
    
    console.log(`✅ 冷数据落盘完成，共归档 ${archivedCount} 条记录（使用最后快照）`)
    
    return {
      success: true,
      archivedCount: archivedCount
    }
  } catch (error) {
    console.error('❌ 冷数据落盘失败:', error.message)
    throw error
  }
}

/**
 * 兼容方案：使用最大时间戳连接法取最后快照（适用于非 MySQL 8.0）
 * 参考：方案B+优化版-最终版.md 第十四章
 * @param {string|null} accountId - 账户ID（可选）
 * @param {Date} startTime - 开始时间
 * @param {Date} endTime - 结束时间
 * @returns {Promise<Array>} 最后快照数据
 */
async function queryLastSnapshotCompatible(accountId, startTime, endTime) {
  // 步骤1：取每个广告当日的最大 synced_at（最后快照时间）
  let query1 = `
    SELECT 
      account_id,
      ad_id,
      MAX(synced_at) AS last_synced_at
    FROM ad_snapshots
    WHERE synced_at >= ? AND synced_at <= ?
  `
  const params1 = [startTime, endTime]
  
  if (accountId) {
    query1 += ` AND account_id = ?`
    params1.push(accountId)
  }
  
  query1 += ` GROUP BY account_id, ad_id`
  
  const [lastSnapRows] = await pool.execute(query1, params1)
  
  if (!lastSnapRows || lastSnapRows.length === 0) {
    return []
  }
  
  // 步骤2：用最后时间点连接原表，获取该时间点的完整字段（即"最后快照"的值）
  // 使用子查询 + INNER JOIN，性能更好
  // 注意：如果记录数很多，可以考虑使用临时表，但这里简化处理
  const query2 = `
    SELECT 
      s.account_id,
      s.ad_id,
      s.ad_name,
      s.ad_set_id,
      s.owner_id,
      s.spend,
      s.purchases,
      s.link_clicks,
      s.unique_link_clicks,
      s.purchase_value,
      s.add_to_cart_count,
      s.initiate_checkout_count,
      s.add_payment_info_count,
      s.ucpc,
      s.cpa,
      s.actions
    FROM ad_snapshots s
    INNER JOIN (
      SELECT 
        account_id,
        ad_id,
        MAX(synced_at) AS last_synced_at
      FROM ad_snapshots
      WHERE synced_at >= ? AND synced_at <= ?
      ${accountId ? 'AND account_id = ?' : ''}
      GROUP BY account_id, ad_id
    ) t
    ON s.account_id = t.account_id
    AND s.ad_id = t.ad_id
    AND s.synced_at = t.last_synced_at
  `
  
  const params2 = [startTime, endTime]
  if (accountId) {
    params2.push(accountId)
  }
  
  const [rows] = await pool.execute(query2, params2)
  return rows
}

/**
 * 为所有账户执行冷数据落盘（高频检查版本）
 * 
 * 【核心逻辑】
 * - 每 10 分钟触发一次，检查所有账户
 * - 判断账户本地时区是否在 06:00-06:09 窗口
 * - 如果到达窗口，执行归档（目标日期 = 账户本地时区的"昨日"）
 * - 幂等保护：COUNT(*) 检查 + DB 锁 + 唯一索引
 * 
 * @param {Date} targetDate - 目标日期（可选，默认是"昨日"）
 * @param {boolean} forceAll - 是否强制归档所有账户（用于手动触发，忽略时区窗口）
 * @returns {Promise<Object>} 落盘结果汇总
 */
export async function archiveAllAccountsDailyStats(targetDate = null, forceAll = false) {
  console.log('📦 开始冷数据归档检查（高频检查模式）...')
  console.log(`⏰ 当前服务器时间: ${new Date().toISOString()}`)
  
  try {
    // 1. 从 account_mappings 表获取所有账户列表
    // ⚠️ 注意：account_mappings 表的字段名是 fb_account_id，不是 account_id
    const [accounts] = await pool.query(`
      SELECT DISTINCT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      ORDER BY fb_account_id
    `)
    
    if (!accounts || accounts.length === 0) {
      console.log('⚠️  没有找到活跃账户，跳过归档检查')
      return {
        success: true,
        totalAccounts: 0,
        totalArchivedCount: 0,
        checkedAccounts: 0,
        archivedAccounts: 0,
        skippedAccounts: 0
      }
    }
    
    console.log(`📋 找到 ${accounts.length} 个活跃账户，开始检查归档窗口...`)
    
    // 2. 为每个账户检查归档窗口并执行归档
    let totalArchivedCount = 0
    let archivedAccounts = 0
    let skippedAccounts = 0
    // 跳过原因分类统计（增强观测性）
    let skipReasons = {
      complete: 0,        // 已归档且完整
      incomplete: 0,       // 已归档但不完整（继续补齐）
      lockBusy: 0,        // 锁被占用
      windowNotReached: 0, // 窗口未到
      invalidAccount: 0,   // 无效账户
      error: 0             // 异常失败
    }
    
    for (const account of accounts) {
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        console.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
        skippedAccounts++
        skipReasons.invalidAccount++
        continue
      }
      
      try {
        // 2.1 判断账户本地时区是否在 06:00-06:09 窗口（除非强制归档）
        let shouldArchive = forceAll
        
        if (!forceAll) {
          // 使用 Luxon 将当前时刻转换到账户时区
          const now = DateTime.now()
          const localTime = now.setZone(timezoneName)
          const hour = localTime.hour
          const minute = localTime.minute
          
          // 判断是否在 06:00-06:09 窗口
          shouldArchive = (hour === 6 && minute >= 0 && minute <= 9)
          
          if (!shouldArchive) {
            // 不在归档窗口，跳过（不打印日志，避免日志过多）
            skippedAccounts++
            skipReasons.windowNotReached++
            continue
          }
          
          console.log(`\n🕐 账户 ${accountId} 到达归档窗口`)
          console.log(`   时区: ${timezoneName}`)
          console.log(`   本地时间: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}`)
        } else {
          console.log(`\n🔧 强制归档账户 ${accountId} (时区: ${timezoneName})`)
        }
        
        // 2.2 计算目标日期（账户本地时区的"昨日"）
        const localNow = DateTime.now().setZone(timezoneName)
        const yesterday = localNow.minus({ days: 1 })
        const targetDateStr = yesterday.toFormat('yyyy-MM-dd')
        
        // 计算目标日期的 UTC 时间范围（用于查询 ad_snapshots）
        const targetDateStart = yesterday.startOf('day')
        const targetDateEnd = yesterday.endOf('day')
        const startTime = targetDateStart.toJSDate()
        const endTime = targetDateEnd.toJSDate()
        
        // 2.3 完整性检查：检查是否已归档且完整（修复：不再只检查是否有任意记录）
        // 查询 ad_snapshots 中目标日期的 DISTINCT ad_id 数量（期望归档的广告数）
        const [expectedRows] = await pool.execute(
          `SELECT COUNT(DISTINCT ad_id) as cnt 
           FROM ad_snapshots 
           WHERE account_id = ? AND synced_at >= ? AND synced_at <= ?`,
          [accountId, startTime, endTime]
        )
        const expectedCount = expectedRows[0]?.cnt || 0
        
        // 查询 daily_stats 中目标日期的 DISTINCT ad_id 数量（已归档的广告数）
        const [archivedRows] = await pool.execute(
          `SELECT COUNT(DISTINCT ad_id) as cnt 
           FROM daily_stats 
           WHERE account_id = ? AND date = ?`,
          [accountId, targetDateStr]
        )
        const archivedCount = archivedRows[0]?.cnt || 0
        
        // 只有已归档且完整（archivedCount >= expectedCount）才跳过
        // 如果 expectedCount = 0（当天没有数据），也视为已完成
        const isComplete = expectedCount === 0 || archivedCount >= expectedCount
        
        if (isComplete) {
          if (expectedCount === 0) {
            console.log(`   ✅ 已归档且完整，跳过 (date: ${targetDateStr}, 无数据)`)
          } else {
            console.log(`   ✅ 已归档且完整，跳过 (date: ${targetDateStr}, ${archivedCount}/${expectedCount} 条)`)
          }
          skippedAccounts++
          skipReasons.complete++
          continue
        } else {
          // 已归档但不完整，继续归档补齐（不跳过，继续执行归档）
          const missingCount = expectedCount - archivedCount
          console.log(`   ⚠️  已归档但不完整，继续补齐 (date: ${targetDateStr}, 已归档: ${archivedCount}, 期望: ${expectedCount}, 缺失: ${missingCount})`)
          skipReasons.incomplete++
        }
        
        // 2.4 获取 DB 锁（防止多实例并发）
        const lockName = `archive:${accountId}:${targetDateStr}`
        const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
        const lockAcquired = lockRows[0]?.acquired === 1
        
        if (!lockAcquired) {
          console.log(`   ⏸️  锁已被占用，跳过（可能其他实例正在归档）`)
          skippedAccounts++
          skipReasons.lockBusy++
          continue
        }
        
        try {
          // 2.5 执行归档
          console.log(`   📦 开始归档 (date: ${targetDateStr})`)
          const result = await archiveDailyStats(accountId, timezoneName, targetDate || yesterday.toJSDate())
          const archivedCount = result.archivedCount || 0
          
          totalArchivedCount += archivedCount
          archivedAccounts++
          
          console.log(`   ✅ 归档完成，共 ${archivedCount} 条记录`)
        } finally {
          // 2.6 释放锁（无论成功或失败都要释放）
          try {
            await pool.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
          } catch (lockError) {
            // 锁释放失败不影响主流程，只记录警告
            console.warn(`   ⚠️  释放锁失败: ${lockError.message}`)
          }
        }
      } catch (error) {
        console.error(`   ❌ 账户 ${accountId} 归档失败:`, error.message)
        skippedAccounts++
        skipReasons.error++
        // 继续处理下一个账户，不中断整个流程
      }
    }
    
    console.log('\n' + '='.repeat(50))
    console.log(`✅ 归档检查完成`)
    console.log(`📊 统计:`)
    console.log(`   - 检查账户: ${accounts.length}`)
    console.log(`   - 归档账户: ${archivedAccounts}`)
    console.log(`   - 跳过账户: ${skippedAccounts}`)
    console.log(`   - 归档记录: ${totalArchivedCount} 条`)
    console.log(`📊 跳过原因分类:`)
    console.log(`   - 已归档且完整: ${skipReasons.complete} 个`)
    console.log(`   - 已归档但不完整（已补齐）: ${skipReasons.incomplete} 个`)
    console.log(`   - 锁被占用: ${skipReasons.lockBusy} 个`)
    console.log(`   - 窗口未到: ${skipReasons.windowNotReached} 个`)
    console.log(`   - 无效账户: ${skipReasons.invalidAccount} 个`)
    console.log(`   - 异常失败: ${skipReasons.error} 个`)
    console.log('='.repeat(50))
    
    return {
      success: true,
      totalAccounts: accounts.length,
      totalArchivedCount: totalArchivedCount,
      checkedAccounts: accounts.length,
      archivedAccounts: archivedAccounts,
      skippedAccounts: skippedAccounts
    }
  } catch (error) {
    console.error('❌ 归档检查失败:', error.message)
    throw error
  }
}

// ============================================
// 导出所有函数
// ============================================

export {
  generateSyncSessionId,
  fetchInsightsInBatches,
  saveSnapshotsToDb,
  parseActions,
  pickCostPerActionType,
  extractUcpc,
  extractPurchaseValue,
  extractActionCount
}


