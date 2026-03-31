import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../middleware/authJwt.js'

// 待绑定态 cookie 名称：只用于“未绑定”阶段的临时过渡
export const DINGTALK_PENDING_BIND_COOKIE_KEY = 'dingtalk_pending_bind'

// 待绑定态有效期：短期即可（避免长期泄露与状态混乱）
const PENDING_TTL_SECONDS = 10 * 60

export function buildPendingBindPayload(identity) {
  // 只放“绑定/注册决策必需字段”，禁止塞 raw 大对象（cookie 有大小限制）
  return {
    provider: 'dingtalk',
    unionId: identity.unionId || null,
    openId: identity.openId || null,
    mobile: identity.mobile || null,
    dingtalkUserId: identity.dingtalkUserId || null,
    contactType: identity.contactType ?? null,
    active: identity.active ?? null,
    iat_ms: Date.now(),
  }
}

export function signPendingBindToken(payload) {
  // 用 JWT 签名，避免前端篡改；同时设置短过期
  return jwt.sign(payload, JWT_SECRET, { expiresIn: PENDING_TTL_SECONDS })
}

export function verifyPendingBindToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

