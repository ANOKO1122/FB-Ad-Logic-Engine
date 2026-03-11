// Data Ingestor 服务 - 数据同步服务
// 按照 DEV_PLAN.md M2 的要求实现
// 负责从 Facebook API 拉取广告数据并存入数据库

import logger from '../utils/logger.js'
import { FacebookMarketingAPI } from '../index.js'
import { db } from '../db/drizzle.js'
import { adSnapshots } from '../db/schema.js'
import pool from '../db/connection.js'
import { eq, and, gte } from 'drizzle-orm'
import { DateTime } from 'luxon'
import pLimit from 'p-limit'
import { 
  parseUsageHeader, 
  sleepBasedOnUsage,
  getCircuitBreakerStatus
} from './rateLimitService.js'
import { piggybackStructureFromToday, runPseudoIncrementForAccount } from './structureSyncService.js'

// ============================================
// 受控并发配置（M2 阶段：并发度 = 6）
// 依据：TASKS.md 1.3 + DEV_PLAN.md 4.3
// ============================================
// 限制同一时刻并发运行的账户任务数量为 6（降低代理瞬时压力，缓解 TLS early disconnect）
// 适用于：Today 热同步、冷路径双窗口归档、last_7d / last_14d 回补等所有账户级任务
// 注意：如果出现 429 限流错误，可再降到 4；若代理稳定，可提高到 8
const CONCURRENT_LIMIT = 6
const accountTaskLimiter = pLimit(CONCURRENT_LIMIT)

// ============================================
// 写入时兜底：从 structure_ads 补齐 campaign_id / adset_id
// 结构镜像表为关系真相源，事实表需可靠维度键，避免按 campaign 解析目标为 0
// ============================================
/**
 * 从 structure_ads 补齐 items 中缺失的 campaign_id / adset_id（不增加 FB API 调用）
 * 注意：补齐到 item.adset_id / item.campaign_id，写入层会用 insight.adset_id → DB 列 ad_set_id。
 * @param {string} accountId
 * @param {Array<{ ad_id: string, campaign_id?: string, adset_id?: string }>} items - 会被原地修改
 */
const STRUCTURE_FILL_BATCH_SIZE = 500

async function fillCampaignAdsetFromStructure(accountId, items) {
  if (!items?.length) return
  const needFill = items.filter(
    i => (i.campaign_id == null || i.campaign_id === '') || (i.adset_id == null || i.adset_id === '')
  )
  if (needFill.length === 0) return
  const adIds = [...new Set(needFill.map(i => String(i.ad_id || '')).filter(Boolean))]
  if (adIds.length === 0) return
  try {
    const map = new Map()
    for (let i = 0; i < adIds.length; i += STRUCTURE_FILL_BATCH_SIZE) {
      const batch = adIds.slice(i, i + STRUCTURE_FILL_BATCH_SIZE)
      const placeholders = batch.map(() => '?').join(',')
      const [rows] = await pool.execute(
        `SELECT ad_id, adset_id, campaign_id FROM structure_ads WHERE account_id = ? AND ad_id IN (${placeholders})`,
        [accountId, ...batch]
      )
      for (const r of rows) {
        map.set(String(r.ad_id), { adset_id: r.adset_id ?? null, campaign_id: r.campaign_id ?? null })
      }
    }
    for (const item of needFill) {
      const m = map.get(String(item.ad_id))
      if (m) {
        if (item.campaign_id == null || item.campaign_id === '') item.campaign_id = m.campaign_id
        if (item.adset_id == null || item.adset_id === '') item.adset_id = m.adset_id
      }
    }
    if (map.size > 0) {
      logger.debug(`[structure_ads 兜底] 补齐 ${map.size} 条 campaign_id/adset_id (account=${accountId})`)
    }
  } catch (err) {
    logger.warn('fillCampaignAdsetFromStructure 查询 structure_ads 失败，跳过补齐:', err.message)
  }
}

// ============================================
// 写入队列（AdsPolar 解耦架构实现）
// 解决数据库死锁问题：多采集，单写入
// ============================================
// 【AdsPolar 策略】
// 1. 采集器（Fetcher）：只负责从 Facebook API 拉数据，不写数据库
// 2. 写入队列（Buffer Queue）：内存队列，临时存储待写入数据
// 3. 写入器（Writer）：单线程串行写入，避免死锁
//
// 【优势】
// ✅ 彻底解决死锁：同一时间只有一个数据库连接在执行写入
// ✅ 提高性能：数据库喜欢"少次多量"的批量写入
// ✅ 解耦采集和写入：采集不会被写入阻塞
//
// 【劣势】
// ⚠️  进程崩溃会丢失队列数据（但采集可以重试）
// ⚠️  需要额外的内存空间（但通常很小）
const writeQueue = []
let isWriting = false
let writeStats = {
  totalQueued: 0,
  totalWritten: 0,
  totalErrors: 0
}

/**
 * 将数据推入写入队列（非阻塞）
 * @param {string} type - 写入类型：'SNAPSHOT' 或 'STATS'
 * @param {Array} data - 待写入的数据
 * @param {Object} metadata - 元数据（accountId, ownerId, syncSessionId, syncedAt, timezoneName）
 */
function enqueueWrite(type, data, metadata = {}) {
  if (!data || data.length === 0) {
    return
  }
  
  writeQueue.push({
    type, // 'SNAPSHOT' 或 'STATS'
    data,
    metadata,
    timestamp: Date.now()
  })
  
  writeStats.totalQueued += data.length
  
  // 触发写入处理器（非阻塞）
  processWriteQueue().catch(error => {
    logger.error('❌ 写入队列处理失败:', error.message)
    writeStats.totalErrors++
  })
}

/**
 * 写入处理器：串行消费队列，永不打架
 * 使用单线程串行写入，彻底避免死锁
 * 
 * 【手段3：错误隔离】防止"一粒老鼠屎坏了一锅粥"
 * - 每条数据错误都被捕获，不会导致整个队列卡死
 * - 错误记录到日志，便于事后排查
 * 
 * @param {boolean} emergencyMode - 紧急模式（优雅退出时使用），忽略流控，强制写入
 */
