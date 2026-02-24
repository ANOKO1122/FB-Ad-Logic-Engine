// 规则数据查询服务
// 按照方案B+优化版-最终版.md 阶段4的要求实现
// 负责智能路由、06:00边界降级、动态聚合计算

import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { DateTime } from 'luxon'
import { calculateTimeWindow, getTimeWindowForQuery } from '../utils/timeWindow.js'

// 注意：DateTime 已在顶部导入，queryMultiDayWithToday 中可以直接使用

/**
 * 智能路由：根据时间窗口选择数据源
 * @param {string} timeWindow - 时间窗口类型：'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'lifetime'
 * @param {string} timezoneName - 账户时区（用于判断是否在 06:00 前）
 * @returns {Object} 路由信息 { source, needAggregation, fallback }
 * 
 * 【为什么需要智能路由？】
 * - today：数据在 ad_snapshots（热数据，实时更新）
 * - yesterday：数据在 daily_stats（冷数据，06:00 归档），但 06:00 前需要降级
 * - last_3_days/last_7_days：数据在 daily_stats（多天聚合），需要动态重算
 */
function selectDataSource(timeWindow, timezoneName = 'UTC') {
  switch (timeWindow) {
    case 'today':
      // 第1-4行：Today → ad_snapshots（热数据，毫秒级响应）
      // needAggregation: false 表示单天数据，不需要聚合
      // 注意：读侧统一由 calculateSingleDayMetrics 计算口径；API ROAS 仅作为兜底值（DB 字段 roas）
      return { 
        source: 'ad_snapshots', 
        needAggregation: false,  // 单天不需要聚合
        useApiValues: true       // 兼容字段（当前不作为“直接用 API 派生值”的开关）
      }
    
    case 'yesterday':
      // 第5-12行：Yesterday → daily_stats（冷数据，06:00 归档）
      // 如果当前时间在 06:00 之前，说明昨日数据还未归档，需要降级到 ad_snapshots
      // isBeforeArchiveTime 函数会判断当前时间（账户时区）是否早于今日 06:00
      if (isBeforeArchiveTime(timezoneName)) {
        return { 
          source: 'ad_snapshots', 
          needAggregation: false,  // 单天不需要聚合
          fallback: true           // 标记为降级查询
        }
      }
      // 第13-15行：如果已经过了 06:00，可以使用 daily_stats（冷数据已归档）
      return { 
        source: 'daily_stats', 
        needAggregation: false   // 单天不需要聚合
      }
    
    case 'last_3_days':  // 统一命名（不是 last_3d）
    case 'last_7_days':   // 统一命名（不是 last_7d）
    case 'last_30_days':  // 优先级2任务：扩展时间窗口支持
    case 'lifetime':
      // 第16-19行：多天窗口 → daily_stats（冷数据，已聚合）
      // needAggregation: true 表示需要动态重算单价/比率类指标（避免辛普森悖论）
      return { 
        source: 'daily_stats', 
        needAggregation: true    // 多天需要聚合
      }
    
    case 'custom_range':
      // 自定义时间范围：根据跨度决定数据源
      // 如果跨度 <= 1 天，优先使用 ad_snapshots（实时数据）
      // 如果跨度 > 1 天，使用 daily_stats（需要聚合）
      // 注意：这里暂时返回 daily_stats，实际判断在 queryRuleData 中根据 customRange 计算
      return { 
        source: 'daily_stats',  // 默认使用 daily_stats（多天场景）
        needAggregation: true,   // 需要聚合
        isCustomRange: true      // 标记为自定义范围
      }
    
    default:
      // 第20行：如果时间窗口类型不支持，抛出错误（避免静默失败）
      throw new Error(`不支持的时间窗口类型: ${timeWindow}`)
  }
}

/**
 * 判断当前时间是否在 06:00 归档时间之前（基于账户时区）
 * @param {string} timezoneName - 账户时区
 * @returns {boolean} 是否在 06:00 之前
 * 
 * 【为什么需要这个函数？】
 * - 冷数据落盘在每天 06:00（账户时区）执行
 * - 如果当前时间在 06:00 之前，说明昨日数据还未归档
 * - 此时需要降级到 ad_snapshots 查询"昨日最后快照"
 */
function isBeforeArchiveTime(timezoneName) {
  // 第1行：获取当前时间（基于账户时区，不是服务器时区）
  const now = DateTime.now().setZone(timezoneName)
  
  // 第2行：设置今日 06:00:00 作为归档时间点
  const archiveTime = now.set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
  
  // 第3行：如果当前时间早于今日 06:00，返回 true（需要降级）
  // 例如：当前是 05:30，返回 true；当前是 07:00，返回 false
  return now < archiveTime
}

/**
 * 获取数据时区（混合方案C：数据时区优先）
 * 为什么需要这个函数？
 * - 查询 today 时，优先使用 ad_snapshots 最新快照的 timezone_name
 * - 如果数据没有 timezone_name，回退到账户时区
 * - 这确保"写入时怎么切日 → 查询时就怎么切日"，不会因为配置变更导致"今天查不到"
 * 
 * @param {string} accountId - 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {string} accountTimezone - 账户时区（兜底值）
 * @returns {Promise<string>} 数据时区（优先使用快照时区，否则使用账户时区）
 */
