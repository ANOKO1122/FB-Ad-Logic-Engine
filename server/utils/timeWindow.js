// 时间窗口工具模块
// 基于 Luxon 实现时区感知的时间窗口计算
// 按照 DEV_PLAN.md M3 的要求实现

import { DateTime } from 'luxon'

/**
 * 计算时间窗口的起止时间
 * @param {string} timeWindow - 时间窗口类型：'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'last_30_days' | 'lifetime' | 'custom_range'
 * @param {string} timezoneName - 时区名称，如 'Asia/Shanghai' 或 'America/New_York'
 * @param {Object} customRange - 自定义时间范围（仅当 timeWindow='custom_range' 时使用）：{ since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' }
 * @returns {Object} { start: DateTime, end: DateTime, warnings?: Array<string> } 起止时间（Luxon DateTime 对象）和可选的警告信息
 * 
 * @example
 * // 计算上海时区的"今日"时间窗口
 * const { start, end } = calculateTimeWindow('today', 'Asia/Shanghai')
 * console.log(start.toISO()) // 2026-01-15T00:00:00.000+08:00
 * console.log(end.toISO())   // 2026-01-15T23:59:59.999+08:00
 * 
 * // 计算自定义时间范围（时区从账户配置自动获取，不需要用户填写）
 * // 在实际使用中，时区通过 queryRuleData 函数自动从账户配置获取
 * // 这里手动填写时区只是为了演示，实际使用时应该从账户配置获取
 * const { start, end, warnings } = calculateTimeWindow('custom_range', 'Asia/Shanghai', { since: '2026-01-01', until: '2026-01-31' })
 */
export function calculateTimeWindow(timeWindow, timezoneName = 'UTC', customRange = null) {
  // 获取当前时间（基于指定时区）
  const now = DateTime.now().setZone(timezoneName)
  
  let start, end
  
  switch (timeWindow) {
    case 'today':
      // 今日：当天 00:00:00 到 23:59:59.999
      start = now.startOf('day')
      end = now.endOf('day')
      break
      
    case 'yesterday':
      // 昨日：往前推一天
      const yesterday = now.minus({ days: 1 })
      start = yesterday.startOf('day')
      end = yesterday.endOf('day')
      break
      
    case 'last_3_days':
      // 过去 3 天：从 2 天前 00:00:00 到今日 23:59:59.999（包含今天，共 3 天）
      // 为什么是 minus({ days: 2 })？因为要包含今天，所以：
      // - 今天（第 1 天）
      // - 昨天（第 2 天）
      // - 2 天前（第 3 天）
      start = now.minus({ days: 2 }).startOf('day')
      end = now.endOf('day')
      break
      
    case 'last_7_days':
      // 过去 7 天：从 6 天前 00:00:00 到今日 23:59:59.999（包含今天，共 7 天）
      // 为什么是 minus({ days: 6 })？因为要包含今天，所以：
      // - 今天（第 1 天）
      // - 昨天（第 2 天）
      // - ...
      // - 6 天前（第 7 天）
      // 为什么需要这个？ruleDataService.js 已经在使用 last_7_days，但 timeWindow.js 还没有实现
      start = now.minus({ days: 6 }).startOf('day')
      end = now.endOf('day')
      break
      
    case 'last_30_days':
      // 过去 30 天：从 29 天前 00:00:00 到今日 23:59:59.999（包含今天，共 30 天）
      // 为什么是 minus({ days: 29 })？因为要包含今天，所以：
      // - 今天（第 1 天）
      // - 昨天（第 2 天）
      // - ...
      // - 29 天前（第 30 天）
      // 优先级2任务：扩展时间窗口支持
      start = now.minus({ days: 29 }).startOf('day')
      end = now.endOf('day')
      break
      
    case 'lifetime':
      // 累计至今：从广告创建日到当前（这里简化处理，从 1970-01-01 开始）
      // 实际使用时，应该传入广告创建时间
      start = DateTime.fromMillis(0).setZone(timezoneName)  // 1970-01-01
      end = now.endOf('day')
      break
      
    case 'custom_range':
      // 自定义时间范围：从 since 到 until（使用数据时区自然日）
      // 为什么需要这个？允许用户查询任意日期范围的数据
      // 优先级2任务：扩展时间窗口支持
      if (!customRange || !customRange.since || !customRange.until) {
        throw new Error('custom_range 需要提供 customRange 参数，格式：{ since: "YYYY-MM-DD", until: "YYYY-MM-DD" }')
      }
      
      // 验证自定义范围并获取 warnings
      const validation = validateCustomRange(customRange.since, customRange.until, timezoneName)
      
      if (!validation.isValid) {
        // 如果验证失败，抛出错误（包含 warnings 信息）
        throw new Error(`自定义时间范围验证失败: ${validation.warnings.join(', ')}`)
      }
      
      // 使用验证后的日期（已经是数据时区的自然日边界）
      start = validation.sinceDate
      end = validation.untilDate
      
      // 如果有 warnings（如跨度超过 365 天），返回 warnings
      if (validation.warnings.length > 0) {
        return { start, end, warnings: validation.warnings }
      }
      
      break
      
    default:
      throw new Error(`不支持的时间窗口类型: ${timeWindow}`)
  }
  
  return { start, end }
}