async function processWriteQueue(emergencyMode = false) {
  // 如果正在写，就等着，别插手（避免并发写入）
  // 紧急模式除外：优雅退出时需要强制写入
  if (isWriting && !emergencyMode) {
    return
  }
  
  isWriting = true
  
  try {
    while (writeQueue.length > 0) {
      const task = writeQueue.shift() // 取出一个任务（FIFO）
      
      try {
        // 执行真正的数据库写入
        if (task.type === 'SNAPSHOT') {
          await saveSnapshotsToDbInternal(task.data, task.metadata)
        } else if (task.type === 'STATS') {
          // TODO: 实现 daily_stats 的队列写入
          logger.warn('⚠️  daily_stats 队列写入尚未实现')
        }
        
        writeStats.totalWritten += task.data.length
      } catch (error) {
        // 【手段3：错误隔离】捕获错误，不要让它抛出导致进程崩溃！
        logger.error(`❌ 写入队列任务失败 (${task.type}):`, error.message)
        writeStats.totalErrors++
        
        // 记录错误详情（便于事后排查）
        // 注意：不打印完整数据，避免日志过大
        const dataSample = task.data && task.data.length > 0 
          ? { accountId: task.metadata?.accountId, adCount: task.data.length, firstAdId: task.data[0]?.ad_id }
          : null
        logger.error(`   错误详情:`, {
          error: error.message,
          type: task.type,
          dataSample,
          timestamp: new Date().toISOString()
        })
        
        // 注意：这里不重新入队，避免无限循环
        // 【手段2：自愈性】如果写入失败，采集器可以重试（下一轮同步会自动补回）
      }
      
      // 紧急模式：不休息，快速写入（优雅退出时使用）
      if (!emergencyMode) {
        // 稍微休息一下，让出 CPU 给 API 请求（避免阻塞事件循环）
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  } catch (error) {
    // 【手段3：错误隔离】外层错误也要捕获，防止进程崩溃
    logger.error('❌ 写入队列处理出错:', error.message)
    writeStats.totalErrors++
  } finally {
    isWriting = false // 释放锁
  }
}

// ============================================
// 重试机制配置
// ============================================
// 重试延迟配置（指数退避）
const RETRY_DELAY_BASE_MS = 60000  // 基础延迟：60秒（Facebook限流通常需要1-2分钟恢复）
const RETRY_MAX_ATTEMPTS = 2       // 最大重试次数：2次（总共尝试3次：初始1次 + 重试2次）

// 账户级别限流保护（内存缓存）
// 记录每个账户的最后调用时间，避免短时间内重复调用
const accountLastCallTime = new Map()  // accountId -> timestamp
const ACCOUNT_COOLDOWN_MS = 120000     // 账户冷却期：120秒（2分钟），避免同一账户在短时间内被多次调用

/**
 * 判断错误是否为可重试的错误（API限流）
 * @param {Error|string} error - 错误对象或错误消息
 * @returns {boolean} 是否为可重试的错误
 */
function isRetryableError(error) {
  const errorMessage = error?.message || String(error || '').toLowerCase()
  return (
    errorMessage.includes('too many calls') ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('rate limiting') ||
    errorMessage.includes('429') ||
    errorMessage.includes('throttle')
  )
}

/**
 * 检查账户是否在冷却期内（账户级别限流保护）
 * @param {string} accountId - 账户ID
 * @returns {boolean} 是否在冷却期内
 */
function isAccountInCooldown(accountId) {
  const lastCallTime = accountLastCallTime.get(accountId)
  if (!lastCallTime) {
    return false
  }
  const elapsed = Date.now() - lastCallTime
  return elapsed < ACCOUNT_COOLDOWN_MS
}

/**
 * 记录账户调用时间（账户级别限流保护）
 * @param {string} accountId - 账户ID
 */
function recordAccountCall(accountId) {
  accountLastCallTime.set(accountId, Date.now())
  
  // 定期清理过期记录（避免内存泄漏）
  // 只保留最近1小时的记录
  const oneHourAgo = Date.now() - 3600000
  for (const [id, time] of accountLastCallTime.entries()) {
    if (time < oneHourAgo) {
      accountLastCallTime.delete(id)
    }
  }
}

/**
 * 计算指数退避延迟时间
 * @param {number} attempt - 重试次数（从1开始）
 * @returns {number} 延迟时间（毫秒）
 */
function calculateBackoffDelay(attempt) {
  // 指数退避：第1次重试60秒，第2次重试120秒
  return RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1)
}

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
/**
 * @param {string} accountId
 * @param {number} ownerId
 * @param {string|null} timezoneName
 * @param {import('../index.js').FacebookMarketingAPI|null} [facebookApi] - 可选，传入时复用（如心跳内同轮做 Piggyback 用同一实例）
 */
export async function syncAccountTodayStats(accountId, ownerId, timezoneName = null, facebookApi = null) {
  // 记录账户调用时间（账户级别限流保护）
  recordAccountCall(accountId)

  logger.info(`🔄 开始同步账户 ${accountId} 的今日数据...`)

  // 检查 Token 熔断器状态
  const breakerStatus = getCircuitBreakerStatus()
  if (breakerStatus.isLocked) {
    throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
  }

  try {
    // 1. 生成唯一的 sync_session_id（时间戳 + 随机串）
    const syncSessionId = generateSyncSessionId()
    const syncedAt = new Date()

    // 2. Facebook API 客户端（可选传入，同轮心跳可复用以便 Piggyback 不再新建）
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      throw new Error('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
    }
    if (!facebookApi) {
      facebookApi = new FacebookMarketingAPI(accessToken)
    }
    
    // 3. 获取账户时区（AdsPolar策略：时区是静态数据，优先使用数据库缓存）
    // 【优化】优先使用数据库中的时区，只有在数据库中没有时才去API查询
    // 如果API查询失败，不更新数据库，保持原有时区（避免错误覆盖）
    if (!timezoneName || timezoneName === 'UTC') {
      // 如果数据库中没有时区，才去API查询
      logger.info(`📡 数据库中没有时区配置，从 Facebook API 获取账户 ${accountId} 的时区...`)
      try {
    const apiTimezone = await facebookApi.getAccountTimezone(accountId)
        if (apiTimezone && apiTimezone !== 'UTC') {
    logger.info(`✅ 账户 ${accountId} 时区（从 API 获取）: ${apiTimezone}`)
          // 更新数据库
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        logger.info(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        logger.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
          timezoneName = apiTimezone
        } else {
          // API返回UTC或失败，使用默认值
          timezoneName = apiTimezone || 'UTC'
          logger.info(`⚠️  API返回时区为UTC或失败，使用默认值: ${timezoneName}`)
        }
      } catch (error) {
        // API查询失败，不更新数据库，使用传入的时区或默认UTC
        logger.warn(`⚠️  获取账户 ${accountId} 时区失败，使用数据库时区或默认UTC:`, error.message)
        timezoneName = timezoneName || 'UTC'
        // 不更新数据库，避免错误覆盖
      }
    } else {
      // 数据库中有时区，直接使用（AdsPolar策略：时区是静态数据，不需要每次查询）
      logger.info(`✅ 使用数据库中的时区: ${timezoneName}`)
    }
    
    // 4. 【AdsPolar策略：Insights First - 标准实现】
    // 第1步：API 嗅探（Discovery Phase）
    // 直接向 Facebook 发起一次"广撒网"的 Insights 请求，不指定 ad_id
    // 这样可以捕获所有今天花了钱的广告（包括新广告），避免"鸡生蛋"问题
    logger.info(`📡 从 Facebook API 查询账户 ${accountId} 的 insights（Today，不指定 ad_id，Insights First策略）...`)

    let insights = []
    let activeAdIds = []
    let structurePayload = {}
    try {
      // 直接从 API 查询 insights（不指定 ad_id），Facebook 会返回账户下所有广告的 insights
      // 优先在 FB 端通过 filtering 做 spend>0 源头过滤（可通过 DISABLE_SPEND_FILTERING 回退到纯本地过滤）
      insights = await facebookApi.getAdInsights(accountId, {
        preset: 'today'
      }, {
        level: 'ad',
        useAccountAttributionSetting: true,
        spendGreaterThanZero: true
      })
      
      // 本地仍保留 spend>0 过滤作为兜底，防止 filtering 失效或被关闭时写入 0 花费快照
      insights = insights.filter(insight => {
        const spend = parseFloat(insight.spend || 0)
        return spend > 0
      })
      
      if (insights.length === 0) {
        logger.info(`⚠️  账户 ${accountId} 没有 spend>0 的广告（API 查询结果），跳过同步`)
        return {
          success: true,
          syncedCount: 0,
          sessionId: syncSessionId,
          activeAdIds: [],
          structurePayload: {}
        }
      }

      // 提取活跃广告 ID 列表（去重）
      activeAdIds = [...new Set(insights.map(insight => String(insight.ad_id || '')).filter(id => id))]
      logger.info(`✅ 从 API 查询到 ${insights.length} 条 spend>0 的广告数据，${activeAdIds.length} 个唯一广告ID`)

      // 第2步：元数据补全（同一轮只调用一次 resolveObjectsByIds，供 status 落盘 + Piggyback 写 structure_ads 复用）
      const STRUCTURE_FIELDS = 'id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time'
      const statusMap = new Map()

      if (activeAdIds.length > 0) {
        logger.info(`📋 批量解析活跃广告元数据（${activeAdIds.length} 个，同轮仅此一次 resolve）...`)
        const allAdsWithStructure = await facebookApi.resolveObjectsByIds(activeAdIds, { fields: STRUCTURE_FIELDS })
        allAdsWithStructure.forEach(ad => {
          const adId = String(ad.id || '')
          if (!adId) return
          statusMap.set(adId, ad.effective_status || ad.status || null)
          structurePayload[adId] = {
            name: ad.name ?? '',
            effective_status: ad.effective_status ?? null,
            status: ad.status ?? null,
            configured_status: ad.configured_status ?? null,
            adset_id: ad.adset_id ?? null,
            campaign_id: ad.campaign_id ?? null,
            updated_time: ad.updated_time ?? null,
            created_time: ad.created_time ?? null
          }
        })
      }

      // 合并广告状态与结构字段到 insights（供落盘 ad_snapshots 时带齐 campaign_id/adset_id）
      // Insights API 有时不返回或丢失 campaign_id，用 resolve 结果兜底，确保「按广告系列」规则能匹配到广告
      insights.forEach(insight => {
        const adId = String(insight.ad_id || '')
        if (statusMap.has(adId)) insight.status = statusMap.get(adId)
        const payload = structurePayload[adId]
        if (payload) {
          if (payload.campaign_id != null) insight.campaign_id = payload.campaign_id
          if (payload.adset_id != null) insight.adset_id = payload.adset_id
        }
      })
      // 写入时兜底：若仍有 campaign_id/adset_id 为空，从 structure_ads 补齐（不增加 FB 调用）
      await fillCampaignAdsetFromStructure(accountId, insights)
    } catch (error) {
      logger.error(`❌ API 嗅探失败: ${error.message}`)
      return {
        success: false,
        syncedCount: 0,
        sessionId: syncSessionId,
        error: error.message,
        activeAdIds: [],
        structurePayload: {}
      }
    }
    
    // 第3步：数据落盘（AdsPolar 队列策略）
    // 不直接写数据库，而是推入写入队列，由串行写入器统一处理
    // 这样可以彻底避免死锁问题
    logger.info(`📤 推入写入队列，共 ${insights.length} 条记录（全部为 spend>0）...`)
    
    enqueueWrite('SNAPSHOT', insights, {
      accountId,
      ownerId,
      syncSessionId,
      syncedAt,
      timezoneName
    })
    
    // 注意：队列写入是异步的，这里返回的是入队数量，不是实际写入数量
    // 实际写入数量由队列写入器处理
    const syncedCount = insights.length
    
    logger.info(`✅ 账户 ${accountId} 同步完成，会话ID: ${syncSessionId}，共同步 ${syncedCount} 条记录`)

    return {
      success: true,
      syncedCount: syncedCount,
      sessionId: syncSessionId,
      activeAdIds: activeAdIds || [],
      structurePayload: structurePayload || {}
    }
  } catch (error) {
    logger.error(`❌ 同步账户 ${accountId} 失败:`, error.message)
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
  logger.info(`📅 按日拉取数据: ${sinceDate} ~ ${untilDate}，共 ${adIds.length} 个广告`)
  
  if (!adIds || adIds.length === 0) {
    return []
  }
  
  const BATCH_SIZE = 50  // Facebook Batch API 最多支持 50 个子请求/批
  const adIdChunks = chunkArray(adIds, BATCH_SIZE)
  const allDailyInsights = []
  
  // 写库语义（方案A）：不持久化派生值（如 cpc/roas 本地计算）；roas 仅存 API 兜底字段
  // 因此 fields 中不再请求 cpc，且同时请求 purchase_roas + website_purchase_roas 作为兜底来源
  const fields = 'ad_id,ad_name,adset_id,spend,actions,action_values,unique_actions,cost_per_action_type,cost_per_unique_link_click,cost_per_unique_inline_link_click,inline_link_clicks,unique_inline_link_clicks,purchase_roas,website_purchase_roas'
  const useAccountAttributionSetting = 'true'
  
  // 遍历每个批次
  for (let i = 0; i < adIdChunks.length; i++) {
    const chunk = adIdChunks[i]
    logger.info(`📦 处理第 ${i + 1}/${adIdChunks.length} 批，共 ${chunk.length} 个广告`)
    
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
        logger.error(`❌ Batch API 请求失败:`, responseData.error)
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
              logger.warn(`⚠️  广告 ${adId} 拉取失败:`, bodyData.error.message)
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
          logger.error(`❌ 解析广告 ${chunk[index]} 的响应失败:`, parseError.message)
        }
      })
    } catch (error) {
      logger.error(`❌ 第 ${i + 1} 批请求失败:`, error.message)
      continue
    }
  }
  
  logger.info(`✅ 按日拉取完成，共获取 ${allDailyInsights.length} 条按日数据`)
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
  // 写入时兜底：若 API 未带 campaign_id/adset_id，从 structure_ads 补齐
  await fillCampaignAdsetFromStructure(accountId, dailyInsights)

  logger.info(`💾 开始更新 daily_stats 表，共 ${dailyInsights.length} 条按日数据`)
  
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
    
    // P0：口径正确。link_clicks 仅用 inline_link_clicks / actions，绝不 fallback 到 clicks（全部点击）
    const rawLink = (insight.inline_link_clicks != null && insight.inline_link_clicks !== '') ? parseInt(insight.inline_link_clicks) : NaN
    const fromActions = extractActionCount(actions, ['link_click', 'inline_link_click'])
    const linkClicks = !Number.isNaN(rawLink) ? rawLink : (fromActions > 0 ? fromActions : 0)
    const rawUnique = (insight.unique_inline_link_clicks != null && insight.unique_inline_link_clicks !== '') ? parseInt(insight.unique_inline_link_clicks) : NaN
    const uniqueFromActions = extractActionCount(insight.unique_actions || [], ['link_click', 'inline_link_click'])
    const uniqueLinkClicks = !Number.isNaN(rawUnique) ? rawUnique : (uniqueFromActions > 0 ? uniqueFromActions : 0)
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
    
    // 方案A写库语义对齐：不持久化派生平均值（cpc/roas 本地计算），只存 API 兜底 roas 或 null
    const spend = parseFloat(insight.spend || 0)
    const cpc = null
    const roas = extractApiRoas(insight)
    
    return [
      accountId,
      String(insight.ad_id || ''),
      insight.ad_name || null,
      ownerId,
      insight.date_start || insight.date,  // 优先事件自然日 date_start，统一口径
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
      insight.adset_id ? String(insight.adset_id) : null,
      insight.campaign_id ? String(insight.campaign_id) : null
    ]
  })
  
  // 使用 ON DUPLICATE KEY UPDATE 更新 daily_stats
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  
  const sql = `
    INSERT INTO daily_stats (
      account_id, ad_id, ad_name, owner_id, date, timezone_name,
      spend, cpc, roas, purchases, add_to_cart, actions,
      link_clicks, unique_link_clicks, purchase_value,
      add_to_cart_count, initiate_checkout_count, add_payment_info_count,
      ad_set_id, campaign_id
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
      ad_set_id = COALESCE(VALUES(ad_set_id), ad_set_id),
      campaign_id = COALESCE(VALUES(campaign_id), campaign_id),
      updated_at = NOW()
  `
  
  const params = values.flat()
  const [result] = await pool.execute(sql, params)
  const updatedCount = result.affectedRows || 0
  
  logger.info(`✅ 成功更新 ${updatedCount} 条记录到 daily_stats 表`)
  return updatedCount
}

/**
 * 筛选近 N 天内有 spend>0 的广告（AdsPolar策略：Insights First）
 * 【AdsPolar策略】直接从数据库查询活跃广告ID，不依赖传入的 adIds 列表
 * 这样可以避免先调用 /ads 接口拉取所有广告（包括废弃的），大幅减少API配额消耗
 * @param {string} accountId - 账户ID
 * @param {Array<string>} adIds - 所有广告ID列表（已废弃，不再使用，保留参数以兼容旧代码）
 * @param {string} timezoneName - 账户时区
 * @param {number} daysBack - 回溯天数（默认 7 天）
 * @returns {Promise<Array<string>>} 筛选后的广告ID列表（只包含 spend>0 的广告）
 */
async function filterActiveAds(accountId, adIds, timezoneName, daysBack = 7) {
  // 【AdsPolar策略】不再依赖传入的 adIds，直接从数据库查询活跃广告
  // 这样可以避免先调用 /ads 接口拉取所有广告（包括废弃的）
  
  try {
    // 计算日期范围（账户时区）
    const now = DateTime.now().setZone(timezoneName)
    const sinceDate = now.minus({ days: daysBack }).toFormat('yyyy-MM-dd')
    const untilDate = now.toFormat('yyyy-MM-dd')  // 包含今天
    
    // 查询 daily_stats 和 ad_snapshots，找出近 N 天内有 spend>0 的广告
    // 【严格筛选】只筛选 spend>0，不包含其他条件
    const [rows] = await pool.query(`
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
    
    const activeAdIds = rows.map(row => String(row.ad_id))
    
    // 【AdsPolar策略】严格模式：只返回活跃广告，无论数量多少
    // 如果查询到活跃广告，就返回活跃广告列表（即使数量很多，也只拉取这些）
    // 如果没有活跃广告，返回空列表（不拉取任何广告）
    if (activeAdIds.length > 0) {
      logger.info(`📊 从数据库查询到 ${activeAdIds.length} 个活跃广告（近 ${daysBack} 天内有 spend>0）`)
      return activeAdIds
    } else {
      // 没有活跃广告，返回空列表（不拉取任何广告）
      logger.info(`📊 数据库中没有活跃广告（近 ${daysBack} 天内无 spend>0），跳过拉取`)
      return []
    }
  } catch (error) {
    // 查询失败时，为了安全起见，返回空列表（不拉取任何广告）
    // 避免因为查询失败而拉取所有广告，导致 API 配额浪费
    logger.warn(`⚠️  筛选活跃广告失败，返回空列表（安全策略）:`, error.message)
    return []
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
  logger.info(`🔄 开始刷新账户 ${accountId} 的历史时区...`)
  
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
    
    logger.info(`📋 目标时区: ${timezoneName}`)
    
    // 2. 统计需要更新的记录数
    const [countRows] = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM daily_stats
      WHERE account_id = ? AND timezone_name != ?
    `, [accountId, timezoneName])
    
    const needUpdateCount = countRows[0]?.cnt || 0
    
    if (needUpdateCount === 0) {
      logger.info(`✅ 账户 ${accountId} 的历史时区已一致，无需更新`)
      return {
        success: true,
        updatedCount: 0
      }
    }
    
    logger.info(`📊 需要更新 ${needUpdateCount} 条记录`)
    
    // 3. 批量更新 timezone_name
    const [result] = await pool.execute(`
      UPDATE daily_stats
      SET timezone_name = ?, updated_at = NOW()
      WHERE account_id = ? AND timezone_name != ?
    `, [timezoneName, accountId, timezoneName])
    
    const updatedCount = result.affectedRows || 0
    
    logger.info(`✅ 账户 ${accountId} 的历史时区刷新完成，共更新 ${updatedCount} 条记录`)
    
    return {
      success: true,
      updatedCount: updatedCount
    }
  } catch (error) {
    logger.error(`❌ 刷新账户 ${accountId} 历史时区失败:`, error.message)
    throw error
  }
}