export async function getDataTimezone(accountId, adIds, accountTimezone) {
  try {
    // 第1-2行：标准化 adIds 为数组
    const adIdArray = Array.isArray(adIds) ? adIds : [adIds]
    if (adIdArray.length === 0) {
      return accountTimezone  // 如果没有广告ID，直接返回账户时区
    }
    
    // 第3-12行：查询最新快照的 timezone_name
    // 为什么只查最新快照？因为同一账户的所有广告应该在同一时区同步
    // 取最新快照的 timezone_name 作为数据时区，确保与写入时一致
    // 
    // 注意：不能使用 SELECT DISTINCT + ORDER BY synced_at（synced_at 不在 SELECT 列表中）
    // 解决方案：使用子查询先找到最新的 synced_at，再查询对应的 timezone_name
    const [rows] = await pool.execute(
      `SELECT timezone_name 
       FROM ad_snapshots 
       WHERE account_id = ? 
         AND ad_id IN (${adIdArray.map(() => '?').join(', ')})
         AND timezone_name IS NOT NULL 
         AND timezone_name != ''
         AND synced_at = (
           SELECT MAX(synced_at) 
           FROM ad_snapshots 
           WHERE account_id = ? 
             AND ad_id IN (${adIdArray.map(() => '?').join(', ')})
             AND timezone_name IS NOT NULL 
             AND timezone_name != ''
         )
       LIMIT 1`,
      [accountId, ...adIdArray, accountId, ...adIdArray]
    )
    
    // 第9-10行：如果查询到 timezone_name，使用它；否则回退到账户时区
    if (rows.length > 0 && rows[0].timezone_name) {
      return rows[0].timezone_name
    }
    
    // 第11行：如果没有查询到，回退到账户时区
    return accountTimezone
  } catch (error) {
    // 第12-13行：如果查询失败，记录警告但回退到账户时区（优雅降级）
    logger.warn(`⚠️  获取数据时区失败，使用账户时区 ${accountTimezone}:`, error.message)
    return accountTimezone
  }
}

/**
 * 查询规则数据（主入口函数）
 * @param {string} accountId - Facebook 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {string} timeWindow - 时间窗口类型：'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'last_30_days' | 'lifetime' | 'custom_range'
 * @param {string} timezoneName - 账户时区（可选，如果不提供则从数据库查询）
 * @param {Object} customRange - 自定义时间范围（仅当 timeWindow='custom_range' 时使用）：{ since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' }
 * @returns {Promise<{data: Array, warnings: Array}>} 返回对象，包含数据数组和警告信息
 *   - data: 广告数据数组（已聚合，如果多天窗口）
 *   - warnings: 警告信息数组（如 HISTORY_EMPTY、TIMEZONE_MISMATCH）
 * 
 * 【函数执行流程】
 * 1. 获取账户时区（如果未提供）
 * 2. 数据时区优先（混合方案C）：如果是 today 查询，优先使用快照时区
 * 3. 智能路由：选择数据源（ad_snapshots 或 daily_stats）
 * 4. 查询数据（根据路由调用不同的查询函数）
 * 5. 如果需要聚合，进行动态聚合计算
 * 6. 返回结果
 * 
 * @example
 * // 查询单个广告的今日数据
 * const data = await queryRuleData('act_123', 'ad_456', 'today', 'Asia/Shanghai')
 * 
 * // 查询多个广告的过去3天数据
 * const data = await queryRuleData('act_123', ['ad_456', 'ad_789'], 'last_3_days', 'Asia/Shanghai')
 */
export async function queryRuleData(accountId, adIds, timeWindow, timezoneName = null, customRange = null) {
  // 第1-3行：获取账户时区（如果未提供）
  // 为什么需要这一步？因为调用方可能不传时区，我们需要从数据库查询
  // 使用 await 等待异步查询完成
  if (!timezoneName) {
    timezoneName = await getAccountTimezone(accountId)
  }
  
  // 第4-8行：数据时区优先（混合方案C）
  // today：优先使用 ad_snapshots 最新快照的 timezone_name
  // 多天窗口：使用账户时区作为 data_timezone_used（与 daily_stats 归档时写入的 timezone_name 一致）
  // 这确保"写入时怎么切日 → 查询时就怎么切日"，不会因为配置变更导致"今天查不到"
  let dataTimezoneUsed = timezoneName  // 默认使用账户时区
  if (timeWindow === 'today') {
    // today 查询：优先使用快照时区
    dataTimezoneUsed = await getDataTimezone(accountId, adIds, timezoneName)
  }
  // 多天窗口（last_3_days/last_7_days/last_30_days/custom_range）：使用账户时区
  // 因为 daily_stats 归档时使用的是账户时区，所以查询时也应该用账户时区
  
  // 第9行：智能路由：根据时间窗口选择数据源
  // 返回路由信息：{ source: 'ad_snapshots', needAggregation: false, ... }
  // 注意：路由判断仍使用账户时区（用于 06:00 归档判断），但查询时使用 dataTimezoneUsed
  const route = selectDataSource(timeWindow, timezoneName)
  
  // 优先级2任务：custom_range 特殊处理
  // 如果 timeWindow 是 custom_range，需要根据跨度决定数据源
  if (timeWindow === 'custom_range') {
    if (!customRange || !customRange.since || !customRange.until) {
      throw new Error('custom_range 需要提供 customRange 参数，格式：{ since: "YYYY-MM-DD", until: "YYYY-MM-DD" }')
    }
    
    // 计算时间窗口以获取跨度（calculateTimeWindow 已在文件顶部导入）
    const timeWindowResult = calculateTimeWindow('custom_range', dataTimezoneUsed, customRange)
    const daysDiff = Math.ceil(timeWindowResult.end.diff(timeWindowResult.start, 'days').days)
    
    // 如果跨度 <= 1 天，使用 ad_snapshots（实时数据）
    // 如果跨度 > 1 天，使用 daily_stats（需要聚合）
    if (daysDiff <= 1) {
      route.source = 'ad_snapshots'
      route.needAggregation = false
    } else {
      route.source = 'daily_stats'
      route.needAggregation = true
    }
  }
  
  // 第10-11行：初始化数据数组，准备存储查询结果
  // 根据路由信息，调用不同的查询函数
  let rawData = []
  
  // 第12-17行：根据路由选择数据源，调用对应的查询函数
  // 如果路由指向 ad_snapshots（热数据），调用 queryAdSnapshots（使用 dataTimezoneUsed）
  // 如果路由指向 daily_stats（冷数据），调用 queryDailyStats（使用 dataTimezoneUsed，不是 timezoneName）
  // route.fallback 表示是否为降级查询（yesterday 在 06:00 前）
  // 阶段A修复：多天窗口也使用 data_timezone_used，确保时区匹配
  let warnings = []  // 初始化 warnings 数组，用于记录降级等信息
  
  if (route.source === 'ad_snapshots') {
    rawData = await queryAdSnapshots(accountId, adIds, timeWindow, dataTimezoneUsed, route.fallback, customRange)
  } else if (route.source === 'daily_stats') {
    // 阶段B：合并查询（历史+今天）
    // 对于多天窗口（last_3_days/last_7_days/last_30_days/custom_range），使用合并查询
    // 历史段（start → 昨天）：从 daily_stats 查询
    // 今天段：从 ad_snapshots 查询（今天最后快照）
    // 合并后调用 aggregateMultiDayMetrics 聚合
    if (route.needAggregation) {
      // 多天窗口：使用合并查询
      const mergedResult = await queryMultiDayWithToday(accountId, adIds, timeWindow, dataTimezoneUsed, customRange)
      rawData = mergedResult.data
      warnings.push(...mergedResult.warnings)
    } else {
      // 单天窗口（yesterday）：直接查询 daily_stats
      rawData = await queryDailyStats(accountId, adIds, timeWindow, dataTimezoneUsed, customRange)
      
      // 阶段A-2：降级策略（快速止血）- 仅用于 yesterday
      // 如果 daily_stats 查询结果为空，降级到 ad_snapshots
      if (rawData.length === 0 && timeWindow === 'yesterday') {
        warnings.push({
          code: 'HISTORY_EMPTY',
          message: '历史数据（daily_stats）为空，已降级到实时数据（ad_snapshots）查询昨日最后快照'
        })
        
        // 降级：查询昨日最后快照
        rawData = await queryAdSnapshots(accountId, adIds, 'yesterday', dataTimezoneUsed, true, null)
      }
    }
  }
  
  // 第18-21行：如果需要聚合（多天窗口），进行动态聚合计算
  // 为什么需要聚合？因为多天窗口必须用"总分子/总分母"重算，避免辛普森悖论
  // aggregateMultiDayMetrics 函数会按 ad_id 分组，然后重算所有单价/比率类指标
  // 注意：queryMultiDayWithToday 已经做了聚合，这里不需要再次聚合
  let resultData = []
  if (route.needAggregation && rawData.length > 0) {
    // queryMultiDayWithToday 已经聚合过了，直接使用
    resultData = rawData
  } else {
    // 第22-23行：单天数据直接返回，但需要计算单价/比率类指标（含除零保护）
    // calculateSingleDayMetrics 函数会确保所有除法运算都有分母检查
    resultData = rawData.map(day => calculateSingleDayMetrics(day))
  }
  
  // 阶段A-2：返回数据数组和 warnings
  // 修改返回值结构，支持 warnings 传递到 API 层
  return {
    data: resultData,
    warnings: warnings
  }
}

