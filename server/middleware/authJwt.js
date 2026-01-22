import jwt from 'jsonwebtoken'
import pool from '../db/connection.js'

const JWT_SECRET = process.env.JWT_SECRET || 'fb_ad_brain_secret_key_2024'
const JWT_EXPIRES_IN = '7d'

export function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token
    if (!token) {
      return res.status(401).json({ error: '未登录，请先登录', code: 'UNAUTHORIZED' })
    }

    const decoded = verifyToken(token)
    if (!decoded?.userId) {
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
    console.error('❌ 认证失败:', err.message)
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

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' })
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限', code: 'ADMIN_REQUIRED' })
  }
  next()
}

export { JWT_SECRET, JWT_EXPIRES_IN }