/**
 * 同步单个账户的滑动窗口数据（AdsPolar策略：Insights First）
 * 【核心改进】严格按自然日语义：
 * - today 数据写入 ad_snapshots（实时快照）
 * - 过去 N 天的按日数据更新到 daily_stats（修复迟到归因）
 * 
 * 【AdsPolar策略优化】
 * 1. 时区获取：优先使用数据库中的时区，只有在数据库中没有时才去API查询
 * 2. 广告筛选：直接从数据库查询活跃广告ID，不先调用 /ads 接口
 * 3. Insights First：只拉取活跃广告的 insights，不拉取废弃广告
 * 
 * @param {string} accountId - Facebook 账户ID（字符串格式）
 * @param {number} ownerId - 负责人ID（用于数据隔离）
 * @param {string} timezoneName - 账户时区（如 'Asia/Shanghai'，优先使用数据库中的时区）
 * @param {number} daysBack - 回溯天数（默认 7 天）
 * @param {boolean} optimizeQuota - 是否优化配额（已废弃，现在总是启用，保留参数以兼容旧代码）
 * @returns {Promise<Object>} 同步结果 { success: boolean, todayCount: number, dailyStatsCount: number, sessionId: string }
 */
export async function syncAccountSlidingWindow(accountId, ownerId, timezoneName = 'UTC', daysBack = 7, optimizeQuota = false) {
  logger.info(`🔄 开始同步账户 ${accountId} 的滑动窗口数据（修复归因延迟）...`)
  
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
    
    // 3. 获取账户时区（AdsPolar策略：时区是静态数据，优先使用数据库缓存）
    // 【优化】优先使用数据库中的时区，只有在数据库中没有时才去API查询
    // 如果API查询失败，不更新数据库，保持原有时区（避免错误覆盖）
    if (!timezoneName || timezoneName === 'UTC') {
      // 如果数据库中没有时区，才去API查询
      logger.info(`📡 数据库中没有时区配置，从 Facebook API 获取账户 ${accountId} 的时区...`)
      try {
    const apiTimezone = await facebookApi.getAccountTimezone(accountId)
        if (apiTimezone && apiTimezone !== 'UTC') {
    logger.info(`✅ 账户 ${accountId} 时区（从 API 获取）: ${apiTimezone}`)
          // 更新数据库
      try {
        await pool.execute(
          `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
          [apiTimezone, accountId]
        )
        logger.info(`✅ 已更新 account_mappings.timezone_name = ${apiTimezone}`)
      } catch (updateError) {
        logger.warn(`⚠️  更新 account_mappings.timezone_name 失败:`, updateError.message)
      }
    timezoneName = apiTimezone
        } else {
          // API返回UTC或失败，使用默认值
          timezoneName = apiTimezone || 'UTC'
          logger.info(`⚠️  API返回时区为UTC或失败，使用默认值: ${timezoneName}`)
        }
      } catch (error) {
        // API查询失败，不更新数据库，使用传入的时区或默认UTC
        logger.warn(`⚠️  获取账户 ${accountId} 时区失败，使用数据库时区或默认UTC:`, error.message)
        timezoneName = timezoneName || 'UTC'
        // 不更新数据库，避免错误覆盖
      }
    } else {
      // 数据库中有时区，直接使用（AdsPolar策略：时区是静态数据，不需要每次查询）
      logger.info(`✅ 使用数据库中的时区: ${timezoneName}`)
    }
    
    // 4. 【AdsPolar策略：Insights First】直接从数据库查询活跃广告ID，不先调用 /ads 接口
    logger.info(`📋 从数据库查询活跃广告ID（近 ${daysBack} 天内有 spend>0）...`)
    let targetAdIds = await filterActiveAds(accountId, [], timezoneName, daysBack)
    
      if (targetAdIds.length === 0) {
        logger.info(`⚠️  没有找到活跃广告，跳过滑动窗口同步`)
        return {
          success: true,
          todayCount: 0,
          dailyStatsCount: 0,
          sessionId: syncSessionId
        }
    }
    
    logger.info(`📊 从数据库查询到 ${targetAdIds.length} 个活跃广告（近 ${daysBack} 天内有 spend>0）`)
    
    // 6. 获取广告状态（优化：只获取目标广告的状态，使用批量查询 API）
    logger.info(`📋 获取账户 ${accountId} 的目标广告状态（批量查询，${targetAdIds.length} 个）...`)
    // 使用 resolveObjectsByIds 批量查询，避免拉取所有广告（包括废弃的）
    const adsWithStatus = await facebookApi.resolveObjectsByIds(targetAdIds, {
      fields: 'id,name,effective_status,status,configured_status'
    })
    const statusMap = new Map()
    adsWithStatus.forEach(ad => {
      const adId = String(ad.id || '')
      const status = ad.effective_status || ad.status || null
      if (adId) {
        statusMap.set(adId, status)
      }
    })
    
    // 7. 同步 Today 数据 → 写入 ad_snapshots（实时快照）
    logger.info(`📅 同步 Today 数据 → ad_snapshots...`)
    const todayInsights = await fetchInsightsInBatches(accountId, targetAdIds, facebookApi, 'today')
    
    // 过滤：只保留 spend > 0 的广告（性能优化）
    const filteredTodayInsights = todayInsights.filter(insight => {
      const spend = parseFloat(insight.spend || 0)
      return spend > 0
    })
    
    if (filteredTodayInsights.length === 0) {
      logger.info(`⚠️  Today 数据中没有 spend > 0 的广告，跳过写入`)
    } else {
      logger.info(`📊 Today 过滤结果: ${todayInsights.length} → ${filteredTodayInsights.length} (只保留 spend > 0)`)
    }
    
    // 合并广告状态到 today 数据
    filteredTodayInsights.forEach(insight => {
      const adId = String(insight.ad_id || '')
      if (statusMap.has(adId)) {
        insight.status = statusMap.get(adId)
      }
    })
    
    // 写入 ad_snapshots（只存 today 数据）
    const todayCount = await saveSnapshotsToDb(filteredTodayInsights, accountId, ownerId, syncSessionId, syncedAt, timezoneName)
    logger.info(`✅ Today 数据已写入 ad_snapshots，共 ${todayCount} 条记录`)
    
    // 8. 同步过去 N 天的按日数据 → 更新 daily_stats（修复迟到归因）
    logger.info(`📅 同步过去 ${daysBack} 天的按日数据 → daily_stats...`)
    
    // 计算日期范围（账户时区）
    const now = DateTime.now().setZone(timezoneName)
    const untilDate = now.minus({ days: 1 }).toFormat('yyyy-MM-dd')  // 昨天（不包含今天）
    const sinceDate = now.minus({ days: daysBack }).toFormat('yyyy-MM-dd')  // N 天前
    
    logger.info(`📅 日期范围: ${sinceDate} ~ ${untilDate} (账户时区: ${timezoneName})`)
    
    // 拉取按日数据（使用筛选后的广告列表）
    const dailyInsights = await fetchInsightsByDay(accountId, targetAdIds, facebookApi, sinceDate, untilDate)
    
    // 过滤：只保留 spend > 0 的按日数据（性能优化）
    const filteredDailyInsights = dailyInsights.filter(insight => {
      const spend = parseFloat(insight.spend || 0)
      return spend > 0
    })
    
    if (filteredDailyInsights.length === 0) {
      logger.info(`⚠️  没有拉取到 spend > 0 的按日数据，跳过更新 daily_stats`)
      return {
        success: true,
        todayCount: todayCount,
        dailyStatsCount: 0,
        sessionId: syncSessionId
      }
    }
    
    logger.info(`📊 按日数据过滤结果: ${dailyInsights.length} → ${filteredDailyInsights.length} (只保留 spend > 0)`)
    
    // 更新 daily_stats（按日修复迟到归因）
    const dailyStatsCount = await updateDailyStatsFromInsights(filteredDailyInsights, accountId, ownerId, timezoneName)
    
    logger.info(`✅ 账户 ${accountId} 滑动窗口同步完成`)
    logger.info(`   - Today 数据: ${todayCount} 条（ad_snapshots）`)
    logger.info(`   - 按日数据: ${dailyStatsCount} 条（daily_stats）`)
    logger.info(`   会话ID: ${syncSessionId}`)
    
    return {
      success: true,
      todayCount: todayCount,
      dailyStatsCount: dailyStatsCount,
      sessionId: syncSessionId
    }
  } catch (error) {
    logger.error(`❌ 同步账户 ${accountId} 滑动窗口数据失败:`, error.message)
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
  logger.info('🔄 开始同步所有账户的滑动窗口数据（修复归因延迟）...')
  
  // 分布式锁：防止多实例重复执行
  const lockName = 'sync:sliding_window'
  const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
  const lockAcquired = lockRows[0]?.acquired === 1
  
  if (!lockAcquired) {
    logger.info('⏸️  另一个实例正在执行滑动窗口同步（DB锁已占用），跳过本次执行')
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
      logger.info('⚠️  没有找到活跃账户，跳过滑动窗口同步')
      return {
        success: true,
        totalAccounts: 0,
        results: []
      }
    }
    
    logger.info(`📋 找到 ${accounts.length} 个活跃账户，开始滑动窗口同步...`)
    logger.info(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
    
    // 2. 使用受控并发遍历每个账户，调用 syncAccountSlidingWindow
    const accountTasks = accounts.map((account, index) => 
      accountTaskLimiter(async () => {
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        logger.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
          return null
      }
      
      try {
          logger.info(`\n[${index + 1}/${accounts.length}] 滑动窗口同步账户 ${accountId}...`)
        const result = await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, optimizeQuota)
          return {
          accountId,
          ownerId,
          ...result
        }
      } catch (error) {
        logger.error(`❌ 账户 ${accountId} 滑动窗口同步失败:`, error.message)
          return {
          accountId,
          ownerId,
          success: false,
          error: error.message,
          todayCount: 0,
          dailyStatsCount: 0
          }
        }
      })
    )
    
    // 等待所有账户任务完成
    const results = (await Promise.all(accountTasks)).filter(r => r !== null)
    
    // 统计总数
    let totalTodayCount = 0
    let totalDailyStatsCount = 0
    results.forEach(r => {
      totalTodayCount += r.todayCount || 0
      totalDailyStatsCount += r.dailyStatsCount || 0
    })
    
    // 3. 汇总结果
    const successCount = results.filter(r => r.success).length
    
    logger.info(`\n✅ 所有账户滑动窗口同步完成`)
    logger.info(`📊 统计:`)
    logger.info(`   - 账户总数: ${accounts.length}`)
    logger.info(`   - 成功账户: ${successCount}`)
    logger.info(`   - Today 数据: ${totalTodayCount} 条（ad_snapshots）`)
    logger.info(`   - 按日数据: ${totalDailyStatsCount} 条（daily_stats）`)
    
    return {
      success: true,
      totalAccounts: accounts.length,
      successCount: successCount,
      totalTodayCount: totalTodayCount,
      totalDailyStatsCount: totalDailyStatsCount,
      results
    }
  } catch (error) {
    logger.error('❌ 同步所有账户滑动窗口数据失败:', error.message)
    throw error
  } finally {
    // 释放锁
    try {
      await pool.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
    } catch (lockError) {
      logger.warn(`⚠️  释放锁失败: ${lockError.message}`)
    }
  }
}

/**
 * 同步所有账户的今日广告数据
 * @returns {Promise<Object>} 同步结果汇总
 */
export async function syncAllAccountsTodayStats() {
  logger.info('🔄 开始同步所有账户的今日数据...')
  
  // 分布式锁：防止多实例重复执行（多人并发使用时尤其重要）
  const lockName = 'sync:today_stats'
  const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
  const lockAcquired = lockRows[0]?.acquired === 1
  
  if (!lockAcquired) {
    logger.info('⏸️  另一个实例正在执行 Today 数据同步（DB锁已占用），跳过本次执行')
    return {
      success: true,
      totalAccounts: 0,
      skipped: true,
      message: '另一个实例正在执行，跳过'
    }
  }
  
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
      logger.info('⚠️  没有找到活跃账户，跳过同步')
      return {
        success: true,
        totalAccounts: 0,
        results: []
      }
    }
    
    logger.info(`📋 找到 ${accounts.length} 个活跃账户，开始同步...`)
    logger.info(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
    
    // 2. 使用受控并发遍历每个账户，调用 syncAccountTodayStats
    const accountTasks = accounts.map((account, index) => 
      accountTaskLimiter(async () => {
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      // 从数据库读取时区，如果没有则使用默认值 'UTC'
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        logger.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
          return null
      }
      
      try {
          logger.info(`\n[${index + 1}/${accounts.length}] 同步账户 ${accountId}...`)
        const result = await syncAccountTodayStats(accountId, ownerId, timezoneName)
          return {
          accountId,
          ownerId,
          ...result
        }
      } catch (error) {
        logger.error(`❌ 账户 ${accountId} 同步失败:`, error.message)
          return {
          accountId,
          ownerId,
          success: false,
          error: error.message,
          syncedCount: 0
      }
    }
      })
    )
    
    // 等待所有账户任务完成
    const results = (await Promise.all(accountTasks)).filter(r => r !== null)
    
    // 3. 汇总结果（增强统计：区分成功且有数据、成功但无数据、失败）
    const successWithData = results.filter(r => r.success && (r.syncedCount || 0) > 0).length
    const successNoData = results.filter(r => r.success && (r.syncedCount || 0) === 0).length
    const failed = results.filter(r => !r.success).length
    const totalSyncedCount = results.reduce((sum, r) => sum + (r.syncedCount || 0), 0)
    
    logger.info(`\n✅ 所有账户同步完成，共 ${accounts.length} 个账户`)
    logger.info(`📊 详细统计:`)
    logger.info(`   - 成功且有数据: ${successWithData} 个`)
    logger.info(`   - 成功但无数据: ${successNoData} 个`)
    logger.info(`   - 失败: ${failed} 个`)
    logger.info(`   - 共同步 ${totalSyncedCount} 条记录`)
    
    // 4. 识别可重试的失败账户（API限流错误）
      const failedAccounts = results.filter(r => !r.success)
    const retryableAccounts = failedAccounts.filter(r => isRetryableError(r.error))
    const nonRetryableAccounts = failedAccounts.filter(r => !isRetryableError(r.error))
    
    if (failed > 0) {
      logger.info(`\n⚠️  失败的账户详情:`)
      failedAccounts.forEach(r => {
        const isRetryable = isRetryableError(r.error)
        logger.info(`   - ${r.accountId}: ${r.error || '未知错误'} ${isRetryable ? '[可重试]' : '[不可重试]'}`)
      })
    }
    
    // 5. 重试可重试的失败账户（API限流错误）- 支持多次重试和指数退避
    if (retryableAccounts.length > 0) {
      logger.info(`\n🔄 开始重试 ${retryableAccounts.length} 个因API限流失败的账户（最多重试 ${RETRY_MAX_ATTEMPTS} 次）...`)
      
      // 多次重试循环（指数退避）
      let remainingAccounts = [...retryableAccounts]
      let totalRetrySuccess = 0
      let totalRetryFailed = 0
      let totalRetrySyncedCount = 0
      
      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS && remainingAccounts.length > 0; attempt++) {
        const delay = calculateBackoffDelay(attempt)
        logger.info(`\n🔄 第 ${attempt} 次重试（共 ${remainingAccounts.length} 个账户）...`)
        logger.info(`⏳ 等待 ${delay / 1000} 秒后重试（指数退避）...`)
        
        // 延迟重试（指数退避）
        await new Promise(resolve => setTimeout(resolve, delay))
        
        // 过滤掉仍在冷却期内的账户
        const accountsToRetry = remainingAccounts.filter(account => {
          if (isAccountInCooldown(account.accountId)) {
            const lastCallTime = accountLastCallTime.get(account.accountId)
            const remainingCooldown = Math.ceil((ACCOUNT_COOLDOWN_MS - (Date.now() - lastCallTime)) / 1000)
            logger.info(`   ⏸️  账户 ${account.accountId} 仍在冷却期内（还需等待 ${remainingCooldown} 秒），跳过本次重试`)
            return false
          }
          return true
        })
        
        if (accountsToRetry.length === 0) {
          logger.info(`   ⏸️  所有账户都在冷却期内，跳过本次重试`)
          break
        }
        
        // 并发重试失败的账户
        const retryTasks = accountsToRetry.map((failedAccount, index) => 
          accountTaskLimiter(async () => {
            const accountId = failedAccount.accountId
            const ownerId = failedAccount.ownerId
            const timezoneName = accounts.find(a => String(a.account_id || a.accountId || '') === accountId)?.timezone_name || 'UTC'
            
            // 记录账户调用时间（账户级别限流保护）
            recordAccountCall(accountId)
            
            try {
              logger.info(`\n[重试 ${attempt}/${RETRY_MAX_ATTEMPTS} - ${index + 1}/${accountsToRetry.length}] 重试账户 ${accountId}...`)
              const result = await syncAccountTodayStats(accountId, ownerId, timezoneName)
              logger.info(`✅ 账户 ${accountId} 重试成功，同步 ${result.syncedCount} 条记录`)
              return {
                accountId,
                ownerId,
                ...result,
                retried: true,
                retryAttempt: attempt
              }
            } catch (error) {
              const isStillRetryable = isRetryableError(error)
              logger.error(`❌ 账户 ${accountId} 第 ${attempt} 次重试失败: ${error.message} ${isStillRetryable ? '[仍可重试]' : '[不可重试]'}`)
              return {
                accountId,
                ownerId,
                success: false,
                error: error.message,
                syncedCount: 0,
                retried: true,
                retryAttempt: attempt,
                isStillRetryable
              }
            }
          })
        )
        
        const retryResults = (await Promise.all(retryTasks)).filter(r => r !== null)
        
        // 更新结果：用重试结果替换原来的失败结果
        retryResults.forEach(retryResult => {
          const originalIndex = results.findIndex(r => r.accountId === retryResult.accountId)
          if (originalIndex >= 0) {
            results[originalIndex] = retryResult
          } else {
            results.push(retryResult)
          }
        })
        
        // 统计本次重试结果
        const attemptSuccess = retryResults.filter(r => r.success).length
        const attemptFailed = retryResults.filter(r => !r.success).length
        const attemptSyncedCount = retryResults.reduce((sum, r) => sum + (r.syncedCount || 0), 0)
        
        totalRetrySuccess += attemptSuccess
        totalRetryFailed += attemptFailed
        totalRetrySyncedCount += attemptSyncedCount
        
        logger.info(`\n📊 第 ${attempt} 次重试结果:`)
        logger.info(`   - 重试成功: ${attemptSuccess} 个`)
        logger.info(`   - 重试失败: ${attemptFailed} 个`)
        logger.info(`   - 重试同步: ${attemptSyncedCount} 条记录`)
        
        // 更新剩余需要重试的账户（只保留仍可重试的失败账户）
        remainingAccounts = retryResults
          .filter(r => !r.success && r.isStillRetryable)
          .map(r => ({
            accountId: r.accountId,
            ownerId: r.ownerId,
            error: r.error
          }))
        
        // 如果所有账户都成功了或都不可重试，提前退出
        if (remainingAccounts.length === 0) {
          logger.info(`✅ 所有账户重试完成（成功或不可重试）`)
          break
        }
      }
      
      logger.info(`\n🔄 重试完成（共 ${RETRY_MAX_ATTEMPTS} 次尝试）:`)
      logger.info(`   - 重试成功: ${totalRetrySuccess} 个`)
      logger.info(`   - 重试失败: ${totalRetryFailed} 个`)
      logger.info(`   - 重试同步: ${totalRetrySyncedCount} 条记录`)
      
      // 更新总统计
      const finalSuccessWithData = results.filter(r => r.success && (r.syncedCount || 0) > 0).length
      const finalSuccessNoData = results.filter(r => r.success && (r.syncedCount || 0) === 0).length
      const finalFailed = results.filter(r => !r.success).length
      const finalTotalSyncedCount = results.reduce((sum, r) => sum + (r.syncedCount || 0), 0)
      
      logger.info(`\n📊 最终统计（含重试）:`)
      logger.info(`   - 成功且有数据: ${finalSuccessWithData} 个`)
      logger.info(`   - 成功但无数据: ${finalSuccessNoData} 个`)
      logger.info(`   - 失败: ${finalFailed} 个`)
      logger.info(`   - 共同步 ${finalTotalSyncedCount} 条记录`)
    }
    
    // 如果无数据账户过多，给出提示
    if (successNoData > accounts.length * 0.5) {
      logger.info(`\n💡 提示: 超过 50% 的账户没有数据，可能是:`)
      logger.info(`   - 账户下没有活跃广告`)
      logger.info(`   - 广告今天没有花费数据`)
      logger.info(`   - 数据同步时间窗口问题`)
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
    logger.error('❌ 同步所有账户失败:', error.message)
    throw error
  } finally {
    // 释放分布式锁（无论成功或失败都要释放）
    try {
      await pool.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
    } catch (lockError) {
      logger.warn(`⚠️  释放锁失败: ${lockError.message}`)
    }
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
  logger.info(`📦 开始批量拉取账户 ${accountId} 的广告数据（${datePreset}），共 ${adIds.length} 个广告`)
  
  // 如果没有广告，直接返回空数组
  if (!adIds || adIds.length === 0) {
    return []
  }
  
  // 将广告ID列表按 50 个一组切分（Facebook Batch API 最多支持 50 个）
  const BATCH_SIZE = 50
  const adIdChunks = chunkArray(adIds, BATCH_SIZE)
  const allInsights = []
  
  // 定义需要请求的字段（只请求需要的字段，避免浪费）
  // 注意：cost_per_action_type 是数组，包含各种 action_type 的成本
  // cost_per_unique_link_click 或 cost_per_unique_inline_link_click 是 uCPC
  // 新增：inline_link_clicks, unique_inline_link_clicks（用于提取原始计数）
  // P0：增加 unique_actions，当 unique_inline_link_clicks 缺失时 fallback 提取
  // 新增：adset_id（广告组ID，用于规则动作：增减预算）
  // 重要：ROAS 兜底字段来自 purchase_roas / website_purchase_roas（数组格式）
  // 当前策略（方案A）：写库不做 ROAS 本地计算，只存 API 兜底值或 null；真实 ROAS 由读侧按分子/分母计算
  const fields = 'ad_id,ad_name,adset_id,spend,actions,action_values,unique_actions,cost_per_action_type,cost_per_unique_link_click,cost_per_unique_inline_link_click,inline_link_clicks,unique_inline_link_clicks,purchase_roas,website_purchase_roas'
  const useAccountAttributionSetting = 'true'
  
  // 为 Batch Insights 构造 spend>0 源头过滤（与 FacebookMarketingAPI.DEFAULT_SPEND_FILTERING 保持一致）
  const batchFilteringStr = encodeURIComponent(JSON.stringify(facebookApi.getDefaultSpendFiltering()))

  // 遍历每一组，发送 Batch API 请求
  for (let i = 0; i < adIdChunks.length; i++) {
    const chunk = adIdChunks[i]
    logger.info(`📦 处理第 ${i + 1}/${adIdChunks.length} 批，共 ${chunk.length} 个广告`)
    
    try {
      // 构造 Batch API 请求体
      // 每个子请求的 relative_url 格式：{ad_id}/insights?fields=...&date_preset=today&use_account_attribution_setting=true&filtering=...
      const batchRequests = chunk.map(adId => ({
        method: 'GET',
        relative_url: `${adId}/insights?fields=${fields}&date_preset=${datePreset}&use_account_attribution_setting=${useAccountAttributionSetting}&filtering=${batchFilteringStr}`
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
        logger.error(`❌ Batch API 请求失败:`, responseData.error)
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
        logger.info(`⏸️  未获取到使用率信息，使用默认休眠时间: 1000ms`)
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
              logger.warn(`⚠️  广告 ${adId} 拉取失败:`)
              logger.warn(`   错误码: ${error.code || '未知'}`)
              logger.warn(`   错误类型: ${error.type || '未知'}`)
              logger.warn(`   错误消息: ${error.message || '无消息'}`)
              
              // 特殊处理：如果是"今天没有数据"的错误，记录但不中断
              if (error.message && (
                error.message.includes('No data available') ||
                error.message.includes('no data') ||
                error.message.includes('insufficient data')
              )) {
                logger.info(`   💡 提示: 广告 ${adId} 今天没有数据，这是正常情况（可能是新广告或已暂停）`)
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
                    logger.warn(`⚠️  广告 ${adId} 请求返回 400 错误:`)
                    logger.warn(`   ${errorDetails}`)
                    
                    // 常见 400 错误原因分析
                    if (error.message) {
                      if (error.message.includes('No data available') || error.message.includes('no data')) {
                        logger.info(`   💡 原因: 今天没有数据（可能是新广告、已暂停或今天未投放）`)
                      } else if (error.message.includes('Invalid parameter') || error.message.includes('invalid')) {
                        logger.info(`   💡 原因: 参数无效（可能是广告ID格式问题）`)
                      } else if (error.message.includes('permission') || error.message.includes('access')) {
                        logger.info(`   💡 原因: 权限不足（Token可能没有该广告的访问权限）`)
                      } else {
                        logger.info(`   💡 原因: ${error.message}`)
                      }
                    }
                  } else {
                    logger.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${errorDetails}`)
                  }
                } else {
                  logger.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${errorDetails}`)
                }
              } catch (parseError) {
                // 如果 body 不是 JSON，直接打印原始内容（截断前200字符）
                const bodyPreview = String(item.body).substring(0, 200)
                logger.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${item.code}`)
                logger.warn(`   响应内容预览: ${bodyPreview}${item.body.length > 200 ? '...' : ''}`)
              }
            } else {
              logger.warn(`⚠️  广告 ${adId} 请求返回非 200 状态码: ${item.code} (无响应体)`)
            }
          }
        } catch (parseError) {
          logger.error(`❌ 解析广告 ${chunk[index]} 的响应失败:`, parseError.message)
          if (parseError.stack) {
            logger.error(`   堆栈: ${parseError.stack.split('\n').slice(0, 3).join('\n')}`)
          }
        }
      })
      
      // 注意：动态休眠已在上面处理（基于响应头），这里不再需要固定休眠
      
    } catch (error) {
      logger.error(`❌ 第 ${i + 1} 批请求失败:`, error.message)
      // 继续处理下一批，不中断整个流程
      continue
    }
  }
  
  logger.info(`✅ 批量拉取完成，共获取 ${allInsights.length} 条广告数据`)
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
/**
 * 内部写入函数：实际执行数据库写入（从队列调用）
 * 注意：这个函数是串行调用的，不需要事务和重试机制
 */