// ============================================
// 数据查询函数
// ============================================

/**
 * 从 ad_snapshots 表查询数据（热数据）
 * @param {string} accountId - 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {string} timeWindow - 时间窗口
 * @param {string} timezoneName - 时区
 * @param {boolean} isFallback - 是否为降级查询（yesterday 在 06:00 前）
 * @returns {Promise<Array>} 数据数组
 * 
 * 【为什么需要这个函数？】
 * - today：查询今日最新快照（实时数据）
 * - yesterday（降级）：查询昨日最后快照（06:00 前，daily_stats 未归档）
 * - 使用 ROW_NUMBER() 窗口函数取每个广告的最后一次快照（MySQL 8.0+）
 * - 要求 MySQL 8.0+（today、yesterday fallback、custom_range 均使用窗口函数）
 */
async function queryAdSnapshots(accountId, adIds, timeWindow, timezoneName, isFallback = false, customRange = null) {
  try {
    // 第1-4行：标准化 adIds 为数组
    // 为什么需要这一步？因为调用方可能传单个字符串或数组，统一处理更安全
    // Array.isArray 判断是否为数组，如果不是则包装成数组
    // 如果 adIds 为 null 或 undefined，表示查询所有广告，不需要过滤 ad_id
    const adIdArray = adIds == null ? null : (Array.isArray(adIds) ? adIds : [adIds])
    const hasAdFilter = adIdArray != null && adIdArray.length > 0
    
    // 第5-12行：计算时间窗口的起止时间
    // today / yesterday fallback：用 data_date（自然日）过滤，避免 synced_at/UTC 边界问题
    const { start, end } = calculateTimeWindow(timeWindow, timezoneName, customRange)
    const startUTC = start.toUTC()
    const endUTC = end.toUTC()
    const startDate = startUTC.toFormat('yyyy-MM-dd HH:mm:ss')
    const endDate = endUTC.toFormat('yyyy-MM-dd HH:mm:ss')
    const todayDateStr = timeWindow === 'today' ? start.toFormat('yyyy-MM-dd') : null
    const yesterdayDateStr = (isFallback && timeWindow === 'yesterday') ? start.toFormat('yyyy-MM-dd') : null
    const customSingleDateStr = (timeWindow === 'custom_range' && customRange?.since && customRange.since === customRange.until) ? customRange.since : null

    // 第8-9行：初始化 SQL 和参数数组
    // 使用参数化查询（? 占位符）防止 SQL 注入攻击
    let sql = ''
    const params = []
    
    // 第10-40行：根据是否为降级查询，构建不同的 SQL
    // 降级查询（isFallback=true）：用 ROW_NUMBER 取每 ad 昨日最后快照（要求 MySQL 8.0+）
    // 普通查询：使用 ROW_NUMBER() 窗口函数（MySQL 8.0+）
    if (isFallback && timeWindow === 'yesterday') {
      // 降级查询：取"昨日最后快照"（用 data_date=昨天，自然日口径，ROW_NUMBER 范式避免同秒多行重复）
      sql = `
        SELECT * FROM (
          SELECT 
            account_id,
            ad_id,
            ad_name,
            ad_set_id,
            campaign_id,
            owner_id,
            status,
            spend,
            purchases,
            link_clicks,
            unique_link_clicks,
            purchase_value,
            add_to_cart_count,
            initiate_checkout_count,
            add_payment_info_count,
            cpc,
            roas,
            ucpc,
            cpa,
            add_to_cart_cost,
            checkout_cost,
            payment_cost,
            mute_until,
            mute_reason,
            synced_at,
            ROW_NUMBER() OVER (
              PARTITION BY account_id, ad_id
              ORDER BY synced_at DESC, id DESC
            ) as rn
          FROM ad_snapshots
          WHERE account_id = ?
            ${hasAdFilter ? `AND ad_id IN (${adIdArray.map(() => '?').join(', ')})` : ''}
            AND data_date = ?
        ) ranked
        WHERE rn = 1
      `
      params.push(accountId)
      if (hasAdFilter) {
        params.push(...adIdArray)
      }
      params.push(yesterdayDateStr)
    } else {
      // 普通查询
      // today：用 data_date = 账户时区今日（自然日），避免 synced_at/UTC 边界
      // 其他窗口：用 synced_at 范围
      const adIdFilter = hasAdFilter ? `AND ad_id IN (${adIdArray.map(() => '?').join(', ')})` : ''
      const dateFilter = (timeWindow === 'today' && todayDateStr)
        ? `AND data_date = ?`
        : customSingleDateStr
          ? `AND data_date = ?`
          : `AND synced_at >= ? AND synced_at <= ?`
      sql = `
        SELECT * FROM (
          SELECT 
            account_id,
            ad_id,
            ad_name,
            ad_set_id,
            campaign_id,
            owner_id,
            status,
            spend,
            purchases,
            link_clicks,
            unique_link_clicks,
            purchase_value,
            add_to_cart_count,
            initiate_checkout_count,
            add_payment_info_count,
            cpc,
            roas,
            ucpc,
            cpa,
            add_to_cart_cost,
            checkout_cost,
            payment_cost,
            mute_until,
            mute_reason,
            synced_at,
            ROW_NUMBER() OVER (
              PARTITION BY account_id, ad_id 
              ORDER BY synced_at DESC, id DESC
            ) as rn
          FROM ad_snapshots
          WHERE account_id = ?
            ${adIdFilter}
            ${dateFilter}
        ) ranked
        WHERE rn = 1
      `
      params.push(accountId)
      if (hasAdFilter) {
        params.push(...adIdArray)
      }
      if (timeWindow === 'today' && todayDateStr) {
        params.push(todayDateStr)
      } else if (customSingleDateStr) {
        params.push(customSingleDateStr)
      } else {
        params.push(startDate, endDate)
      }
    }
    
    // 第43-44行：执行查询
    // pool.execute 是 mysql2 的参数化查询方法，自动防止 SQL 注入
    const [rows] = await pool.execute(sql, params)
    
    // 第45-70行：数据转换（将数据库行转换为统一格式）
    // 为什么需要转换？数据库返回的是原始类型（字符串、数字），需要转换为 JavaScript 类型
    // parseFloat/parseInt 确保类型正确，避免后续计算出错
    return rows.map(row => ({
      account_id: row.account_id,
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      ad_set_id: row.ad_set_id,
      campaign_id: row.campaign_id ?? null,
      owner_id: row.owner_id,
      status: row.status,
      // 绝对值指标（直接转换）
      spend: parseFloat(row.spend || 0),
      purchases: parseInt(row.purchases || 0),
      // 原始计数字段（用于动态计算）
      link_clicks: parseInt(row.link_clicks || 0),
      unique_link_clicks: parseInt(row.unique_link_clicks || 0),
      purchase_value: parseFloat(row.purchase_value || 0),
      add_to_cart_count: parseInt(row.add_to_cart_count || 0),
      initiate_checkout_count: parseInt(row.initiate_checkout_count || 0),
      add_payment_info_count: parseInt(row.add_payment_info_count || 0),
      // 单价/比率类指标：映射层不做本地兜底，统一交给 calculateSingleDayMetrics 计算
      cpc: null,
      roas: row.roas != null ? parseFloat(row.roas) : null,
      ucpc: null,
      cpa: row.cpa != null ? parseFloat(row.cpa) : null,
      add_to_cart_cost: row.add_to_cart_cost != null ? parseFloat(row.add_to_cart_cost) : null,
      checkout_cost: row.checkout_cost != null ? parseFloat(row.checkout_cost) : null,
      payment_cost: row.payment_cost != null ? parseFloat(row.payment_cost) : null,
      mute_until: row.mute_until,
      mute_reason: row.mute_reason,
      // 元信息
      synced_at: row.synced_at
    }))
  } catch (error) {
    // 第71-72行：错误处理
    // 记录错误日志（包含账户ID和时间窗口，便于排查问题）
    // 重新抛出错误，让调用方知道查询失败
    logger.error(`❌ 查询 ad_snapshots 失败 (accountId: ${accountId}, timeWindow: ${timeWindow}):`, error.message)
    throw error
  }
}

