/**
 * 前端时间展示工具
 * 统一将后端返回的 UTC 时间转换为北京时区（UTC+8 / Asia/Shanghai）显示
 */

import { DateTime } from 'luxon'

/** 前端展示统一使用的时区 */
export const DISPLAY_TIMEZONE = 'Asia/Shanghai'

/**
 * 解析后端返回的 UTC 时间字符串
 * 支持 ISO 格式（2026-01-23T08:00:02.000Z）和 MySQL datetime 格式（2026-01-23 08:00:02）
 * 无 Z 的字符串一律按 UTC 解析，避免被误当本地时间导致少 8 小时
 */
export function parseUTC(dateStr) {
  if (!dateStr) return null
  let s = String(dateStr).trim()
  if (!s) return null
  if (!s.endsWith('Z') && !s.includes('Z')) {
    const t = s.includes('T') ? s : s.replace(' ', 'T')
    s = t.includes('.') ? `${t}Z` : `${t}.000Z`
  }
  if (s.includes('T') || s.includes('Z')) {
    return DateTime.fromISO(s, { zone: 'utc' })
  }
  return DateTime.fromSQL(s, { zone: 'utc' })
}

/**
 * 将 UTC 时间转为北京时区显示（仅时间 HH:mm:ss）
 */
export function formatTimeBeijing(dateStr) {
  const dt = parseUTC(dateStr)
  if (!dt || !dt.isValid) return '-'
  return dt.setZone(DISPLAY_TIMEZONE).toFormat('HH:mm:ss')
}

/**
 * 将 UTC 时间转为北京时区显示（仅日期 MM/dd）
 */
export function formatDateBeijing(dateStr) {
  const dt = parseUTC(dateStr)
  if (!dt || !dt.isValid) return '-'
  return dt.setZone(DISPLAY_TIMEZONE).toFormat('MM/dd')
}

/**
 * 将 UTC 时间转为北京时区显示（日期+时间，完整）
 */
export function formatDateTimeBeijing(dateStr) {
  const dt = parseUTC(dateStr)
  if (!dt || !dt.isValid) return '-'
  return dt.setZone(DISPLAY_TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss')
}

/**
 * 将 UTC 时间转为北京时区显示（中文友好格式，用于列表/详情）
 */
export function formatDateTimeBeijingLocale(dateStr) {
  const dt = parseUTC(dateStr)
  if (!dt || !dt.isValid) return '-'
  return dt.setZone(DISPLAY_TIMEZONE).toFormat('yyyy/MM/dd HH:mm:ss')
}