async function saveSnapshotsToDbInternal(insights, metadata) {
  const { accountId, ownerId, syncSessionId, syncedAt, timezoneName } = metadata
  
  logger.info(`💾 [队列写入器] 开始写入数据库，共 ${insights.length} 条记录（写入前会清洗）`)
  
  // 如果没有数据，直接返回 0
  if (!insights || insights.length === 0) {
    return 0
  }
  
  try {
    // 【AdsPolar 动作B：优化写入逻辑】在写入前清洗数据
    // 【问题1修复】统一清洗逻辑：只保留 spend > 0 的广告
    // 注意：与 API 嗅探阶段的过滤逻辑保持一致（见 syncAccountTodayStats 第310-315行）
    // 这样可以确保所有数据路径（today/滑动窗口/批量按日）都统一过滤标准
    const cleanInsights = insights.filter(insight => {
      const spend = parseFloat(insight.spend || 0)
      return spend > 0
    })
    
    if (cleanInsights.length < insights.length) {
      const filteredCount = insights.length - cleanInsights.length
      logger.info(`🧹 [队列写入器] 数据清洗: ${insights.length} → ${cleanInsights.length} (过滤 ${filteredCount} 条 spend=0 的广告)`)
    }
    
    if (cleanInsights.length === 0) {
      logger.info(`⚠️  [队列写入器] 清洗后无有效数据，跳过写入`)
      return 0
    }
    
    // warn 日志限流：每个 syncSessionId（本次写入批次）只汇总输出 1 条
    let roasMissingCount = 0
    const roasMissingAdIds = new Set()
    const ROAS_WARN_SAMPLE_LIMIT = 10

    // 复用原有的数据转换逻辑
    const values = cleanInsights.map(insight => {
      // ... 数据转换逻辑（从原 saveSnapshotsToDb 复制）...
      const actions = insight.actions || []
      const purchases = parseActions(actions)
      const costPerActionType = insight.cost_per_action_type || []
      const cpa = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ])
      const addToCartCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_add_to_cart',
        'add_to_cart'
      ])
      const checkoutCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_initiate_checkout',
        'initiate_checkout'
      ])
      const paymentCost = pickCostPerActionType(costPerActionType, [
        'offsite_conversion.fb_pixel_add_payment_info',
        'add_payment_info'
      ])
      // P0：口径正确。link_clicks 仅用 inline_link_clicks / actions，绝不 fallback 到 clicks（全部点击）
      const rawLink = (insight.inline_link_clicks != null && insight.inline_link_clicks !== '') ? parseInt(insight.inline_link_clicks) : NaN
      const fromActions = extractActionCount(actions, ['link_click', 'inline_link_click'])
      const linkClicks = !Number.isNaN(rawLink) ? rawLink : (fromActions > 0 ? fromActions : 0)
      const rawUnique = (insight.unique_inline_link_clicks != null && insight.unique_inline_link_clicks !== '') ? parseInt(insight.unique_inline_link_clicks) : NaN
      const uniqueFromActions = extractActionCount(insight.unique_actions || [], ['link_click', 'inline_link_click'])
      const uniqueLinkClicks = !Number.isNaN(rawUnique) ? rawUnique : (uniqueFromActions > 0 ? uniqueFromActions : 0)
      const purchaseValue = extractPurchaseValue(insight.action_values)
      const spend = parseFloat(insight.spend || 0)
      const apiRoas = extractApiRoas(insight)
      const roas = purchaseValue > 0 ? null : (apiRoas != null ? apiRoas : null)
      if (purchases > 0 && purchaseValue === 0 && apiRoas == null) {
        roasMissingCount += 1
        if (roasMissingAdIds.size < ROAS_WARN_SAMPLE_LIMIT) {
          const adId = String(insight.ad_id || '')
          if (adId) roasMissingAdIds.add(adId)
        }
      }
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
      const adSetId = insight.adset_id ? String(insight.adset_id) : null
      const campaignId = insight.campaign_id ? String(insight.campaign_id) : null

      // 【AdsPolar 修复：ETL 时间语义错误】
      // 核心原则：永远只信 API 返回的 date_start，绝对不信服务器的当前时间
      // 这是解决数据错乱、归档失败的关键
      // 
      // 1. 优先使用 API 返回的 date_start（事件时间）
      // 2. 如果没有 date_start，使用 insight.date（fetchInsightsByDay 添加的字段）
      // 3. 如果都没有，才使用账户时区的"今天"（兜底逻辑，仅用于 today 数据）
      const accountToday = DateTime.now().setZone(timezoneName || 'UTC').toFormat('yyyy-MM-dd')
      const dataDate = insight.date_start || insight.date || accountToday
      
      // 调试日志：如果 date_start 存在但与 accountToday 不同，记录日志
      if (insight.date_start && insight.date_start !== accountToday) {
        // 静默处理，不打印日志（避免日志过多）
        // 但确保 data_date 使用 date_start
      }
      
      return {
        accountId: String(accountId),
        adId: String(insight.ad_id || ''),
        adName: insight.ad_name || null,
        status: insight.status || null,
        ownerId: ownerId,
        spend: spend,
        cpc: null,
        ucpc: null,
        roas: roas,
        cpa: cpa,
        actions: actions,
        purchases: purchases,
        addToCartCost: addToCartCost,
        checkoutCost: checkoutCost,
        paymentCost: paymentCost,
        linkClicks: linkClicks,
        uniqueLinkClicks: uniqueLinkClicks,
        purchaseValue: purchaseValue,
        addToCartCount: addToCartCount,
        initiateCheckoutCount: initiateCheckoutCount,
        addPaymentInfoCount: addPaymentInfoCount,
        adSetId: adSetId,
        campaignId: campaignId,
        syncSessionId: syncSessionId,
        syncedAt: syncedAt,
        timezoneName: timezoneName || 'UTC',
        dataDate: dataDate,
        muteUntil: null,
        muteReason: null,
        isSimulation: false
      }
    })
    
    if (values.length > 0) {
      const placeholders = values.map(() =>
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).join(', ')

      const sql = `
        INSERT INTO ad_snapshots (
          account_id, ad_id, ad_name, status, owner_id,
          spend, cpc, ucpc, roas, cpa, actions, purchases,
          add_to_cart_cost, checkout_cost, payment_cost,
          link_clicks, unique_link_clicks, purchase_value,
          add_to_cart_count, initiate_checkout_count, add_payment_info_count,
          ad_set_id, campaign_id,
          sync_session_id, synced_at, timezone_name, data_date, mute_until, mute_reason, is_simulation
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
          ad_set_id = COALESCE(VALUES(ad_set_id), ad_set_id),
          campaign_id = COALESCE(VALUES(campaign_id), campaign_id),
          synced_at = VALUES(synced_at),
          timezone_name = VALUES(timezone_name),
          data_date = VALUES(data_date)
      `

      // 【队列写入】串行写入，不需要事务和重试机制
      // 因为同一时间只有一个写入任务在执行，不会产生死锁
      const params = values.flatMap(v => [
        v.accountId,
        v.adId,
        v.adName,
        v.status,
        v.ownerId,
        v.spend,
        v.cpc,
        v.ucpc,
        v.roas,
        v.cpa,
        v.actions ? JSON.stringify(v.actions) : null,
        v.purchases,
        v.addToCartCost,
        v.checkoutCost,
        v.paymentCost,
        v.linkClicks,
        v.uniqueLinkClicks,
        v.purchaseValue,
        v.addToCartCount,
        v.initiateCheckoutCount,
        v.addPaymentInfoCount,
        v.adSetId,
        v.campaignId ?? null,
        v.syncSessionId,
        v.syncedAt,
        v.timezoneName,
        v.dataDate,
        v.muteUntil,
        v.muteReason,
        v.isSimulation ? 1 : 0
      ])
      
      const [result] = await pool.execute(sql, params)
      const insertedCount = result.affectedRows || 0
      
      if (roasMissingCount > 0) {
        logger.warn(
          `[ROAS] sync_session_id=${syncSessionId} purchases>0 且 purchase_value=0 且 api_roas=null：count=${roasMissingCount}, sample_ad_ids=${Array.from(roasMissingAdIds).join(',')}`
        )
      }

      logger.info(`✅ [队列写入器] 成功写入 ${insertedCount} 条记录到数据库`)
      return insertedCount
    }
    
    return 0
  } catch (error) {
    logger.error('❌ [队列写入器] 写入数据库失败:', error.message)
    throw error
  }
}

