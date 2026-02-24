/**
 * 账户访问权限校验（消除数据接口 IDOR）
 *
 * 原则：任何带 account_id 的读数据/拉结构接口，必须先通过本校验。
 * - admin：放行
 * - 非 admin：必须满足 account_mappings.fb_account_id = accountId
 *   AND account_mappings.owner_id = req.user.owner_id AND is_active = 1，否则 403
 */

import pool from '../db/connection.js'

/**
 * 校验当前用户是否有权访问指定广告账户
 * @param {Object} req - Express req（需已挂载 req.user，即 requireAuth 之后）
 * @param {Object} res - Express res（用于直接返回 401/403）
 * @param {string} accountId - 广告账户 ID（如 act_xxx）
 * @returns {Promise<boolean>} true 表示有权限，调用方继续；false 表示已发送响应，调用方应 return
 */
export async function assertAccountAccess(req, res, accountId) {
  if (!req.user) {
    res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' })
    return false
  }
  if (req.user.role === 'admin') return true

  const ownerId = req.user.owner_id
  if (!ownerId) {
    res.status(403).json({ error: '无权访问该广告账户', code: 'ACCOUNT_FORBIDDEN' })
    return false
  }

  const id = typeof accountId === 'string' ? accountId.trim() : String(accountId || '').trim()
  if (!id) {
    res.status(400).json({ error: '缺少 account_id', code: 'MISSING_ACCOUNT_ID' })
    return false
  }

  const [rows] = await pool.execute(
    `SELECT 1 FROM account_mappings 
     WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
     LIMIT 1`,
    [id, ownerId]
  )
  if (rows.length === 0) {
    res.status(403).json({ error: '无权访问该广告账户', code: 'ACCOUNT_FORBIDDEN' })
    return false
  }
  return true
}

/**
 * 仅校验当前用户是否有权访问指定广告账户，不发送响应（用于多账户场景下逐个校验）
 * 与 assertAccountAccess 逻辑一致，但不写 res，便于在循环中收集「有权限的账户列表」后再统一决定是否 403。
 * @param {Object} req - Express req（需已挂载 req.user）
 * @param {string} accountId - 广告账户 ID
 * @returns {Promise<boolean>} true 表示有权限
 */
export async function hasAccountAccess(req, accountId) {
  if (!req.user) return false
  if (req.user.role === 'admin') return true
  const ownerId = req.user.owner_id
  if (!ownerId) return false
  const id = typeof accountId === 'string' ? accountId.trim() : String(accountId || '').trim()
  if (!id) return false
  const [rows] = await pool.execute(
    `SELECT 1 FROM account_mappings 
     WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
     LIMIT 1`,
    [id, ownerId]
  )
  return rows.length > 0
}