/**
 * 将时间窗口转换为 MySQL 日期范围查询条件
 * @param {string} timeWindow - 时间窗口类型
 * @param {string} timezoneName - 时区名称
 * @param {string} dateColumn - 数据库日期字段名（如 'synced_at' 或 'date'）
 * @returns {Object} { startDate: string, endDate: string } MySQL 日期字符串（YYYY-MM-DD HH:mm:ss）
 * 
 * @example
 * // 获取上海时区的"今日"查询条件
 * const { startDate, endDate } = getTimeWindowForQuery('today', 'Asia/Shanghai', 'synced_at')
 * // 返回: { startDate: '2026-01-15 00:00:00', endDate: '2026-01-15 23:59:59' }
 */
export function getTimeWindowForQuery(timeWindow, timezoneName = 'UTC', dateColumn = 'synced_at') {
  const { start, end } = calculateTimeWindow(timeWindow, timezoneName)
  
  // 转换为 MySQL 日期格式（YYYY-MM-DD HH:mm:ss）
  // 注意：Luxon 会自动处理时区转换
  return {
    startDate: start.toFormat('yyyy-MM-dd HH:mm:ss'),
    endDate: end.toFormat('yyyy-MM-dd HH:mm:ss'),
    // 也提供 ISO 格式（用于调试）
    startISO: start.toISO(),
    endISO: end.toISO()
  }
}

/**
 * 验证自定义时间范围并生成 warnings
 * @param {string} since - 开始日期（YYYY-MM-DD）
 * @param {string} until - 结束日期（YYYY-MM-DD）
 * @param {string} timezoneName - 时区名称（从账户配置自动获取，不需要用户填写）
 * @returns {Object} { isValid: boolean, warnings: Array<string>, sinceDate: DateTime|null, untilDate: DateTime|null }
 * 
 * 【验证规则】
 * 1. since/until 必须是有效 ISO 日期格式（YYYY-MM-DD）
 * 2. since <= until（不能反转）
 * 3. 跨度不超过 365 天（业务限制）
 * 4. 时区必须是有效 IANA 名称
 * 
 * 【Warnings 标准化】
 * - INVALID_DATE_FORMAT: 日期格式无效
 * - RANGE_REVERSED: 开始日期晚于结束日期
 * - EXCEEDS_MAX_RANGE: 时间跨度超过 365 天
 * - INVALID_TIMEZONE: 时区无效
 * 
 * 【重要说明】
 * - 时区参数应该从账户配置（account_mappings.timezone_name）自动获取
 * - 用户在前端只需要填写日期（since/until），不需要填写时区
 * - 后端通过 queryRuleData 函数自动获取账户时区，然后传递给此函数
 */