/**
 * 外部接口：保持向后兼容（内部使用队列）
 * 注意：这个函数现在只是推入队列，不直接写数据库
 */
async function saveSnapshotsToDb(insights, accountId, ownerId, syncSessionId, syncedAt, timezoneName) {
  // 推入队列，由串行写入器统一处理
  enqueueWrite('SNAPSHOT', insights, {
    accountId,
    ownerId,
    syncSessionId,
    syncedAt,
    timezoneName
  })
  
  // 返回入队数量（不是实际写入数量）
  return insights.length
}

/**
 * 解析 Facebook API 响应中的 actions 字段，提取购买次数
 * @param {Array} actions - Facebook API 返回的 actions 数组
 * @returns {number} 购买次数
 */
function parseActions(actions) {
  if (!Array.isArray(actions)) return 0

  const normalize = (s) => String(s || '').toLowerCase().trim()
  const toInt = (v) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }

  // 1) omni_purchase 优先：若存在直接返回（避免与渠道字段重复计数）
  for (const action of actions) {
    if (!action || !action.action_type) continue
    if (normalize(action.action_type) === 'omni_purchase') {
      return toInt(action.value)
    }
  }

  // 2) 保守防双算：各渠道分别取值后返回 max(各渠道)
  const channelTypes = [
    'offsite_conversion.fb_pixel_purchase',
    'website_purchase',
    'onsite_conversion.purchase',
    'mobile_app_purchase'
  ]
  const channelCounts = channelTypes.map(type => {
    const target = normalize(type)
    const found = actions.find(action => action && normalize(action.action_type) === target)
    return found ? toInt(found.value) : 0
  })
  const maxChannel = Math.max(...channelCounts)
  if (maxChannel > 0) return maxChannel

  // 3) 最后兜底：purchase（仅当上述都不存在时才用）
  const purchase = actions.find(action => action && normalize(action.action_type) === 'purchase')
  return purchase ? toInt(purchase.value) : 0
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
 * 策略：计算优先（purchase_value / spend），API 兜底；不可计算时返回 null（不写 0，避免规则误判）
 * @param {Object} insight - 广告洞察数据
 * @param {number} spend - 花费（用于计算）
 * @param {number} purchaseValue - 购买总金额（用于计算）
 * @returns {number|null} ROAS 值，如果不存在则返回 null
 */
function extractRoas(insight, spend, purchaseValue) {
  // 保留同名函数，兼容已有调用；语义调整为 API 兜底值（ROAS_Fallback_Only）
  return extractApiRoas(insight)
}

/**
 * 仅提取 API 返回的 ROAS（兜底值，不做本地计算）
 * @param {Object} insight - 广告洞察数据
 * @returns {number|null}
 */
function extractApiRoas(insight) {
  const priorityTypes = [
    'omni_purchase',
    'offsite_conversion.fb_pixel_purchase',
    'mobile_app_purchase',
    'website_purchase',
    'onsite_conversion.purchase',
    'purchase'
  ]
  const normalize = (s) => String(s || '').toLowerCase().trim()
  const pickFrom = (arr) => {
    if (!Array.isArray(arr)) return null
    for (const type of priorityTypes) {
      const target = normalize(type)
      const found = arr.find(item => item && normalize(item.action_type) === target)
      if (!found || found.value == null) continue
      const value = parseFloat(found.value)
      if (Number.isFinite(value)) return value
    }
    return null
  }
  const fromPurchaseRoas = pickFrom(insight?.purchase_roas)
  if (fromPurchaseRoas != null) return fromPurchaseRoas
  const fromWebsitePurchaseRoas = pickFrom(insight?.website_purchase_roas)
  if (fromWebsitePurchaseRoas != null) return fromWebsitePurchaseRoas
  return null
}

/**
 * 从 action_values 中提取购买总转化金额（purchase_value）
 * 按优先级查找，只取第一命中，不做求和，避免重复累计
 * @param {Array} actionValues - Facebook API 返回的 action_values 数组
 * @returns {number} 购买总转化金额，如果不存在则返回 0
 */
