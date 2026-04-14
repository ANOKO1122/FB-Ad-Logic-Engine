import jwt from 'jsonwebtoken'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'

const JWT_SECRET = process.env.JWT_SECRET || 'fb_ad_brain_secret_key_2024'
const JWT_EXPIRES_IN = '7d'

export function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    // 记录具体错误，便于排查
    logger.error('❌ jwt.verify 失败:', err.name, err.message)
    return null
  }
}

export async function requireAuth(req, res, next) {
  try {
    // ✅ 优先使用 Authorization header（API/测试用），其次 cookie（浏览器用）
    // 这样用 Bearer 调用时不会误用浏览器里残留的 cookie，避免权限测试误判
    let token = null
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim()
    }
    if (!token && req.cookies?.token) {
      token = req.cookies.token.trim()
    }
    
    // 去除 token 首尾空白（Thunder Client 等工具可能带入换行或空格）
    if (token) token = token.trim()
    
    if (!token) {
      return res.status(401).json({ error: '未登录，请先登录', code: 'UNAUTHORIZED' })
    }

    const decoded = verifyToken(token)
    if (!decoded?.userId) {
      logger.error('❌ Token 验证失败:', {
        tokenLength: token?.length,
        tokenSuffix: token?.slice(-20),
        decoded: decoded
      })
      return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' })
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.role, u.status, u.owner_id, o.owner_key, o.owner_name
       FROM users u
       LEFT JOIN owners o ON u.owner_id = o.id
       WHERE u.id = ?`,
      [decoded.userId]
    )

    if (rows.length === 0) {
      return res.status(401).json({ error: '用户不存在', code: 'USER_NOT_FOUND' })
    }

    req.user = rows[0]
    next()
  } catch (err) {
    logger.error('❌ 认证失败:', err.message)
    return res.status(500).json({ error: '认证失败', code: 'AUTH_ERROR' })
  }
}

export function requireActive(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' })
  if (req.user.status !== 'active') {
    const statusMessages = {
      pending: '您的账户正在等待管理员审核',
      rejected: '您的注册申请已被拒绝',
      banned: '您的账户已被禁用'
    }
    return res.status(403).json({
      error: statusMessages[req.user.status] || '账户状态异常',
      code: 'ACCOUNT_NOT_ACTIVE',
      status: req.user.status
    })
  }
  next()
}

/** 与 plan 一致：admin 与 super_admin 均可进管理端（/api/admin/*） */
export function isAdminLikeRole(role) {
  return role === 'admin' || role === 'super_admin'
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' })
  if (!isAdminLikeRole(req.user.role)) {
    return res.status(403).json({ error: '需要管理员权限', code: 'ADMIN_REQUIRED' })
  }
  next()
}

/** 仅 super_admin（升降级管理员等高危操作） */
export function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' })
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: '需要超级管理员权限', code: 'SUPER_ADMIN_REQUIRED' })
  }
  next()
}

export { JWT_SECRET, JWT_EXPIRES_IN }



