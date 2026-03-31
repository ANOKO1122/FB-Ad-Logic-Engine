import pool from '../db/connection.js'
import logger from '../utils/logger.js'

// 统一审计结果枚举，避免后续统计口径漂移。
export const AUTH_LOGIN_RESULT = Object.freeze({
  SUCCESS: 'SUCCESS',
  REJECT: 'REJECT',
  ERROR: 'ERROR',
})

// 统一拒绝/错误原因码枚举，前后端和报表都基于同一套值。
export const AUTH_REJECT_REASON = Object.freeze({
  AUTH_REJECT_STATE_MISMATCH: 'AUTH_REJECT_STATE_MISMATCH',
  AUTH_REJECT_NOT_INTERNAL: 'AUTH_REJECT_NOT_INTERNAL',
  AUTH_REJECT_INACTIVE: 'AUTH_REJECT_INACTIVE',
  AUTH_REJECT_UNBOUND: 'AUTH_REJECT_UNBOUND',
  AUTH_REJECT_LOCAL_STATUS: 'AUTH_REJECT_LOCAL_STATUS',
  AUTH_REJECT_INVALID_CREDENTIALS: 'AUTH_REJECT_INVALID_CREDENTIALS',
  AUTH_REJECT_USERNAME_EXISTS: 'AUTH_REJECT_USERNAME_EXISTS',
  AUTH_REJECT_OWNER_NOT_FOUND: 'AUTH_REJECT_OWNER_NOT_FOUND',
  AUTH_REJECT_ALREADY_BOUND_OTHER: 'AUTH_REJECT_ALREADY_BOUND_OTHER',
  AUTH_ERROR_CALLBACK_PARAM: 'AUTH_ERROR_CALLBACK_PARAM',
  AUTH_ERROR_DINGTALK_API: 'AUTH_ERROR_DINGTALK_API',
  AUTH_ERROR_TEMP_ADMIN_NOT_FOUND: 'AUTH_ERROR_TEMP_ADMIN_NOT_FOUND',
  AUTH_ERROR_PENDING_BIND_MISSING: 'AUTH_ERROR_PENDING_BIND_MISSING',
  AUTH_ERROR_PENDING_BIND_EXPIRED: 'AUTH_ERROR_PENDING_BIND_EXPIRED',
  AUTH_ERROR_CALLBACK_UNKNOWN: 'AUTH_ERROR_CALLBACK_UNKNOWN',
})

function toSafeString(value, maxLength) {
  if (value === undefined || value === null) return null
  const str = String(value).trim()
  if (!str) return null
  return str.length <= maxLength ? str : str.slice(0, maxLength)
}

export function getRequestClientMeta(req) {
  // 代理场景优先取 x-forwarded-for 的第一个真实来源 IP。
  const xff = req.headers['x-forwarded-for']
  const forwardedIp = typeof xff === 'string' ? xff.split(',')[0]?.trim() : null
  const realIp = typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : null
  const fallbackIp = toSafeString(req.ip, 64)

  return {
    ip: toSafeString(forwardedIp || realIp || fallbackIp, 64),
    userAgent: toSafeString(req.headers['user-agent'], 512),
  }
}

export async function writeAuthLoginAudit(payload) {
  const sql = `
    INSERT INTO auth_login_audits (
      provider,
      provider_user_id,
      open_id,
      mobile,
      dingtalk_userid,
      contact_type,
      active,
      login_result,
      reject_reason,
      bound_user_id,
      ip,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `

  const params = [
    toSafeString(payload.provider || 'dingtalk', 32),
    toSafeString(payload.providerUserId, 128),
    toSafeString(payload.openId, 128),
    toSafeString(payload.mobile, 32),
    toSafeString(payload.dingtalkUserId, 128),
    payload.contactType === undefined || payload.contactType === null ? null : Number(payload.contactType),
    payload.active === undefined || payload.active === null ? null : (payload.active ? 1 : 0),
    toSafeString(payload.loginResult, 32),
    toSafeString(payload.rejectReason, 64),
    payload.boundUserId === undefined || payload.boundUserId === null ? null : Number(payload.boundUserId),
    toSafeString(payload.ip, 64),
    toSafeString(payload.userAgent, 512),
  ]

  await pool.execute(sql, params)
}

export async function writeAuthLoginAuditSafe(payload) {
  try {
    await writeAuthLoginAudit(payload)
  } catch (error) {
    // 审计失败不能阻断主登录流程，但必须记录错误便于后续排查。
    logger.error('写入 auth_login_audits 失败', {
      message: error.message,
      payload: {
        provider: payload.provider,
        providerUserId: payload.providerUserId,
        dingtalkUserId: payload.dingtalkUserId,
        loginResult: payload.loginResult,
        rejectReason: payload.rejectReason,
      },
    })
  }
}