function extractPurchaseValue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) {
    return 0
  }
  const priorityTypes = [
    'omni_purchase',
    'offsite_conversion.fb_pixel_purchase',
    'mobile_app_purchase',
    'website_purchase',
    'onsite_conversion.purchase',
    'purchase'
  ]
  const normalize = (s) => String(s || '').toLowerCase().trim()
  for (const targetType of priorityTypes) {
    const target = normalize(targetType)
    for (const item of actionValues) {
      if (!item || !item.action_type) continue
      if (normalize(item.action_type) === target) {
        const value = parseFloat(item.value)
        return Number.isFinite(value) ? value : 0
      }
    }
  }
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
  logger.info(`📦 开始冷数据落盘...`)
  
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
    const startTime = targetDateStart.toJSDate()
    const endTime = targetDateEnd.toJSDate()
    
    logger.info(`📅 目标日期: ${dateStr} (时区: ${timezoneName})`)
    logger.info(`📅 时间范围: ${targetDateStart.toISO()} ~ ${targetDateEnd.toISO()}`)
    
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
        campaign_id,
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
        WHERE data_date = ?
      ) ranked
      WHERE rn = 1
    `
    
    // 【AdsPolar 动作A：修改查询口径】使用 data_date 而不是 synced_at
    // 将目标日期转换为 YYYY-MM-DD 格式
    const params = [dateStr]
    
    if (accountId) {
      query = query.replace('WHERE rn = 1', 'WHERE rn = 1 AND account_id = ?')
      params.push(accountId)
    }
    
    let rows
    let compatMeta = null
    try {
      const [result] = await pool.execute(query, params)
      rows = result
    } catch (error) {
      // 如果 ROW_NUMBER() 不支持（非 MySQL 8.0），降级到兼容方案
      if (error.message.includes('ROW_NUMBER') || error.message.includes('syntax')) {
        logger.info('⚠️  ROW_NUMBER() 不支持，使用兼容方案（最大时间戳连接法）')
        const compatResult = await queryLastSnapshotCompatible(accountId, dateStr, startTime, endTime)
        rows = compatResult.rows || []
        compatMeta = {
          mode: compatResult.mode,
          ads: compatResult.ads
        }
      } else {
        throw error
      }
    }
    
    if (!rows || rows.length === 0) {
      logger.info(`⚠️  没有找到 ${dateStr} 的数据，跳过落盘`)
      return {
        success: true,
        archivedCount: 0,
        compat: compatMeta
      }
    }
    
    logger.info(`📋 找到 ${rows.length} 条记录需要落盘（最后快照）`)
    
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
              const roas = extractApiRoas(ins) // 方案A：仅存 API 兜底值（ROAS_Fallback_Only）
              
              return [
                adId,
                {
                  cpc: null,
                  roas
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
      const y = yesterdayMap.get(String(row.ad_id)) || {}
      const linkClicksCount = parseInt(row.link_clicks || 0)
      const cpc = (linkClicksCount > 0 && spend > 0) ? (spend / linkClicksCount) : null
      const purchaseValue = parseFloat(row.purchase_value ?? 0)
      const roas = y.roas != null ? y.roas : (spend > 0 && purchaseValue > 0 ? (purchaseValue / spend) : null)
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
        row.ad_set_id || null,
        row.campaign_id || null
      ]
    })
    
    // 使用 ON DUPLICATE KEY UPDATE 更新已存在的记录
    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    
    const sql = `
      INSERT INTO daily_stats (
        account_id, ad_id, ad_name, owner_id, date, timezone_name,
        spend, cpc, roas, purchases, add_to_cart, actions,
        link_clicks, unique_link_clicks, purchase_value,
        add_to_cart_count, initiate_checkout_count, add_payment_info_count,
        ad_set_id, campaign_id
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
        campaign_id = VALUES(campaign_id),
        updated_at = NOW()
    `
    
    
    const params2 = values.flat()
    const [result] = await pool.execute(sql, params2)
    const archivedCount = result.affectedRows || 0
    
    logger.info(`✅ 冷数据落盘完成，共归档 ${archivedCount} 条记录（使用最后快照）`)
    
    return {
      success: true,
      archivedCount: archivedCount,
      compat: compatMeta
    }
  } catch (error) {
    logger.error('❌ 冷数据落盘失败:', error.message)
    throw error
  }
}

/**
 * 兼容方案：使用最大时间戳连接法取最后快照（适用于非 MySQL 8.0）
 * 参考：方案B+优化版-最终版.md 第十四章
 * @param {string|null} accountId - 账户ID（可选）
 * @param {string} targetDateStr - 目标自然日（YYYY-MM-DD），用于 data_date 口径优先
 * @param {Date} startTime - 开始时间
 * @param {Date} endTime - 结束时间
 * @returns {Promise<{ rows: Array, mode: 'data_date' | 'synced_at', ads: number }>} 最后快照数据与口径信息
 */
async function queryLastSnapshotCompatible(accountId, targetDateStr, startTime, endTime) {
  // 去重：同一 (account_id, ad_id) 只保留 synced_at 最大；若并列，取 id 最大（对齐主路径 ROW_NUMBER 的 ORDER BY synced_at DESC, id DESC）
  const dedupeByMaxId = (rows) => {
    const map = new Map()
    for (const r of rows || []) {
      const key = `${r.account_id}:${r.ad_id}`
      const prev = map.get(key)
      const curId = Number(r.id ?? -1)
      const prevId = prev ? Number(prev.id ?? -1) : -1
      if (!prev || curId > prevId) {
        map.set(key, r)
      }
    }
    return [...map.values()]
  }

  // -----------------------------
  // 第一步（优先）：data_date 口径
  // -----------------------------
  const queryDataDate = `
    SELECT 
      s.id,
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
      WHERE data_date = ?
      ${accountId ? 'AND account_id = ?' : ''}
      GROUP BY account_id, ad_id
    ) t
    ON s.account_id = t.account_id
    AND s.ad_id = t.ad_id
    AND s.synced_at = t.last_synced_at
    WHERE s.data_date = ?
    ${accountId ? 'AND s.account_id = ?' : ''}
  `

  const paramsDataDate = [targetDateStr]
  if (accountId) paramsDataDate.push(accountId)
  paramsDataDate.push(targetDateStr)
  if (accountId) paramsDataDate.push(accountId)

  const [dataDateRowsRaw] = await pool.execute(queryDataDate, paramsDataDate)
  const dataDateRows = dedupeByMaxId(dataDateRowsRaw)
  if (dataDateRows && dataDateRows.length > 0) {
    return { rows: dataDateRows, mode: 'data_date', ads: dataDateRows.length }
  }

  // -----------------------------
  // 第二步（兜底）：synced_at 时间范围（非标准口径兜底）
  // -----------------------------
  const queryRange = `
    SELECT 
      s.id,
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
    WHERE s.synced_at >= ? AND s.synced_at <= ?
    ${accountId ? 'AND s.account_id = ?' : ''}
  `

  const paramsRange = [startTime, endTime]
  if (accountId) paramsRange.push(accountId)
  paramsRange.push(startTime, endTime)
  if (accountId) paramsRange.push(accountId)

  const [rangeRowsRaw] = await pool.execute(queryRange, paramsRange)
  const rangeRows = dedupeByMaxId(rangeRowsRaw)

  logger.warn(
    `⚠️  [兼容归档] data_date 无数据，使用 synced_at 范围兜底（非标准口径兜底）: account=${accountId || 'ALL'}, date=${targetDateStr}, ads=${rangeRows.length}`
  )

  return { rows: rangeRows, mode: 'synced_at', ads: rangeRows.length }
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
  logger.info('📦 开始冷数据归档检查（高频检查模式）...')
  logger.info(`⏰ 当前服务器时间: ${new Date().toISOString()}`)
  
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
      logger.info('⚠️  没有找到活跃账户，跳过归档检查')
      return {
        success: true,
        totalAccounts: 0,
        totalArchivedCount: 0,
        checkedAccounts: 0,
        archivedAccounts: 0,
        skippedAccounts: 0
      }
    }
    
    logger.info(`📋 找到 ${accounts.length} 个活跃账户，开始检查归档窗口...`)
    logger.info(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
    
    // 2. 使用受控并发为每个账户检查归档窗口并执行归档
    // 跳过原因分类统计（增强观测性）
    let skipReasons = {
      complete: 0,        // 已归档且完整
      incomplete: 0,       // 已归档但不完整（继续补齐）
      lockBusy: 0,        // 锁被占用
      windowNotReached: 0, // 窗口未到
      invalidAccount: 0,   // 无效账户
      error: 0             // 异常失败
    }
    
    const accountTasks = accounts.map(account => 
      accountTaskLimiter(async () => {
      const accountId = String(account.account_id || account.accountId || '')
      const ownerId = account.owner_id || account.ownerId
      const timezoneName = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        logger.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
          return { archived: false, archivedCount: 0, skipReason: 'invalidAccount' }
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
              return { archived: false, archivedCount: 0, skipReason: 'windowNotReached' }
          }
          
          logger.info(`\n🕐 账户 ${accountId} 到达归档窗口`)
          logger.info(`   时区: ${timezoneName}`)
          logger.info(`   本地时间: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}`)
        } else {
          logger.info(`\n🔧 强制归档账户 ${accountId} (时区: ${timezoneName})`)
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
          // 【AdsPolar 动作A：修改查询口径】使用 data_date 而不是 synced_at
        // 查询 ad_snapshots 中目标日期的 DISTINCT ad_id 数量（期望归档的广告数）
        const [expectedRows] = await pool.execute(
          `SELECT COUNT(DISTINCT ad_id) as cnt 
           FROM ad_snapshots 
             WHERE account_id = ? AND data_date = ?`,
            [accountId, targetDateStr]
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
        
        // 强制模式（如手动触发）：不跳过完整性检查的“跳过”，一律执行归档，用于回填 cpc/roas 等
        if (!forceAll && isComplete) {
          if (expectedCount === 0) {
            logger.info(`   ✅ 已归档且完整，跳过 (date: ${targetDateStr}, 无数据)`)
          } else {
            logger.info(`   ✅ 已归档且完整，跳过 (date: ${targetDateStr}, ${archivedCount}/${expectedCount} 条)`)
          }
          return { archived: false, archivedCount: 0, skipReason: 'complete' }
        }
        if (!forceAll && !isComplete) {
          const missingCount = expectedCount - archivedCount
          logger.info(`   ⚠️  已归档但不完整，继续补齐 (date: ${targetDateStr}, 已归档: ${archivedCount}, 期望: ${expectedCount}, 缺失: ${missingCount})`)
        }
        if (forceAll && isComplete && expectedCount > 0) {
          logger.info(`   🔄 强制重跑归档 (date: ${targetDateStr}, ${archivedCount}/${expectedCount} 条)，将更新 cpc/roas 等`)
        }
        
          // 2.4 获取 DB 锁（防止多实例并发）- 使用专用连接
        const lockName = `archive:${accountId}:${targetDateStr}`
          const connection = await pool.getConnection()
          let lockAcquired = false
          
          try {
            // 在同一连接上获取锁
            const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
            lockAcquired = lockRows[0]?.acquired === 1
        
        if (!lockAcquired) {
          logger.info(`   ⏸️  锁已被占用，跳过（可能其他实例正在归档）`)
              return { archived: false, archivedCount: 0, skipReason: 'lockBusy' }
        }
        
        try {
          // 2.5 执行归档
          logger.info(`   📦 开始归档 (date: ${targetDateStr})`)
          const result = await archiveDailyStats(accountId, timezoneName, targetDate || yesterday.toJSDate())
          const archivedCount = result.archivedCount || 0
          
          logger.info(`   ✅ 归档完成，共 ${archivedCount} 条记录`)
              return { archived: true, archivedCount, compat: result.compat || null }
        } finally {
              // 2.6 在同一连接上释放锁（无论成功或失败都要释放）
              if (lockAcquired) {
          try {
                  await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
          } catch (lockError) {
            // 锁释放失败不影响主流程，只记录警告
            logger.warn(`   ⚠️  释放锁失败: ${lockError.message}`)
          }
              }
            }
          } finally {
            // 释放连接
            connection.release()
        }
      } catch (error) {
        logger.error(`   ❌ 账户 ${accountId} 归档失败:`, error.message)
          return { archived: false, archivedCount: 0, skipReason: 'error' }
        }
      })
    )
    
    // 等待所有账户任务完成
    const results = await Promise.all(accountTasks)
    
    // 统计结果
    let totalArchivedCount = 0
    let archivedAccounts = 0
    let skippedAccounts = 0
    // 回退观测：兼容方案（ROW_NUMBER 不可用）与 synced_at 非标准兜底使用情况
    let compatAccounts = 0
    let syncedAtFallbackAccounts = 0
    let syncedAtFallbackAds = 0
    
    results.forEach(result => {
      if (result.archived) {
        archivedAccounts++
        totalArchivedCount += result.archivedCount || 0
        if (result.compat) {
          compatAccounts++
          if (result.compat.mode === 'synced_at') {
            syncedAtFallbackAccounts++
            syncedAtFallbackAds += (result.compat.ads || 0)
          }
        }
      } else {
        skippedAccounts++
        if (result.skipReason) {
          skipReasons[result.skipReason] = (skipReasons[result.skipReason] || 0) + 1
      }
    }
    })
    
    logger.info('\n' + '='.repeat(50))
    logger.info(`✅ 归档检查完成`)
    logger.info(`📊 统计:`)
    logger.info(`   - 检查账户: ${accounts.length}`)
    logger.info(`   - 归档账户: ${archivedAccounts}`)
    logger.info(`   - 跳过账户: ${skippedAccounts}`)
    logger.info(`   - 归档记录: ${totalArchivedCount} 条`)
    logger.info(`📊 回退观测:`)
    logger.info(`   - 兼容方案账户（ROW_NUMBER 不可用）: ${compatAccounts} 个`)
    logger.info(`   - synced_at 兜底账户（非标准口径）: ${syncedAtFallbackAccounts} 个`)
    logger.info(`   - synced_at 兜底广告数: ${syncedAtFallbackAds} 条`)
    logger.info(`📊 跳过原因分类:`)
    logger.info(`   - 已归档且完整: ${skipReasons.complete} 个`)
    logger.info(`   - 已归档但不完整（已补齐）: ${skipReasons.incomplete} 个`)
    logger.info(`   - 锁被占用: ${skipReasons.lockBusy} 个`)
    logger.info(`   - 窗口未到: ${skipReasons.windowNotReached} 个`)
    logger.info(`   - 无效账户: ${skipReasons.invalidAccount} 个`)
    logger.info(`   - 异常失败: ${skipReasons.error} 个`)
    logger.info('='.repeat(50))
    
    return {
      success: true,
      totalAccounts: accounts.length,
      totalArchivedCount: totalArchivedCount,
      checkedAccounts: accounts.length,
      archivedAccounts: archivedAccounts,
      skippedAccounts: skippedAccounts
    }
  } catch (error) {
    logger.error('❌ 归档检查失败:', error.message)
    throw error
  }
}

// ============================================
// 统一心跳同步（M2 阶段二：统一心跳 + 双窗口归档）
// ============================================

/**
 * 统一心跳同步任务
 * 每 15 分钟执行一次，内部根据当前时间和账户时区决定：
 * 1. 数据同步：Today / last_3d / last_7d / last_14d
 * 2. 双窗口归档：≥02:00 ARCHIVED，≥12:00 FINALIZED
 * 
 * 依据：TASKS.md 1.4 + DEV_PLAN.md 4.4
 * @returns {Promise<Object>} 执行结果
 */
// AdsPolar 优化：统一心跳防重入锁
let heartbeatRunning = false
const HEARTBEAT_LOCK_NAME = 'fb_ad_brain:unified_heartbeat'

export async function unifiedHeartbeatSync() {
  // AdsPolar 优化：防重入检查（防止多实例或长时间执行导致重叠）
  if (heartbeatRunning) {
    logger.info('⏸️  统一心跳正在执行中，跳过本次任务（防重入）')
    return {
      success: true,
      totalAccounts: 0,
      syncedAccounts: 0,
      archivedAccounts: 0,
      syncedAccountIds: [],
      skipped: true,
      skipReason: 'already_running'
    }
  }

  // 【问题3修复】使用专用连接获取和释放锁（必须在同一连接上操作）
  // MySQL 的 GET_LOCK 和 RELEASE_LOCK 必须在同一个连接上操作，否则会导致锁状态异常
  let lockAcquired = false
  let lockConnection = null
  try {
    lockConnection = await pool.getConnection()
    const [lockRows] = await lockConnection.query(`SELECT GET_LOCK(?, 0) AS acquired`, [HEARTBEAT_LOCK_NAME])
    lockAcquired = lockRows[0]?.acquired === 1
    
    if (!lockAcquired) {
      logger.info('⏸️  统一心跳锁已被占用（可能其他实例正在执行），跳过本次任务')
      // 立即释放连接（未获取锁时）
      if (lockConnection) {
        lockConnection.release()
        lockConnection = null
      }
      return {
        success: true,
        totalAccounts: 0,
        syncedAccounts: 0,
        archivedAccounts: 0,
        syncedAccountIds: [],
        skipped: true,
        skipReason: 'lock_busy'
      }
    }
    // 注意：获取锁后，不能立即释放连接，必须等到释放锁后再释放连接
  } catch (lockError) {
    logger.warn('⚠️  获取统一心跳锁失败，使用进程内标志位:', lockError.message)
    // 如果获取锁失败，回退到进程内标志位（单实例场景）
    if (lockConnection) {
      lockConnection.release()
      lockConnection = null
    }
  }

  heartbeatRunning = true
  const startTime = Date.now()
  
  try {
    logger.info('')
    logger.info('='.repeat(50))
    logger.info('💓 统一心跳同步任务（每 15 分钟）')
    logger.info('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    logger.info('='.repeat(50))
    // 1. 获取所有活跃账户
    const [accounts] = await pool.query(`
      SELECT DISTINCT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      ORDER BY fb_account_id
    `)
    
    if (!accounts || accounts.length === 0) {
      logger.info('⚠️  没有找到活跃账户，跳过同步')
      return {
        success: true,
        totalAccounts: 0,
        syncedAccounts: 0,
        archivedAccounts: 0
      }
    }
    
    logger.info(`📋 找到 ${accounts.length} 个活跃账户`)
    logger.info(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
    
    // Track2 Fast Sync 开关与白名单（用于决定哪些账户可依赖 Track2，不再跑伪增量）
    const enableTrack2FastSync = process.env.ENABLE_TRACK2_FAST_SYNC === '1' || process.env.ENABLE_TRACK2_FAST_SYNC === 'true'
    const track2AccountWhitelist = new Set(
      String(process.env.TRACK2_FAST_SYNC_ACCOUNT_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    const isTrack2EnabledForAccount = (accountId) => {
      if (!enableTrack2FastSync) return false
      const id = String(accountId || '').trim()
      if (!id) return false
      if (track2AccountWhitelist.size === 0) return true
      return track2AccountWhitelist.has(id)
    }

    // 2. 为每个账户执行同步和归档（受控并发）
    let syncedAccounts = 0
    let archivedAccounts = 0
    let finalizedAccounts = 0
    
    // 使用 p-limit 控制并发度
    const accountTasks = accounts.map(account => 
      accountTaskLimiter(async () => {
        const accountId = String(account.account_id || '')
        const ownerId = account.owner_id || account.ownerId
        const timezoneName = account.timezone_name || 'UTC'
        
        if (!accountId || !ownerId) {
          logger.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
          return { synced: false, archived: false, finalized: false }
        }
        
        try {
          // 2.1 根据账户时区决定本轮使用的 time_range
          const now = DateTime.now()
          const localTime = now.setZone(timezoneName)
          const hour = localTime.hour
          
          // 决定同步范围：根据当前时间选择合适的时间窗口
          // 策略：白天（6-18点）同步 Today，夜间同步历史数据
          let timeRange = 'today'
          let daysBack = 0
          
          if (hour >= 6 && hour < 18) {
            // 白天：主要同步 Today，偶尔回补最近 3 天
            timeRange = 'today'
            daysBack = 0
            // 每小时的第 0 分钟回补 last_3d
            if (localTime.minute === 0) {
              daysBack = 3
            }
          } else {
            // 夜间：回补历史数据
            if (hour >= 0 && hour < 6) {
              // 凌晨：回补 last_7d
              timeRange = 'last_7d'
              daysBack = 7
            } else {
              // 晚上：回补 last_14d
              timeRange = 'last_14d'
              daysBack = 14
            }
          }
          
          logger.info(`\n[账户 ${accountId}] 时区: ${timezoneName}, 本地时间: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss')}`)
          logger.info(`  同步范围: ${timeRange} (daysBack=${daysBack})`)
          
          // 2.2 执行数据同步（AdsPolar 优化：检测实际数据变化）
          let synced = false
          let dataUpdated = false  // 是否有实际数据更新
          let syncError = null
          let syncResult = null
          try {
            if (daysBack === 0) {
              // 同轮复用 facebookApi，供 Piggyback 只补缺口、不再对 activeAdIds 调 resolve
              const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
              const facebookApi = accessToken ? new FacebookMarketingAPI(accessToken) : null
              syncResult = await syncAccountTodayStats(accountId, ownerId, timezoneName, facebookApi)
              dataUpdated = syncResult && syncResult.success && syncResult.syncedCount > 0
              if (dataUpdated) {
                logger.info(`   ✅ [${accountId}] 有数据更新: ${syncResult.syncedCount} 条`)
              } else if (syncResult?.success) {
                logger.info(`   📋 [${accountId}] 同步完成但无数据更新（今日 spend>0 广告数=0，未写入 ad_snapshots）`)
              }
              if (syncResult?.success) {
                logger.info(`   📊 [${accountId}] 拉取 spend>0=${syncResult.syncedCount ?? 0}, 写入 ad_snapshots=${syncResult.syncedCount ?? 0}`)
              }
              // Piggyback：用本轮已拿到的 structurePayload 补齐 structure_ads（best-effort，同轮 resolve 只一次）
              if (syncResult?.activeAdIds?.length && facebookApi) {
                try {
                  await piggybackStructureFromToday(accountId, syncResult.activeAdIds, syncResult.structurePayload || {}, facebookApi)
                } catch (pbErr) {
                  logger.warn(`   ⚠️ [${accountId}] Piggyback 跳过:`, pbErr.message)
                }
              }
            } else {
              // 同步滑动窗口数据（启用配额优化，只拉取活跃广告）
              syncResult = await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, true)
              // 判断是否有实际数据更新（todayCount > 0 或 dailyStatsCount > 0）
              dataUpdated = syncResult && syncResult.success && (syncResult.todayCount > 0 || syncResult.dailyStatsCount > 0)
              if (dataUpdated) {
                logger.info(`   ✅ [${accountId}] 有数据更新: Today=${syncResult.todayCount || 0}, Daily=${syncResult.dailyStatsCount || 0}`)
              } else if (syncResult?.success) {
                logger.info(`   📋 [${accountId}] 同步完成但无数据更新（Today=${syncResult.todayCount ?? 0}, Daily=${syncResult.dailyStatsCount ?? 0}，未写入 ad_snapshots）`)
              }
              if (syncResult?.success) {
                logger.info(`   📊 [${accountId}] 写入 ad_snapshots=${syncResult.todayCount ?? 0}, 写入 daily_stats=${syncResult.dailyStatsCount ?? 0}`)
              }
            }
            synced = true
          } catch (error) {
            syncError = error
            logger.error(`   ❌ 数据同步失败: ${error.message}`)
          }
          
          // 2.3 执行双窗口归档检查
          const archiveResult = await checkAndExecuteArchive(accountId, ownerId, timezoneName, localTime)
          
          // 规则执行不再由心跳顺带触发，改由「每分钟 Cron」统一驱动（见 cronService 调度）
          // 依据：docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md §4.1
          
          return {
            synced,
            dataUpdated,
            archived: archiveResult.archived,
            finalized: archiveResult.finalized,
            accountId,
            ownerId,
            timezoneName,
            activeAdIds: (daysBack === 0 && syncResult?.activeAdIds?.length) ? syncResult.activeAdIds : [],
            syncError: syncError ? { message: syncError.message, isRetryable: isRetryableError(syncError) } : null
          }
        } catch (error) {
          logger.error(`   ❌ 账户 ${accountId} 处理失败:`, error.message)
          return {
            synced: false,
            dataUpdated: false,
            archived: false,
            finalized: false,
            accountId,
            ownerId,
            timezoneName,
            activeAdIds: [],
            syncError: { message: error.message, isRetryable: isRetryableError(error) }
          }
        }
      })
    )
    
    // 等待所有账户任务完成
    const results = await Promise.all(accountTasks)

    // 心跳后置阶段：伪增量（仅对非 Track2 账户跑；Track2 账户由 Track1+Track2+Piggyback 承担结构职责）
    const allValidAccounts = results.filter((r) => r?.accountId)
    const track2Accounts = allValidAccounts.filter((r) => isTrack2EnabledForAccount(r.accountId))
    const accountsForPseudo = allValidAccounts.filter((r) => !isTrack2EnabledForAccount(r.accountId))

    logger.info(
      `[伪增量] 本轮账户统计: total=${allValidAccounts.length}, track2=${track2Accounts.length}, pseudo=${accountsForPseudo.length}`
    )

    if (accountsForPseudo.length > 0 && process.env.FACEBOOK_ACCESS_TOKEN) {
      const facebookApi = new FacebookMarketingAPI(process.env.FACEBOOK_ACCESS_TOKEN)
      for (const r of accountsForPseudo) {
        try {
          await runPseudoIncrementForAccount(r.accountId, r.activeAdIds || [], facebookApi)
        } catch (err) {
          logger.warn(`[伪增量] account=${r.accountId} 跳过:`, err.message)
        }
      }
    }

    // 统计结果
    results.forEach(result => {
      if (result.synced) syncedAccounts++
      if (result.archived) archivedAccounts++
      if (result.finalized) finalizedAccounts++
    })
    
    // 3. 识别可重试的失败账户（API限流错误）- 支持多次重试和指数退避
    const failedSyncAccounts = results.filter(r => !r.synced && r.syncError && r.syncError.isRetryable)
    
    if (failedSyncAccounts.length > 0) {
      logger.info(`\n🔄 检测到 ${failedSyncAccounts.length} 个因API限流失败的账户，准备重试（最多重试 ${RETRY_MAX_ATTEMPTS} 次）...`)
      
      // 多次重试循环（指数退避）
      let remainingAccounts = [...failedSyncAccounts]
      let totalRetrySuccess = 0
      let totalRetryFailed = 0
      
      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS && remainingAccounts.length > 0; attempt++) {
        const delay = calculateBackoffDelay(attempt)
        logger.info(`\n🔄 第 ${attempt} 次重试（共 ${remainingAccounts.length} 个账户）...`)
        logger.info(`⏳ 等待 ${delay / 1000} 秒后重试（指数退避）...`)
        
        // 延迟重试（指数退避）
        await new Promise(resolve => setTimeout(resolve, delay))
        
        // 过滤掉仍在冷却期内的账户
        const accountsToRetry = remainingAccounts.filter(account => {
          if (isAccountInCooldown(account.accountId)) {
            const lastCallTime = accountLastCallTime.get(account.accountId)
            const remainingCooldown = Math.ceil((ACCOUNT_COOLDOWN_MS - (Date.now() - lastCallTime)) / 1000)
            logger.info(`   ⏸️  账户 ${account.accountId} 仍在冷却期内（还需等待 ${remainingCooldown} 秒），跳过本次重试`)
            return false
          }
          return true
        })
        
        if (accountsToRetry.length === 0) {
          logger.info(`   ⏸️  所有账户都在冷却期内，跳过本次重试`)
          break
        }
        
        // 并发重试失败的账户
        const retryTasks = accountsToRetry.map((failedAccount, index) => 
          accountTaskLimiter(async () => {
            const accountId = failedAccount.accountId
            const ownerId = failedAccount.ownerId
            const timezoneName = failedAccount.timezoneName || 'UTC'
            
            // 记录账户调用时间（账户级别限流保护）
            recordAccountCall(accountId)
            
            try {
              logger.info(`\n[重试 ${attempt}/${RETRY_MAX_ATTEMPTS} - ${index + 1}/${accountsToRetry.length}] 重试账户 ${accountId}...`)
              
              // 重新决定同步范围（使用相同的逻辑）
              const now = DateTime.now()
              const localTime = now.setZone(timezoneName)
              const hour = localTime.hour
              let daysBack = 0
              
              if (hour >= 6 && hour < 18) {
                daysBack = 0
                if (localTime.minute === 0) {
                  daysBack = 3
                }
              } else {
                if (hour >= 0 && hour < 6) {
                  daysBack = 7
                } else {
                  daysBack = 14
                }
              }
              
              // 重试同步
              if (daysBack === 0) {
                await syncAccountTodayStats(accountId, ownerId, timezoneName)
              } else {
                await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, true)
              }
              
              logger.info(`✅ 账户 ${accountId} 重试成功`)
              return { synced: true, archived: false, finalized: false }
            } catch (error) {
              const isStillRetryable = isRetryableError(error)
              logger.error(`❌ 账户 ${accountId} 第 ${attempt} 次重试失败: ${error.message} ${isStillRetryable ? '[仍可重试]' : '[不可重试]'}`)
              return { 
                synced: false, 
                archived: false, 
                finalized: false,
                accountId,
                ownerId,
                timezoneName,
                isStillRetryable
              }
            }
          })
        )
        
        const retryResults = await Promise.all(retryTasks)
        
        // 更新统计：用重试结果更新原结果
        retryResults.forEach((retryResult) => {
          const originalIndex = results.findIndex(r => r.accountId === retryResult.accountId)
          if (originalIndex >= 0 && retryResult.synced) {
            results[originalIndex].synced = true
            syncedAccounts++
          }
        })
        
        // 统计本次重试结果
        const attemptSuccess = retryResults.filter(r => r.synced).length
        const attemptFailed = retryResults.filter(r => !r.synced).length
        
        totalRetrySuccess += attemptSuccess
        totalRetryFailed += attemptFailed
        
        logger.info(`\n📊 第 ${attempt} 次重试结果:`)
        logger.info(`   - 重试成功: ${attemptSuccess} 个`)
        logger.info(`   - 重试失败: ${attemptFailed} 个`)
        
        // 更新剩余需要重试的账户（只保留仍可重试的失败账户）
        remainingAccounts = retryResults
          .filter(r => !r.synced && r.isStillRetryable)
          .map(r => ({
            accountId: r.accountId,
            ownerId: r.ownerId,
            timezoneName: r.timezoneName,
            syncError: { message: r.syncError?.message || '重试失败', isRetryable: true }
          }))
        
        // 如果所有账户都成功了或都不可重试，提前退出
        if (remainingAccounts.length === 0) {
          logger.info(`✅ 所有账户重试完成（成功或不可重试）`)
          break
        }
      }
      
      logger.info(`\n🔄 重试完成（共 ${RETRY_MAX_ATTEMPTS} 次尝试）:`)
      logger.info(`   - 重试成功: ${totalRetrySuccess} 个`)
      logger.info(`   - 重试失败: ${totalRetryFailed} 个`)
    }
    
    // 收集有实际数据更新的账户ID列表（AdsPolar 优化：真正的"零空转"）
    // 只有同步成功且确实有数据更新的账户才触发规则执行
    const syncedAccountIds = results
      .filter(r => r.synced && r.dataUpdated && r.accountId)
      .map(r => String(r.accountId))
    
    // 调试日志：显示数据更新统计
    const totalSynced = results.filter(r => r.synced).length
    const totalDataUpdated = results.filter(r => r.synced && r.dataUpdated).length
    if (totalSynced > 0) {
      logger.info(`📊 数据更新统计: 同步成功=${totalSynced}, 有数据更新=${totalDataUpdated}`)
    }
    
    const duration = Date.now() - startTime
    logger.info('\n' + '='.repeat(50))
    logger.info(`✅ 统一心跳同步完成`)
    logger.info(`📊 统计:`)
    logger.info(`   - 账户总数: ${accounts.length}`)
    logger.info(`   - 同步账户: ${syncedAccounts}`)
    logger.info(`   - 归档账户: ${archivedAccounts}`)
    logger.info(`   - 对账账户: ${finalizedAccounts}`)
    logger.info(`⏱️  耗时: ${duration}ms`)
    logger.info('='.repeat(50))
    logger.info('')
    
    return {
      success: true,
      totalAccounts: accounts.length,
      syncedAccounts,
      archivedAccounts,
      finalizedAccounts,
      syncedAccountIds, // AdsPolar 流水线：返回有实际数据更新的账户ID列表，用于触发规则执行
      durationMs: duration
    }
  } catch (error) {
    logger.error('❌ 统一心跳同步失败:', error.message)
    throw error
  } finally {
    // 释放进程内标志位
    heartbeatRunning = false
    
    // 【问题3修复】在同一连接上释放锁（必须在获取锁的同一连接上释放）
    if (lockAcquired && lockConnection) {
      try {
        // 在同一连接上释放锁（关键修复）
        await lockConnection.query(`SELECT RELEASE_LOCK(?)`, [HEARTBEAT_LOCK_NAME])
        logger.info('✅ 统一心跳锁已释放')
      } catch (releaseError) {
        logger.warn('⚠️  释放统一心跳锁失败:', releaseError.message)
      } finally {
        // 释放锁后再释放连接
        lockConnection.release()
        lockConnection = null
      }
    } else if (lockConnection) {
      // 如果获取锁失败但连接还存在，释放连接
      lockConnection.release()
      lockConnection = null
    }
  }
}

