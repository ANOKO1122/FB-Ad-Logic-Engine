// 时间窗口枚举映射工具
// 用于统一内部枚举（last_7_days）与 Facebook API 枚举（last_7d）
// 按照时区配置方案的要求：内部统一使用 last_7_days，外部 Facebook API 仍用 last_7d

/**
 * 将内部时间窗口枚举映射到 Facebook API 的 date_preset
 * 为什么需要这个函数？
 * - 内部统一使用 last_7_days、last_3_days 等（便于理解和维护）
 * - Facebook API 要求使用 last_7d、last_3d 等（Graph API 规范）
 * - 通过映射层隔离，避免混用导致错误
 * 
 * @param {string} internalWindow - 内部时间窗口枚举：'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'last_30_days' | 'lifetime'
 * @returns {string} Facebook API 的 date_preset：'today' | 'yesterday' | 'last_3d' | 'last_7d' | 'last_30d' | 'lifetime'
 * 
 * @example
 * // 内部使用 last_7_days
 * const fbPreset = mapToFacebookPreset('last_7_days')  // 返回 'last_7d'
 * 
 * // 内部使用 today（不需要映射）
 * const fbPreset = mapToFacebookPreset('today')  // 返回 'today'
 */
export function mapToFacebookPreset(internalWindow) {
  const mapping = {
    'today': 'today',
    'yesterday': 'yesterday',
    'last_3_days': 'last_3d',
    'last_7_days': 'last_7d',
    'last_30_days': 'last_30d',
    'lifetime': 'lifetime'
  }
  
  // 如果映射表中存在，返回映射值；否则返回原值（向后兼容）
  return mapping[internalWindow] || internalWindow
}

/**
 * 将 Facebook API 的 date_preset 映射到内部时间窗口枚举
 * 为什么需要这个函数？
 * - 从 Facebook API 响应中解析 date_preset 时，需要转换为内部枚举
 * - 确保整个系统使用统一的枚举命名
 * 
 * @param {string} fbPreset - Facebook API 的 date_preset：'today' | 'yesterday' | 'last_3d' | 'last_7d' | 'last_30d' | 'lifetime'
 * @returns {string} 内部时间窗口枚举：'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'last_30_days' | 'lifetime'
 * 
 * @example
 * // Facebook API 返回 last_7d
 * const internalWindow = mapFromFacebookPreset('last_7d')  // 返回 'last_7_days'
 */
export function mapFromFacebookPreset(fbPreset) {
  const mapping = {
    'today': 'today',
    'yesterday': 'yesterday',
    'last_3d': 'last_3_days',
    'last_7d': 'last_7_days',
    'last_30d': 'last_30_days',
    'lifetime': 'lifetime'
  }
  
  // 如果映射表中存在，返回映射值；否则返回原值（向后兼容）
  return mapping[fbPreset] || fbPreset
}

/**
 * 验证时间窗口枚举是否有效（内部枚举）
 * @param {string} timeWindow - 时间窗口枚举
 * @returns {boolean} 是否有效
 */
export function isValidInternalWindow(timeWindow) {
  const validWindows = ['today', 'yesterday', 'last_3_days', 'last_7_days', 'last_30_days', 'lifetime', 'custom_range']
  return validWindows.includes(timeWindow)
}