/**
 * 阶段B：合并查询（历史+今天）
 * 历史段（start → 昨天）：从 daily_stats 查询
 * 今天段：从 ad_snapshots 查询（今天最后快照）
 * 合并后调用 aggregateMultiDayMetrics 聚合
 * 
 * @param {string} accountId - 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {string} timeWindow - 时间窗口（last_3_days/last_7_days/last_30_days/custom_range）
 * @param {string} dataTimezoneUsed - 数据时区（用于查询）
 * @param {Object} customRange - 自定义时间范围（仅当 timeWindow='custom_range' 时使用）
 * @returns {Promise<{data: Array, warnings: Array}>} 返回合并后的数据和 warnings
 */
async function queryMultiDayWithToday(accountId, adIds, timeWindow, dataTimezoneUsed, customRange = null) {
  const warnings = []
  
  // 1. 计算时间窗口（用于确定历史段和今天段）
  const timeWindowResult = calculateTimeWindow(timeWindow, dataTimezoneUsed, customRange)
  const start = timeWindowResult.start
  const end = timeWindowResult.end
  
  // 2. 计算"昨天"的日期（用于拆分历史段和今天段）
  // 使用 dataTimezoneUsed 计算"昨天"，确保与数据时区一致
  const now = DateTime.now().setZone(dataTimezoneUsed)
  const yesterday = now.minus({ days: 1 })
  const yesterdayDate = yesterday.toFormat('yyyy-MM-dd')
  const todayDate = now.toFormat('yyyy-MM-dd')
  
  // 3. 查询历史段（start → 昨天）：从 daily_stats
  let historyData = []
  try {
    // 检查 daily_stats 中是否有数据，以及时区分布
    const adIdArray = adIds == null ? null : (Array.isArray(adIds) ? adIds : [adIds])
    const hasAdFilter = adIdArray != null && adIdArray.length > 0
    
    // 先查询时区分布，检查是否有不匹配
    const [timezoneRows] = await pool.execute(`
      SELECT DISTINCT timezone_name, COUNT(*) as count
      FROM daily_stats
      WHERE account_id = ?
        ${hasAdFilter ? `AND ad_id IN (${adIdArray.map(() => '?').join(', ')})` : ''}
        AND date >= ? AND date <= ?
      GROUP BY timezone_name
    `, [
      accountId,
      ...(hasAdFilter ? adIdArray : []),
      start.toFormat('yyyy-MM-dd'),
      yesterdayDate
    ])
    
    // 步骤1：先用 data_timezone_used 查询历史数据（按自然日计算）
    // daily_stats.date 是 DATE 类型，自然日按 data_timezone_used 计算，不要转 UTC
    const historyCustomRange = {
      since: start.toFormat('yyyy-MM-dd'),
      until: yesterdayDate
    }
    historyData = await queryDailyStatsForRange(accountId, adIds, historyCustomRange, dataTimezoneUsed)
    
    // 步骤2：检查时区不匹配，并确定是否需要二次查询
    let historyQueryTimezone = dataTimezoneUsed  // 默认使用查询时区
    if (timezoneRows.length > 0) {
      const timezones = timezoneRows.map(r => r.timezone_name)
      const hasMismatch = !timezones.includes(dataTimezoneUsed)
      if (hasMismatch) {
        // 时区不匹配：使用数据实际时区查询历史数据（使用第一个时区）
        // 这样可以确保能查询到历史数据，而不是因为时区过滤导致空结果
        historyQueryTimezone = timezones[0]
        warnings.push({
          code: 'TIMEZONE_MISMATCH',
          message: `历史数据时区（${timezones.join(', ')}）与查询时区（${dataTimezoneUsed}）不匹配，已使用数据时区（${historyQueryTimezone}）查询历史数据`
        })
        
        // 如果第一次查询（用 data_timezone_used）结果为空，二次尝试用数据实际时区查询
        if (historyData.length === 0) {
          historyData = await queryDailyStatsForRange(accountId, adIds, historyCustomRange, historyQueryTimezone)
        }
      }
    }
    
    // 步骤3：如果历史数据为空，记录 warning（但只有在确实没有数据时才记录）
    // 判断逻辑：
    // - 如果 timezoneRows.length === 0：说明时区检查也没有找到数据，确实为空
    // - 如果 timezoneRows.length > 0 但 historyData.length === 0：说明即使用了数据实际时区查询仍为空
    // 这两种情况都应该记录 HISTORY_EMPTY
    if (historyData.length === 0) {
      if (timezoneRows.length === 0) {
        // 时区检查也没有找到数据，确实为空
        warnings.push({
          code: 'HISTORY_EMPTY',
          message: '历史数据（daily_stats）为空，仅返回今天的数据'
        })
      } else {
        // 检测到有数据但时区不匹配，且用数据实际时区查询后仍为空
        // 这种情况可能是：数据存在但日期范围不匹配，或者确实没有数据
        warnings.push({
          code: 'HISTORY_EMPTY',
          message: `历史数据（daily_stats）在指定时间范围内为空，仅返回今天的数据（检测到时区不匹配：${timezoneRows.map(r => r.timezone_name).join(', ')}）`
        })
      }
    }
  } catch (error) {
    logger.warn(`⚠️  查询历史数据失败，仅使用今天的数据:`, error.message)
    warnings.push({
      code: 'HISTORY_QUERY_FAILED',
      message: `查询历史数据失败: ${error.message}，仅返回今天的数据`
    })
  }
  
  // 4. 查询今天段：从 ad_snapshots（今天最后快照）
  let todayData = []
  try {
    todayData = await queryAdSnapshots(accountId, adIds, 'today', dataTimezoneUsed, false, null)
  } catch (error) {
    logger.warn(`⚠️  查询今天数据失败:`, error.message)
    warnings.push({
      code: 'TODAY_QUERY_FAILED',
      message: `查询今天数据失败: ${error.message}`
    })
  }
  
  // 5. 合并数据（历史 + 今天）
  const mergedData = [...historyData, ...todayData]
  
  // 6. 如果合并后数据为空，返回空结果
  if (mergedData.length === 0) {
    return { data: [], warnings }
  }
  
  // 7. 聚合合并后的数据（避免辛普森悖论）
  const aggregated = aggregateMultiDayMetrics(mergedData)
  
  return {
    data: aggregated,
    warnings
  }
}