/**
 * 检查并执行双窗口归档
 * 依据：TASKS.md 1.4 - 账户本地时间 ≥02:00 执行 ARCHIVED，≥12:00 执行 FINALIZED
 * @param {string} accountId - 账户ID
 * @param {number} ownerId - 负责人ID
 * @param {string} timezoneName - 时区
 * @param {DateTime} localTime - 账户本地时间（Luxon DateTime 对象）
 * @returns {Promise<Object>} { archived: boolean, finalized: boolean }
 */
async function checkAndExecuteArchive(accountId, ownerId, timezoneName, localTime) {
  const hour = localTime.hour
  const yesterday = localTime.minus({ days: 1 })
  const targetDateStr = yesterday.toFormat('yyyy-MM-dd')
  
  let archived = false
  let finalized = false
  
  // 检查是否需要执行初步归档（≥02:00）
  if (hour >= 2) {
    const archiveStatus = await getArchiveStatus(accountId, targetDateStr)
    
    if (archiveStatus === null || archiveStatus === 'PENDING') {
      // 执行初步归档（ARCHIVED）
      try {
        logger.info(`   📦 执行初步归档 (date: ${targetDateStr}, status: ${archiveStatus || 'PENDING'} → ARCHIVED)`)
        await executeArchive(accountId, ownerId, timezoneName, targetDateStr, 'ARCHIVED')
        archived = true
      } catch (error) {
        logger.error(`   ❌ 初步归档失败: ${error.message}`)
      }
    } else if (archiveStatus === 'ARCHIVED') {
      logger.info(`   ✅ 已初步归档，跳过 (date: ${targetDateStr})`)
    }
  }
  
  // 检查是否需要执行深度对账（≥12:00）
  if (hour >= 12) {
    const archiveStatus = await getArchiveStatus(accountId, targetDateStr)
    
    if (archiveStatus === 'ARCHIVED') {
      // 执行深度对账覆盖（FINALIZED）
      try {
        logger.info(`   🔍 执行深度对账 (date: ${targetDateStr}, status: ARCHIVED → FINALIZED)`)
        await executeArchive(accountId, ownerId, timezoneName, targetDateStr, 'FINALIZED')
        finalized = true
      } catch (error) {
        logger.error(`   ❌ 深度对账失败: ${error.message}`)
      }
    } else if (archiveStatus === 'FINALIZED') {
      logger.info(`   ✅ 已深度对账，跳过 (date: ${targetDateStr})`)
    }
  }
  
  return { archived, finalized }
}

