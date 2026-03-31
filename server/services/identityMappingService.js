import pool from '../db/connection.js'

/**
 * 查询钉钉 unionId 是否已绑定本地用户
 * 设计原则：
 * - 身份映射表只记录“绑定成功关系”
 * - provider_user_id 固定存 unionId（主绑定键）
 */
export async function findBoundUserIdByDingTalkUnionId(unionId) {
  const [rows] = await pool.execute(
    `SELECT user_id
     FROM auth_identity_mappings
     WHERE provider = 'dingtalk' AND provider_user_id = ?
     LIMIT 1`,
    [unionId]
  )
  return rows[0]?.user_id || null
}

export async function touchDingTalkMappingLastLoginAt(unionId) {
  await pool.execute(
    `UPDATE auth_identity_mappings
     SET last_login_at = NOW()
     WHERE provider = 'dingtalk' AND provider_user_id = ?`,
    [unionId]
  )
}

/**
 * 读取本地用户的最小信息（用于判断本地 status 是否允许登录）
 */
export async function getLocalUserAuthInfo(userId) {
  const [rows] = await pool.execute(
    `SELECT id, username, role, status
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId]
  )
  return rows[0] || null
}

export async function findDingTalkMappingByUserId(userId) {
  const [rows] = await pool.execute(
    `SELECT provider_user_id
     FROM auth_identity_mappings
     WHERE provider = 'dingtalk' AND user_id = ?
     LIMIT 1`,
    [userId]
  )
  return rows[0] || null
}

export async function upsertDingTalkIdentityMapping({
  unionId,
  openId,
  mobile,
  dingtalkUserId,
  userId,
}) {
  await pool.execute(
    `INSERT INTO auth_identity_mappings
      (provider, provider_user_id, open_id, mobile, dingtalk_userid, user_id, created_at, last_login_at)
     VALUES
      ('dingtalk', ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
      open_id = VALUES(open_id),
      mobile = VALUES(mobile),
      dingtalk_userid = VALUES(dingtalk_userid),
      user_id = VALUES(user_id),
      last_login_at = NOW()`,
    [unionId, openId || null, mobile || null, dingtalkUserId || null, userId]
  )
}