/**
 * 从 daily_stats 表查询指定日期范围的数据（辅助函数）
 * @param {string} accountId - 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {Object} dateRange - 日期范围：{ since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' }
 * @param {string} timezoneName - 时区
 * @returns {Promise<Array>} 数据数组
 */
async function queryDailyStatsForRange(accountId, adIds, dateRange, timezoneName) {
  try {
    const adIdArray = adIds == null ? null : (Array.isArray(adIds) ? adIds : [adIds])
    const hasAdFilter = adIdArray != null && adIdArray.length > 0
    
    const sql = `
      SELECT 
        account_id,
        ad_id,
        ad_name,
        ad_set_id,
        campaign_id,
        owner_id,
        date,
        timezone_name,
        spend,
        purchases,
        link_clicks,
        unique_link_clicks,
        purchase_value,
        add_to_cart_count,
        initiate_checkout_count,
        add_payment_info_count,
        cpc,
        roas,
        add_to_cart as add_to_cart_count_legacy
      FROM daily_stats
      WHERE account_id = ?
        ${hasAdFilter ? `AND ad_id IN (${adIdArray.map(() => '?').join(', ')})` : ''}
        AND date >= ? AND date <= ?
        AND timezone_name = ?
      ORDER BY ad_id, date ASC
    `
    
    const params = [accountId]
    if (hasAdFilter) {
      params.push(...adIdArray)
    }
    params.push(dateRange.since, dateRange.until, timezoneName)
    
    const [rows] = await pool.execute(sql, params)
    
    return rows.map(row => ({
      account_id: row.account_id,
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      ad_set_id: row.ad_set_id,
      campaign_id: row.campaign_id ?? null,
      owner_id: row.owner_id,
      date: row.date,
      timezone_name: row.timezone_name,
      spend: parseFloat(row.spend || 0),
      purchases: parseInt(row.purchases || 0),
      link_clicks: parseInt(row.link_clicks || 0),
      unique_link_clicks: parseInt(row.unique_link_clicks || 0),
      purchase_value: parseFloat(row.purchase_value || 0),
      add_to_cart_count: parseInt(row.add_to_cart_count || row.add_to_cart_count_legacy || 0),
      initiate_checkout_count: parseInt(row.initiate_checkout_count || 0),
      add_payment_info_count: parseInt(row.add_payment_info_count || 0),
      cpc: null,
      roas: row.roas != null ? parseFloat(row.roas) : null
    }))
  } catch (error) {
    logger.error(`❌ 查询 daily_stats 失败 (accountId: ${accountId}):`, error.message)
    throw error
  }
}