/**
 * 获取归档状态
 * @param {string} accountId - 账户ID
 * @param {string} targetDateStr - 目标日期（YYYY-MM-DD）
 * @returns {Promise<string|null>} PENDING/ARCHIVED/FINALIZED 或 null（不存在）
 */
async function getArchiveStatus(accountId, targetDateStr) {
  try {
    const [rows] = await pool.execute(
      `SELECT status FROM daily_archive_status 
       WHERE account_id = ? AND target_date = ?`,
      [accountId, targetDateStr]
    )
    return rows.length > 0 ? rows[0].status : null
  } catch (error) {
    logger.error(`获取归档状态失败: ${error.message}`)
    return null
  }
}

/**
 * 执行归档（使用 daily_archive_status 状态流转）
 * @param {string} accountId - 账户ID
 * @param {number} ownerId - 负责人ID
 * @param {string} timezoneName - 时区
 * @param {string} targetDateStr - 目标日期（YYYY-MM-DD）
 * @param {string} targetStatus - 目标状态（ARCHIVED 或 FINALIZED）
 * @returns {Promise<Object>} 归档结果
 */
async function executeArchive(accountId, ownerId, timezoneName, targetDateStr, targetStatus) {
  // 使用专用连接获取锁（修复 GET_LOCK 实现）
  const connection = await pool.getConnection()
  
  try {
    // 在同一连接上获取锁
    const lockName = `archive:${accountId}:${targetDateStr}`
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
    const lockAcquired = lockRows[0]?.acquired === 1
    
    if (!lockAcquired) {
      logger.info(`   ⏸️  锁已被占用，跳过（可能其他实例正在归档）`)
      return { success: false, skipped: true, reason: 'lock_busy' }
    }
    
    try {
      // 计算目标日期的 UTC 时间范围
      const targetDate = DateTime.fromISO(targetDateStr).setZone(timezoneName)
      const startTime = targetDate.startOf('day').toJSDate()
      const endTime = targetDate.endOf('day').toJSDate()
      
      // 执行归档（调用现有的 archiveDailyStats 函数）
      const result = await archiveDailyStats(accountId, timezoneName, targetDate.toJSDate())
      const archivedCount = result.archivedCount || 0
      
      // 更新归档状态表
      await connection.execute(
        `INSERT INTO daily_archive_status (account_id, target_date, status, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE 
           status = VALUES(status),
           updated_at = NOW(),
           last_error = NULL`,
        [accountId, targetDateStr, targetStatus]
      )
      
      logger.info(`   ✅ 归档完成，共 ${archivedCount} 条记录，状态: ${targetStatus}`)
      
      return {
        success: true,
        archivedCount,
        status: targetStatus
      }
    } finally {
      // 在同一连接上释放锁
      await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
    }
  } catch (error) {
    // 更新错误信息到状态表
    try {
      await connection.execute(
        `INSERT INTO daily_archive_status (account_id, target_date, status, updated_at, last_error)
         VALUES (?, ?, 'PENDING', NOW(), ?)
         ON DUPLICATE KEY UPDATE 
           last_error = VALUES(last_error),
           updated_at = NOW()`,
        [accountId, targetDateStr, error.message]
      )
    } catch (updateError) {
      logger.error(`更新归档状态失败: ${updateError.message}`)
    }
    
    throw error
  } finally {
    // 释放连接
    connection.release()
  }
}

/**
 * 清理 ad_snapshots 热表：删除超过 2 天的历史快照，保持热表轻量
 * TASKS §1.7：synced_at < NOW() - INTERVAL 2 DAY
 * 保留最近 2 天数据，确保昨日真空期兜底查询不受影响
 * @returns {Promise<{ success: boolean, deleted: number, error?: string }>}
 */
export async function cleanupAdSnapshots() {
  try {
    const [result] = await pool.execute(
      `DELETE FROM ad_snapshots WHERE synced_at < NOW() - INTERVAL 2 DAY`
    )
    const deleted = result?.affectedRows ?? 0
    if (deleted > 0) {
      logger.info(`🧹 [热表清理] ad_snapshots 删除 ${deleted} 条超过 2 天的历史快照`)
    }
    return { success: true, deleted }
  } catch (error) {
    logger.error(`❌ [热表清理] ad_snapshots 清理失败:`, error.message)
    return { success: false, deleted: 0, error: error.message }
  }
}

// ============================================
// 导出所有函数
// ============================================

/**
 * 获取写入队列统计信息（用于监控和优雅退出）
 */
export function getWriteQueueStats() {
  return {
    queueLength: writeQueue.length,
    isWriting,
    stats: { ...writeStats }
  }
}

// 注意：getWriteQueueStats 已通过 export function 导出，不需要在这里重复导出

export {
  generateSyncSessionId,
  fetchInsightsInBatches,
  saveSnapshotsToDb,
  parseActions,
  pickCostPerActionType,
  extractUcpc,
  extractPurchaseValue,
  extractActionCount,
  // 导出写入队列相关函数（用于优雅退出）
  processWriteQueue,
  // 导出归档状态表相关函数（用于 TASKS §1.6 测试）
  checkAndExecuteArchive,
  getArchiveStatus,
  executeArchive
  // cleanupAdSnapshots 已通过 export async function 导出，不在此重复
  // unifiedHeartbeatSync 已在上面通过 export async function 导出，不需要在这里重复导出
  // getWriteQueueStats 已通过 export function 导出，不需要在这里重复导出
}