export function validateCustomRange(since, until, timezoneName) {
  const warnings = []
  let sinceDate = null
  let untilDate = null
  
  // 1. 验证时区
  if (!isValidTimezone(timezoneName)) {
    warnings.push('INVALID_TIMEZONE')
    return { isValid: false, warnings, sinceDate: null, untilDate: null }
  }
  
  // 2. 验证日期格式（必须是 YYYY-MM-DD）
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!since || typeof since !== 'string' || !dateRegex.test(since)) {
    warnings.push('INVALID_DATE_FORMAT: since 必须是 YYYY-MM-DD 格式')
    return { isValid: false, warnings, sinceDate: null, untilDate: null }
  }
  
  if (!until || typeof until !== 'string' || !dateRegex.test(until)) {
    warnings.push('INVALID_DATE_FORMAT: until 必须是 YYYY-MM-DD 格式')
    return { isValid: false, warnings, sinceDate: null, untilDate: null }
  }
  
  // 3. 解析日期（使用数据时区的自然日）
  // 为什么用 setZone？因为要基于数据时区计算"自然日"边界
  sinceDate = DateTime.fromISO(since, { zone: timezoneName }).startOf('day')
  untilDate = DateTime.fromISO(until, { zone: timezoneName }).endOf('day')
  
  // 4. 验证日期是否有效（Luxon 会检查日期是否存在，如 2026-02-30）
  if (!sinceDate.isValid) {
    warnings.push(`INVALID_DATE_FORMAT: since 日期无效 (${sinceDate.invalidReason || '未知错误'})`)
    return { isValid: false, warnings, sinceDate: null, untilDate: null }
  }
  
  if (!untilDate.isValid) {
    warnings.push(`INVALID_DATE_FORMAT: until 日期无效 (${untilDate.invalidReason || '未知错误'})`)
    return { isValid: false, warnings, sinceDate: null, untilDate: null }
  }
  
  // 5. 验证范围是否反转（since <= until）
  if (sinceDate > untilDate) {
    warnings.push('RANGE_REVERSED: 开始日期不能晚于结束日期')
    return { isValid: false, warnings, sinceDate, untilDate }
  }
  
  // 6. 验证跨度（不超过 365 天）
  const daysDiff = Math.ceil(untilDate.diff(sinceDate, 'days').days)
  if (daysDiff > 365) {
    warnings.push(`EXCEEDS_MAX_RANGE: 时间跨度 (${daysDiff} 天) 超过最大限制 (365 天)`)
    // 注意：这里不返回 false，允许查询但给出警告
  }
  
  return { isValid: true, warnings, sinceDate, untilDate }
}

/**
 * 验证时区名称是否有效
 * @param {string} timezoneName - 时区名称
 * @returns {boolean} 是否有效
 */
export function isValidTimezone(timezoneName) {
  if (!timezoneName || typeof timezoneName !== 'string') {
    return false
  }
  
  try {
    const dt = DateTime.now().setZone(timezoneName)
    // Luxon 对无效时区会返回 "invalid" 状态
    // 检查 DateTime 对象是否有效，以及 zoneName 是否存在
    if (!dt.isValid) {
      return false
    }
    
    // 检查 zoneName 是否存在（有效时区会有 zoneName）
    // 对于无效时区，Luxon 可能返回 null 或保持原值
    const zoneName = dt.zoneName
    if (!zoneName) {
      return false
    }
    
    // 如果 zoneName 与输入不一致，可能是无效时区（Luxon 会尝试解析）
    // 但有些有效时区也会被标准化，所以这里只检查是否有效
    return true
  } catch (error) {
    return false
  }
}

/**
 * 获取时区列表（常用时区）
 * @returns {Array} 时区列表
 */
export function getCommonTimezones() {
  return [
    { value: 'UTC', label: 'UTC (协调世界时)' },
    { value: 'Asia/Shanghai', label: 'Asia/Shanghai (中国标准时间)' },
    { value: 'Asia/Tokyo', label: 'Asia/Tokyo (日本标准时间)' },
    { value: 'America/New_York', label: 'America/New_York (美国东部时间)' },
    { value: 'America/Los_Angeles', label: 'America/Los_Angeles (美国太平洋时间)' },
    { value: 'Europe/London', label: 'Europe/London (英国标准时间)' }
  ]
}