/**
 * 从 daily_stats 表查询数据（冷数据）
 * @param {string} accountId - 账户ID
 * @param {string|Array} adIds - 广告ID（单个或数组）
 * @param {string} timeWindow - 时间窗口
 * @param {string} timezoneName - 时区
 * @returns {Promise<Array>} 数据数组（多天窗口返回多行，单天窗口返回单行）
 * 
 * 【为什么需要这个函数？】
 * - yesterday：查询单天数据（已归档的昨日数据）
 * - last_3_days/last_7_days：查询多天数据（需要后续聚合计算）
 * - daily_stats 表存储的是每日汇总数据（每天 06:00 归档）
 * - 注意：多天窗口返回多行（每天一行），需要后续聚合
 */
async function queryDailyStats(accountId, adIds, timeWindow, timezoneName, customRange = null) {
  try {
    // 第1-4行：标准化 adIds 为数组（与 queryAdSnapshots 相同逻辑）
    // 如果 adIds 为 null 或 undefined，表示查询所有广告，不需要过滤 ad_id
    const adIdArray = adIds == null ? null : (Array.isArray(adIds) ? adIds : [adIds])
    const hasAdFilter = adIdArray != null && adIdArray.length > 0
    
    // 第5-7行：计算时间窗口的起止日期（只取日期部分，不包含时间）
    // 为什么只取日期？因为 daily_stats 表的 date 字段是 DATE 类型，不是 DATETIME
    // 优先级2任务：支持 custom_range（传递 customRange 参数）
    const { start, end } = calculateTimeWindow(timeWindow, timezoneName, customRange)
    const startDate = start.toFormat('yyyy-MM-dd')  // 只取日期部分
    const endDate = end.toFormat('yyyy-MM-dd')
    
    // 第8-30行：构建查询 SQL
    // 注意：daily_stats 表的字段名可能与 ad_snapshots 略有不同
    // 根据迁移脚本，daily_stats 包含：spend, cpc, roas, purchases, add_to_cart, actions,
    // link_clicks, unique_link_clicks, purchase_value, add_to_cart_count, initiate_checkout_count, add_payment_info_count, ad_set_id
    const sql = `
      SELECT 
        account_id,
        ad_id,
        ad_name,
        ad_set_id,
        campaign_id,
        owner_id,
        date,
        timezone_name,
        spend,
        purchases,
        link_clicks,
        unique_link_clicks,
        purchase_value,
        add_to_cart_count,
        initiate_checkout_count,
        add_payment_info_count,
        cpc,
        roas,
        add_to_cart as add_to_cart_count_legacy  -- 兼容旧字段名（如果存在）
      FROM daily_stats
      WHERE account_id = ?
        ${hasAdFilter ? `AND ad_id IN (${adIdArray.map(() => '?').join(', ')})` : ''}
        AND date >= ?
        AND date <= ?
        AND timezone_name = ?
      ORDER BY ad_id, date ASC
    `
    
    // 第31行：填充参数
    const params = [accountId]
    if (hasAdFilter) {
      params.push(...adIdArray)
    }
    params.push(startDate, endDate, timezoneName)
    
    // 第32-33行：执行查询
    const [rows] = await pool.execute(sql, params)
    
    // 第34-55行：数据转换（将数据库行转换为统一格式）
    // 为什么需要转换？确保数据类型正确，便于后续计算
    return rows.map(row => ({
      account_id: row.account_id,
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      ad_set_id: row.ad_set_id,
      campaign_id: row.campaign_id ?? null,
      owner_id: row.owner_id,
      date: row.date,
      timezone_name: row.timezone_name,
      // 绝对值指标（直接转换）
      spend: parseFloat(row.spend || 0),
      purchases: parseInt(row.purchases || 0),
      // 原始计数字段（用于动态计算）
      link_clicks: parseInt(row.link_clicks || 0),
      unique_link_clicks: parseInt(row.unique_link_clicks || 0),
      purchase_value: parseFloat(row.purchase_value || 0),
      // 兼容旧字段名：如果新字段不存在，使用旧字段
      add_to_cart_count: parseInt(row.add_to_cart_count || row.add_to_cart_count_legacy || 0),
      initiate_checkout_count: parseInt(row.initiate_checkout_count || 0),
      add_payment_info_count: parseInt(row.add_payment_info_count || 0),
      // 单价/比率类指标：映射层不做本地兜底
      cpc: null,
      roas: row.roas != null ? parseFloat(row.roas) : null
    }))
  } catch (error) {
    // 第56-57行：错误处理
    logger.error(`❌ 查询 daily_stats 失败 (accountId: ${accountId}, timeWindow: ${timeWindow}):`, error.message)
    throw error
  }
}

// ============================================
// 动态聚合计算
// ============================================

/**
 * 多天聚合计算（必须动态重算，避免辛普森悖论）
 * 参考：方案B+优化版-最终版.md 第七章
 * 
 * 【为什么必须动态重算？】
 * 辛普森悖论示例：
 * - 第1天：spend=$100, purchases=5, cpa=$20
 * - 第2天：spend=$50, purchases=2, cpa=$25
 * - 错误做法：平均 cpa = (20 + 25) / 2 = $22.5 ❌
 * - 正确做法：总 cpa = (100 + 50) / (5 + 2) = $21.43 ✅
 * 
 * @param {Array} dailyStatsArray - 多天的 daily_stats 数据（可能包含多个广告）
 * @returns {Array} 聚合后的指标数组（每个广告一条记录）
 * 
 * @example
 * // 输入：3天的数据（同一广告）
 * const aggregated = aggregateMultiDayMetrics([
 *   { ad_id: 'ad_1', spend: 100, purchases: 5, purchase_value: 150, link_clicks: 20 },
 *   { ad_id: 'ad_1', spend: 50, purchases: 2, purchase_value: 40, link_clicks: 10 },
 *   { ad_id: 'ad_1', spend: 30, purchases: 1, purchase_value: 20, link_clicks: 5 }
 * ])
 * // 输出：[{ ad_id: 'ad_1', spend: 180, purchases: 8, roas: 210/180=1.17, cpa: 180/8=22.5, ... }]
 */
function aggregateMultiDayMetrics(dailyStatsArray) {
  // 第1-2行：边界检查（防御性编程）
  // 如果输入为空，直接返回空数组，避免后续处理出错
  if (!dailyStatsArray || dailyStatsArray.length === 0) {
    return []
  }
  
  // 第3-10行：按 ad_id 分组（因为可能查询多个广告）
  // 为什么需要分组？因为输入可能包含多个广告的数据，需要分别聚合
  // 使用对象作为 Map，key 是 ad_id，value 是该广告的所有天数据
  const groupedByAd = {}
  for (const day of dailyStatsArray) {
    const adId = day.ad_id
    if (!groupedByAd[adId]) {
      groupedByAd[adId] = []  // 初始化数组
    }
    groupedByAd[adId].push(day)  // 将当天的数据添加到对应广告的数组中
  }
  
  // 第11行：初始化结果数组
  const results = []
  
  // 第12-40行：对每个广告进行聚合计算
  // Object.entries 将对象转换为 [key, value] 数组，便于遍历
  for (const [adId, days] of Object.entries(groupedByAd)) {
    // 第13-25行：累加原始计数（分子和分母）
    // reduce 函数：遍历所有天的数据，累加每个字段
    // 为什么需要累加？因为多天聚合必须用"总分子/总分母"重算
    const totals = days.reduce((acc, day) => ({
      totalSpend: acc.totalSpend + parseFloat(day.spend || 0),
      totalPurchases: acc.totalPurchases + parseInt(day.purchases || 0),
      totalLinkClicks: acc.totalLinkClicks + parseInt(day.link_clicks || 0),
      totalUniqueLinkClicks: acc.totalUniqueLinkClicks + parseInt(day.unique_link_clicks || 0),
      totalPurchaseValue: acc.totalPurchaseValue + parseFloat(day.purchase_value || 0),
      totalAddToCartCount: acc.totalAddToCartCount + parseInt(day.add_to_cart_count || 0),
      totalInitiateCheckoutCount: acc.totalInitiateCheckoutCount + parseInt(day.initiate_checkout_count || 0),
      totalAddPaymentInfoCount: acc.totalAddPaymentInfoCount + parseInt(day.add_payment_info_count || 0)
    }), {
      // 初始化累加器（所有字段从 0 开始）
      totalSpend: 0,
      totalPurchases: 0,
      totalLinkClicks: 0,
      totalUniqueLinkClicks: 0,
      totalPurchaseValue: 0,
      totalAddToCartCount: 0,
      totalInitiateCheckoutCount: 0,
      totalAddPaymentInfoCount: 0
    })
    
    // 第26-70行：动态重算单价/比率类指标（含除零保护）
    // 参考：方案B+优化版-最终版.md 第七章
    // CBO 执行需要 campaign_id：优先取任一天中有的值（多天合并时 today 有、历史可能无）
    const campaignId = days.map(d => d.campaign_id).find(Boolean) ?? days[0].campaign_id ?? null
    const result = {
      // 基本信息（取第一条记录的；campaign_id 见上）
      account_id: days[0].account_id,
      ad_id: adId,
      ad_name: days[0].ad_name,
      ad_set_id: days[0].ad_set_id,
      campaign_id: campaignId,
      owner_id: days[0].owner_id,
      
      // 绝对值指标（直接使用累加值）
      spend: totals.totalSpend,
      purchases: totals.totalPurchases,
      
      // 原始计数字段（累加值）
      link_clicks: totals.totalLinkClicks,
      unique_link_clicks: totals.totalUniqueLinkClicks,
      purchase_value: totals.totalPurchaseValue,
      add_to_cart_count: totals.totalAddToCartCount,
      initiate_checkout_count: totals.totalInitiateCheckoutCount,
      add_payment_info_count: totals.totalAddPaymentInfoCount,
      
      // 单价/比率类指标（必须重算，含除零保护）
      // ROAS：totalSpend==0 => null；有花费但无金额 => 0.0
      roas: totals.totalSpend === 0
        ? null
        : (totals.totalPurchaseValue > 0 ? totals.totalPurchaseValue / totals.totalSpend : 0),
      
      // 其余成本类：分母为 0 返回 null（无数据）
      cpa: totals.totalPurchases > 0 ? totals.totalSpend / totals.totalPurchases : null,
      cpc: totals.totalLinkClicks > 0 ? totals.totalSpend / totals.totalLinkClicks : null,
      ucpc: totals.totalUniqueLinkClicks > 0 ? totals.totalSpend / totals.totalUniqueLinkClicks : null,
      add_to_cart_cost: totals.totalAddToCartCount > 0 ? totals.totalSpend / totals.totalAddToCartCount : null,
      checkout_cost: totals.totalInitiateCheckoutCount > 0 ? totals.totalSpend / totals.totalInitiateCheckoutCount : null,
      payment_cost: totals.totalAddPaymentInfoCount > 0 ? totals.totalSpend / totals.totalAddPaymentInfoCount : null
    }
    
    // 第71行：将结果添加到结果数组
    results.push(result)
  }
  
  // 第72行：返回聚合后的结果
  return results
}

/**
 * 单天指标计算（含除零保护）
 * 
 * 【为什么需要这个函数？】
 * - 单天数据虽然不需要聚合，但需要计算单价/比率类指标
 * - 数据库可能只存储了原始计数（如 link_clicks、purchase_value），需要计算 cpc、roas 等
 * - 所有除法运算都要做除零保护，避免 NaN/Infinity 传播到 UI 层
 * 
 * @param {Object} dailyStats - 单天的数据（来自 ad_snapshots 或 daily_stats）
 * @returns {Object} 计算后的指标（包含所有单价/比率类指标）
 * 
 * @example
 * // 输入：单天数据
 * const result = calculateSingleDayMetrics({
 *   spend: 100,
 *   purchases: 5,
 *   purchase_value: 150,
 *   link_clicks: 20
 * })
 * // 输出：{ spend: 100, purchases: 5, roas: 1.5, cpa: 20, cpc: 5, ... }
 */
function calculateSingleDayMetrics(dailyStats) {
  // 第1-8行：提取原始数据（确保类型正确）
  // 为什么需要 parseFloat/parseInt？数据库返回的可能是字符串，需要转换为数字
  // || 0 表示如果值为 null/undefined，使用 0 作为默认值（防御性编程）
  const spend = parseFloat(dailyStats.spend || 0)
  const purchases = parseInt(dailyStats.purchases || 0)
  const linkClicks = parseInt(dailyStats.link_clicks || 0)
  const uniqueLinkClicks = parseInt(dailyStats.unique_link_clicks || 0)
  const purchaseValue = parseFloat(dailyStats.purchase_value || 0)
  const addToCartCount = parseInt(dailyStats.add_to_cart_count || 0)
  const initiateCheckoutCount = parseInt(dailyStats.initiate_checkout_count || 0)
  const addPaymentInfoCount = parseInt(dailyStats.add_payment_info_count || 0)
  
  // 单天指标统一口径：计算优先 -> API 兜底 -> 零兜底（仅 ROAS）
  const dbRoas = dailyStats.roas != null ? parseFloat(dailyStats.roas) : null
  const roas = spend === 0
    ? null
    : (purchaseValue > 0 ? purchaseValue / spend : (dbRoas != null && dbRoas > 0 ? dbRoas : 0))

  return {
    // 基本信息（直接传递）
    account_id: dailyStats.account_id,
    ad_id: dailyStats.ad_id,
    ad_name: dailyStats.ad_name,
    ad_set_id: dailyStats.ad_set_id,
    campaign_id: dailyStats.campaign_id ?? null,  // CBO 执行层需要
    owner_id: dailyStats.owner_id,
    status: dailyStats.status,
    mute_until: dailyStats.mute_until,
    mute_reason: dailyStats.mute_reason,

    // 绝对值指标（直接使用）
    spend: spend,
    purchases: purchases,

    // 原始计数字段（直接使用）
    link_clicks: linkClicks,
    unique_link_clicks: uniqueLinkClicks,
    purchase_value: purchaseValue,
    add_to_cart_count: addToCartCount,
    initiate_checkout_count: initiateCheckoutCount,
    add_payment_info_count: addPaymentInfoCount,

    // 单价/比率类指标：除 ROAS 外，分母为 0 时返回 null（表示无数据）
    roas: roas,
    cpa: purchases > 0 ? spend / purchases : null,
    cpc: linkClicks > 0 ? spend / linkClicks : null,
    ucpc: uniqueLinkClicks > 0 ? spend / uniqueLinkClicks : null,
    add_to_cart_cost: addToCartCount > 0 ? spend / addToCartCount : null,
    checkout_cost: initiateCheckoutCount > 0 ? spend / initiateCheckoutCount : null,
    payment_cost: addPaymentInfoCount > 0 ? spend / addPaymentInfoCount : null
  }
}

// 导出供单测验证「规则判断一律用本地计算」
export { calculateSingleDayMetrics }

/**
 * 从 account_mappings 表获取账户时区
 * @param {string} accountId - Facebook 账户ID
 * @returns {Promise<string>} 时区名称（如 'Asia/Shanghai'），默认 'UTC'
 * 
 * 【为什么需要这个函数？】
 * - 不同账户可能在不同时区（如美国账户用 America/New_York，中国账户用 Asia/Shanghai）
 * - 计算"昨日"边界时，必须用账户时区，不能用服务器时区
 * - 如果账户未配置时区，使用默认值 'UTC'，避免报错
 */
export async function getAccountTimezone(accountId) {
  try {
    // 第1-2行：执行 SQL 查询，从 account_mappings 表获取时区
    // COALESCE 函数：如果 timezone_name 为 NULL，返回 'UTC'
    // is_active = 1：只查询活跃账户，避免查询到已停用的账户
    const [rows] = await pool.execute(
      `SELECT COALESCE(timezone_name, 'UTC') as timezone_name 
       FROM account_mappings 
       WHERE fb_account_id = ? AND is_active = 1
       LIMIT 1`,
      [accountId]
    )
    
    // 第3-4行：如果查询结果为空，说明账户不存在或已停用
    // 使用默认时区 'UTC'，并记录警告日志（不抛错，保证系统可用性）
    if (rows.length === 0) {
      logger.warn(`⚠️  账户 ${accountId} 未找到，使用默认时区 UTC`)
      return 'UTC'  // 默认时区
    }
    
    // 第5行：返回查询到的时区名称（如果为 NULL，则返回 'UTC'）
    return rows[0].timezone_name || 'UTC'
  } catch (error) {
    // 第6-7行：如果数据库查询出错（如连接失败、SQL 语法错误）
    // 记录错误日志，但返回默认时区，避免整个系统崩溃
    // 这是"优雅降级"策略：即使时区查询失败，系统仍能继续运行
    logger.error(`❌ 获取账户时区失败 (accountId: ${accountId}):`, error.message)
    return 'UTC'  // 出错时使用默认时区
  }
}

