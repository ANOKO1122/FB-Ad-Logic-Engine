import { Router } from 'express'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { requireAuth, requireActive, requireAdmin, requireSuperAdmin } from '../middleware/authJwt.js'
import { getCronStatus } from '../services/cronService.js'
import { validateTemplateBody } from '../utils/templateValidator.js'
import { diffRuleSnapshots } from '../services/ruleHistoryService.js'
import { bootstrapTemplateForAllOwnersIncremental } from '../services/templateBootstrapService.js'

const router = Router()

/** MySQL JSON 列可能为 string / Buffer / object */
function parseMysqlJson(val) {
  if (val == null) return null
  if (typeof val === 'object' && !Buffer.isBuffer(val)) return val
  if (Buffer.isBuffer(val)) {
    try {
      return JSON.parse(val.toString('utf8'))
    } catch {
      return null
    }
  }
  if (typeof val === 'string') {
    try {
      return JSON.parse(val)
    } catch {
      return null
    }
  }
  return null
}

router.use(requireAuth, requireActive, requireAdmin)

/** Plan：「无」负责人固定为 owner_key = 'none'；删除业务负责人前将引用归到此 id */
async function selectNoneOwnerIdForUpdate(connection) {
  const [rows] = await connection.execute(
    'SELECT id FROM owners WHERE owner_key = ? LIMIT 1 FOR UPDATE',
    ['none']
  )
  return rows.length ? rows[0].id : null
}

// ===========================
// Cron 管理端点（管理员专用）
// ===========================

// GET /api/admin/cron/status
// 查看 cron 任务状态（是否在跑、上次执行时间、上次统计）
router.get('/cron/status', async (req, res) => {
  try {
    res.json({ success: true, ...getCronStatus() })
  } catch (err) {
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// POST /api/admin/cron/execute — 已移除「立即运行所有规则」，规则由每分钟 Cron 驱动
router.post('/cron/execute', async (req, res) => {
  res.status(410).json({
    error: '「立即运行所有规则」已移除，规则由每分钟 Cron 自动执行',
    code: 'GONE'
  })
})

router.get('/pending-count', async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM users WHERE status = 'pending'`)
    res.json({ success: true, count: rows[0].count })
  } catch (err) {
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// 列表不展示 super_admin；含普通用户创建规则数（运营指标）
router.get('/users', async (req, res) => {
  try {
    const { status } = req.query
    let sql = `
      SELECT u.id, u.username, u.role, u.status, u.owner_id, u.created_at,
             o.owner_name,
             (SELECT COUNT(*) FROM rules r WHERE r.user_id = u.id) AS rules_count
      FROM users u
      LEFT JOIN owners o ON u.owner_id = o.id
      WHERE u.role IN ('admin', 'staff')
    `
    const params = []
    if (status) {
      sql += ' AND u.status = ?'
      params.push(status)
    }
    sql += ' ORDER BY u.created_at DESC'
    const [rows] = await pool.execute(sql, params)
    res.json({ success: true, users: rows })
  } catch (err) {
    logger.error('获取用户列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// PATCH /api/admin/users/:id/owner — 仅可改普通用户(staff)的负责人；admin 与 super_admin 均可
router.patch('/users/:id/owner', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10)
    const { owner_id } = req.body || {}
    if (!Number.isFinite(userId) || userId < 1) {
      return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_ID' })
    }
    if (owner_id === undefined || owner_id === null) {
      return res.status(400).json({ error: '请提供 owner_id', code: 'MISSING_PARAMS' })
    }
    const oid = parseInt(owner_id, 10)
    if (!Number.isFinite(oid) || oid < 1) {
      return res.status(400).json({ error: '无效的 owner_id', code: 'INVALID_OWNER' })
    }

    const [targets] = await pool.execute('SELECT id, username, role FROM users WHERE id = ?', [userId])
    if (targets.length === 0) return res.status(404).json({ error: '用户不存在', code: 'NOT_FOUND' })
    if (targets[0].role !== 'staff') {
      return res.status(400).json({ error: '仅可为普通用户变更负责人', code: 'OWNER_ONLY_FOR_STAFF' })
    }

    const [owners] = await pool.execute('SELECT id FROM owners WHERE id = ?', [oid])
    if (owners.length === 0) return res.status(400).json({ error: '负责人不存在', code: 'OWNER_NOT_FOUND' })

    await pool.execute('UPDATE users SET owner_id = ? WHERE id = ?', [oid, userId])
    res.json({ success: true, message: '负责人已更新' })
  } catch (err) {
    logger.error('更新用户负责人失败:', err)
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

// PATCH /api/admin/users/:id/role — 仅 super_admin；staff↔admin，禁止接口设为 super_admin、禁止降级最后一个 super
router.patch('/users/:id/role', requireSuperAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10)
    const { role: nextRole } = req.body || {}
    if (!Number.isFinite(userId) || userId < 1) {
      return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_ID' })
    }
    if (nextRole !== 'admin' && nextRole !== 'staff') {
      return res.status(400).json({ error: 'role 仅允许 admin 或 staff', code: 'INVALID_ROLE' })
    }

    const [targets] = await pool.execute('SELECT id, username, role FROM users WHERE id = ?', [userId])
    if (targets.length === 0) return res.status(404).json({ error: '用户不存在', code: 'NOT_FOUND' })
    const t = targets[0]

    if (t.role === 'super_admin') {
      if (nextRole === 'super_admin') return res.status(400).json({ error: '不可通过接口修改超管角色', code: 'FORBIDDEN' })
      const [cntRows] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM users WHERE role = 'super_admin' AND status = 'active'`
      )
      const cnt = Number(cntRows[0]?.cnt ?? 0)
      if (cnt <= 1) {
        return res.status(400).json({ error: '不可降级最后一个超级管理员', code: 'LAST_SUPER_ADMIN' })
      }
      await pool.execute('UPDATE users SET role = ? WHERE id = ?', [nextRole, userId])
      return res.json({ success: true, message: `已更新用户 ${t.username} 角色为 ${nextRole}` })
    }

    if (t.role === 'staff' && nextRole === 'admin') {
      await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['admin', userId])
      return res.json({ success: true, message: `已将 ${t.username} 设为管理员` })
    }
    if (t.role === 'admin' && nextRole === 'staff') {
      await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['staff', userId])
      return res.json({ success: true, message: `已将 ${t.username} 降为普通用户` })
    }

    if (t.role === nextRole) {
      return res.json({ success: true, message: '角色未变化' })
    }

    return res.status(400).json({ error: '当前角色不允许该变更', code: 'INVALID_TRANSITION' })
  } catch (err) {
    logger.error('更新用户角色失败:', err)
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

router.post('/users/:id/approve', async (req, res) => {
  try {
    const userId = parseInt(req.params.id)
    const [users] = await pool.execute('SELECT id, username, status FROM users WHERE id = ?', [userId])
    if (users.length === 0) return res.status(404).json({ error: '用户不存在', code: 'NOT_FOUND' })
    if (users[0].status !== 'pending') return res.status(400).json({ error: '该用户不在待审核状态', code: 'INVALID_STATUS' })
    await pool.execute('UPDATE users SET status = ? WHERE id = ?', ['active', userId])
    res.json({ success: true, message: `已通过用户 ${users[0].username} 的注册申请` })
  } catch (err) {
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

router.post('/users/:id/reject', async (req, res) => {
  try {
    const userId = parseInt(req.params.id)
    const [users] = await pool.execute('SELECT id, username, status FROM users WHERE id = ?', [userId])
    if (users.length === 0) return res.status(404).json({ error: '用户不存在', code: 'NOT_FOUND' })
    if (users[0].status !== 'pending') return res.status(400).json({ error: '该用户不在待审核状态', code: 'INVALID_STATUS' })
    await pool.execute('UPDATE users SET status = ? WHERE id = ?', ['rejected', userId])
    res.json({ success: true, message: `已拒绝用户 ${users[0].username} 的注册申请` })
  } catch (err) {
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

// DELETE /api/admin/users/:id — admin 与 super_admin 可删除普通用户(staff)；不可删自己、不可删管理员、有规则则禁止
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10)
    if (!Number.isFinite(userId) || userId < 1) {
      return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_ID' })
    }
    if (userId === req.user.id) {
      return res.status(400).json({ error: '不可删除当前登录账号', code: 'CANNOT_DELETE_SELF' })
    }

    const [targets] = await pool.execute(
      'SELECT id, username, role, status FROM users WHERE id = ?',
      [userId]
    )
    if (targets.length === 0) return res.status(404).json({ error: '用户不存在', code: 'NOT_FOUND' })
    const t = targets[0]
    if (t.role !== 'staff') {
      return res.status(400).json({ error: '仅可删除普通用户（staff）', code: 'DELETE_ONLY_STAFF' })
    }

    const [ruleRows] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM rules WHERE user_id = ?',
      [userId]
    )
    const ruleCnt = Number(ruleRows[0]?.cnt ?? 0)
    if (ruleCnt > 0) {
      return res.status(400).json({
        error: `该用户仍有关联规则（${ruleCnt} 条），请先清理规则后再删除`,
        code: 'HAS_RULES'
      })
    }

    await pool.execute('DELETE FROM users WHERE id = ?', [userId])
    res.json({ success: true, message: `已删除用户「${t.username}」` })
  } catch (err) {
    logger.error('删除用户失败:', err)
    res.status(500).json({ error: '删除失败', code: 'ERROR', details: err?.message })
  }
})

// GET /api/admin/owners — 含影响量：有效广告账户数（is_active=1）、系统用户数
router.get('/owners', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT o.id, o.owner_key, o.owner_name, o.is_active,
        (SELECT COUNT(*) FROM account_mappings am WHERE am.owner_id = o.id AND am.is_active = 1) AS ad_account_count,
        (SELECT COUNT(*) FROM users u WHERE u.owner_id = o.id) AS system_user_count
      FROM owners o
      ORDER BY o.id
    `)
    res.json({ success: true, owners: rows })
  } catch (err) {
    logger.error('获取负责人列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// POST /api/admin/owners
// 创建新负责人
router.post('/owners', async (req, res) => {
  try {
    const { owner_name, owner_key } = req.body
    if (!owner_name || !owner_name.trim()) {
      return res.status(400).json({ error: '负责人名称不能为空', code: 'MISSING_PARAMS' })
    }
    
    // owner_key 可选，如果没有提供则使用 owner_name
    const finalOwnerKey = owner_key?.trim() || owner_name.trim()
    
    // 检查是否已存在同名负责人
    const [existing] = await pool.execute(
      'SELECT id FROM owners WHERE owner_name = ? OR owner_key = ?',
      [owner_name.trim(), finalOwnerKey]
    )
    
    if (existing.length > 0) {
      return res.status(400).json({ error: '负责人已存在', code: 'DUPLICATE' })
    }
    
    const [insertResult] = await pool.execute(
      'INSERT INTO owners (owner_name, owner_key, is_active) VALUES (?, ?, 1)',
      [owner_name.trim(), finalOwnerKey]
    )
    const newId = insertResult.insertId
    res.json({
      success: true,
      message: `负责人 "${owner_name.trim()}" 创建成功`,
      id: newId,
      owner: { id: newId, owner_name: owner_name.trim(), owner_key: finalOwnerKey, is_active: 1 }
    })
  } catch (err) {
    logger.error('创建负责人失败:', err)
    res.status(500).json({ error: '创建失败', code: 'ERROR', details: err?.message })
  }
})

// GET /api/admin/owners/:id/impact — 删除前影响量（与列表计数口径一致）
router.get('/owners/:id/impact', async (req, res) => {
  const ownerId = parseInt(req.params.id, 10)
  if (!Number.isFinite(ownerId) || ownerId < 1) {
    return res.status(400).json({ error: '无效的负责人 ID', code: 'INVALID_ID' })
  }
  try {
    const [owners] = await pool.execute(
      'SELECT id, owner_key, owner_name, is_active FROM owners WHERE id = ?',
      [ownerId]
    )
    if (owners.length === 0) {
      return res.status(404).json({ error: '负责人不存在', code: 'NOT_FOUND' })
    }
    const [cntRows] = await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM account_mappings am WHERE am.owner_id = ? AND am.is_active = 1) AS ad_account_count,
        (SELECT COUNT(*) FROM users u WHERE u.owner_id = ?) AS system_user_count`,
      [ownerId, ownerId]
    )
    const row = cntRows[0]
    res.json({
      success: true,
      owner: owners[0],
      ad_account_count: Number(row.ad_account_count),
      system_user_count: Number(row.system_user_count)
    })
  } catch (err) {
    logger.error('获取负责人影响量失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// DELETE /api/admin/owners/:id — 二次确认：body.confirm === true；删后 account_mappings / users 归「无」
router.delete('/owners/:id', async (req, res) => {
  const ownerId = parseInt(req.params.id, 10)
  if (!Number.isFinite(ownerId) || ownerId < 1) {
    return res.status(400).json({ error: '无效的负责人 ID', code: 'INVALID_ID' })
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: '请确认删除（请求体需包含 confirm: true）', code: 'CONFIRM_REQUIRED' })
  }

  let connection
  try {
    const [targetRows] = await pool.execute(
      'SELECT id, owner_key, owner_name FROM owners WHERE id = ?',
      [ownerId]
    )
    if (targetRows.length === 0) {
      return res.status(404).json({ error: '负责人不存在', code: 'NOT_FOUND' })
    }
    if (targetRows[0].owner_key === 'none') {
      return res.status(400).json({ error: '禁止删除「无」负责人', code: 'CANNOT_DELETE_NONE_OWNER' })
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const noneId = await selectNoneOwnerIdForUpdate(connection)
    if (noneId == null) {
      await connection.rollback()
      return res.status(500).json({ error: '数据库缺少 owner_key=none 的负责人记录', code: 'MISSING_NONE_OWNER' })
    }
    if (noneId === ownerId) {
      await connection.rollback()
      return res.status(400).json({ error: '禁止删除「无」负责人', code: 'CANNOT_DELETE_NONE_OWNER' })
    }

    await connection.execute(
      'UPDATE account_mappings SET owner_id = ? WHERE owner_id = ?',
      [noneId, ownerId]
    )
    await connection.execute(
      'UPDATE users SET owner_id = ? WHERE owner_id = ?',
      [noneId, ownerId]
    )
    const [delResult] = await connection.execute(
      'DELETE FROM owners WHERE id = ? AND owner_key <> ?',
      [ownerId, 'none']
    )
    if (delResult.affectedRows === 0) {
      await connection.rollback()
      return res.status(400).json({ error: '删除失败（可能为保留项）', code: 'DELETE_BLOCKED' })
    }

    await connection.commit()
    res.json({
      success: true,
      message: `已删除负责人「${targetRows[0].owner_name}」，关联账户与用户已归「无」`,
      deleted_id: ownerId
    })
  } catch (err) {
    if (connection) {
      await connection.rollback().catch(() => {})
    }
    logger.error('删除负责人失败:', err)
    res.status(500).json({ error: '删除失败', code: 'ERROR', details: err?.message })
  } finally {
    if (connection) connection.release()
  }
})

router.get('/account-mappings', async (req, res) => {
  try {
    const { owner_id } = req.query
    let sql = `
      SELECT am.id, am.fb_account_id, am.fb_account_name, am.owner_id, am.is_active,
             o.owner_name
      FROM account_mappings am
      LEFT JOIN owners o ON am.owner_id = o.id
    `
    const params = []
    if (owner_id) {
      sql += ' WHERE am.owner_id = ?'
      params.push(parseInt(owner_id))
    }
    sql += ' ORDER BY o.owner_name, am.fb_account_id'
    const [rows] = await pool.execute(sql, params)
    res.json({ success: true, mappings: rows })
  } catch (err) {
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

router.post('/account-mappings/assign', async (req, res) => {
  try {
    const { fb_account_id, owner_id } = req.body
    if (!fb_account_id || !owner_id) return res.status(400).json({ error: '请提供账户 ID 和负责人 ID', code: 'MISSING_PARAMS' })

    const [owners] = await pool.execute('SELECT id, owner_name FROM owners WHERE id = ?', [owner_id])
    if (owners.length === 0) return res.status(400).json({ error: '负责人不存在', code: 'OWNER_NOT_FOUND' })

    const [accounts] = await pool.execute('SELECT id FROM account_mappings WHERE fb_account_id = ?', [fb_account_id])
    if (accounts.length === 0) {
      await pool.execute(
        `INSERT INTO account_mappings (fb_account_id, owner_id, is_active) VALUES (?, ?, 1)`,
        [fb_account_id, owner_id]
      )
    } else {
      await pool.execute('UPDATE account_mappings SET owner_id = ? WHERE fb_account_id = ?', [owner_id, fb_account_id])
    }

    res.json({ success: true, message: `账户 ${fb_account_id} 已分配给 ${owners[0].owner_name}` })
  } catch (err) {
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

// PATCH /api/admin/account-mappings/status — 系统内启用/停用广告账户映射（is_active；不调用 Facebook 关户/解绑）
router.patch('/account-mappings/status', async (req, res) => {
  try {
    const { fb_account_id, is_active } = req.body || {}
    const rawId = fb_account_id != null ? String(fb_account_id).trim() : ''
    if (!rawId || !/^act_[0-9]+$/i.test(rawId)) {
      return res.status(400).json({ error: '无效的广告账户 ID（需 act_ 数字）', code: 'INVALID_ACCOUNT_ID' })
    }
    const active = is_active === true || is_active === 1 || is_active === '1'
    const inactive = is_active === false || is_active === 0 || is_active === '0'
    if (!active && !inactive) {
      return res.status(400).json({ error: '请提供 is_active（true/false 或 1/0）', code: 'MISSING_IS_ACTIVE' })
    }
    const next = active ? 1 : 0

    const [maps] = await pool.execute(
      'SELECT id, fb_account_id, is_active FROM account_mappings WHERE fb_account_id = ?',
      [rawId]
    )
    if (maps.length === 0) {
      return res.status(404).json({ error: '本地无此广告账户映射', code: 'MAPPING_NOT_FOUND' })
    }

    await pool.execute('UPDATE account_mappings SET is_active = ? WHERE fb_account_id = ?', [next, rawId])
    res.json({
      success: true,
      message: next === 1 ? `已启用 ${rawId}（将参与同步与规则调度）` : `已停用 ${rawId}（不参与同步与规则调度；普通用户不可见）`,
      fb_account_id: rawId,
      is_active: next
    })
  } catch (err) {
    logger.error('更新账户映射状态失败:', err)
    res.status(500).json({ error: '操作失败', code: 'ERROR', details: err?.message })
  }
})

// POST /api/admin/account-mappings/batch-import
// M4.3：整批校验通过后一次性落库；任一错误则 400 + errors，不写库
const FB_ACCOUNT_ID_RE = /^act_[0-9]+$/i

router.post('/account-mappings/batch-import', async (req, res) => {
  try {
    const { mappings } = req.body
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ error: '请提供账户映射数组', code: 'MISSING_PARAMS' })
    }

    const errors = []
    const seenAccountIds = new Map()
    const validated = []

    for (let i = 0; i < mappings.length; i++) {
      const line = i + 1
      const item = mappings[i] || {}
      const rawId = item.fb_account_id != null ? String(item.fb_account_id).trim() : ''
      const ownerKeyRaw = item.owner_key != null ? String(item.owner_key).trim() : ''

      if (!rawId) {
        errors.push({ line, code: 'MISSING_ACCOUNT_ID', message: '缺少广告账户 ID（fb_account_id）' })
        continue
      }
      if (!FB_ACCOUNT_ID_RE.test(rawId)) {
        errors.push({
          line,
          code: 'INVALID_ACCOUNT_ID',
          message: `广告账户 ID 格式无效，应为 act_ 数字形式：${rawId}`,
          fb_account_id: rawId
        })
        continue
      }
      const fb_account_id = rawId
      if (seenAccountIds.has(fb_account_id)) {
        errors.push({
          line,
          code: 'DUPLICATE_IN_BATCH',
          message: `本批内重复的广告账户：${fb_account_id}（首次出现在第 ${seenAccountIds.get(fb_account_id)} 行）`,
          fb_account_id
        })
        continue
      }
      seenAccountIds.set(fb_account_id, line)

      if (!ownerKeyRaw) {
        errors.push({
          line,
          code: 'MISSING_OWNER_KEY',
          message: '缺少负责人标识或名称（owner_key）',
          fb_account_id
        })
        continue
      }

      const [ownerRows] = await pool.execute(
        'SELECT id FROM owners WHERE owner_key = ? OR owner_name = ? LIMIT 2',
        [ownerKeyRaw, ownerKeyRaw]
      )
      if (ownerRows.length === 0) {
        errors.push({
          line,
          code: 'OWNER_NOT_FOUND',
          message: `负责人不存在于主数据：${ownerKeyRaw}`,
          fb_account_id,
          owner_key: ownerKeyRaw
        })
        continue
      }
      if (ownerRows.length > 1) {
        errors.push({
          line,
          code: 'OWNER_AMBIGUOUS',
          message: `负责人匹配不唯一（请改用 owner_key）：${ownerKeyRaw}`,
          fb_account_id,
          owner_key: ownerKeyRaw
        })
        continue
      }

      validated.push({ fb_account_id, owner_id: ownerRows[0].id })
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'BATCH_VALIDATION_FAILED',
        error: '整批校验未通过，已取消导入（未写入任何数据）',
        errors
      })
    }

    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      for (const row of validated) {
        await connection.execute(
          `INSERT INTO account_mappings (fb_account_id, owner_id, is_active)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id)`,
          [row.fb_account_id, row.owner_id]
        )
      }
      await connection.commit()
    } catch (e) {
      await connection.rollback()
      logger.error('批量导入落库失败:', e)
      return res.status(500).json({ error: '导入写入失败', code: 'IMPORT_WRITE_ERROR', details: e?.message })
    } finally {
      connection.release()
    }

    res.json({
      success: true,
      message: `导入成功，共 ${validated.length} 条账户映射已更新`,
      count: validated.length
    })
  } catch (err) {
    logger.error('批量导入失败:', err)
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
  }
})

// ===========================
// M4.4 人为规则审计（仅人为；排除 SYSTEM_REFRESH / 无操作用户）
// ===========================

// GET /api/admin/rule-history
router.get('/rule-history', async (req, res) => {
  try {
    const ruleIdQ = req.query.rule_id != null ? parseInt(req.query.rule_id, 10) : null
    const byUserQ = req.query.changed_by_user_id != null ? parseInt(req.query.changed_by_user_id, 10) : null
    const changeTypeQ = req.query.change_type != null ? String(req.query.change_type).trim().toUpperCase() : null
    const allowedTypes = ['CREATE', 'UPDATE', 'DELETE', 'TOGGLE']
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30))
    const offset = (page - 1) * limit
    const fromD = req.query.from && String(req.query.from).trim() ? String(req.query.from).trim() : null
    const toD = req.query.to && String(req.query.to).trim() ? String(req.query.to).trim() : null

    let where = `
      WHERE h.change_type IN ('CREATE','UPDATE','DELETE','TOGGLE')
        AND h.changed_by_user_id IS NOT NULL
        AND h.source IN ('api_save', 'api_toggle')
    `
    const params = []
    if (Number.isFinite(ruleIdQ) && ruleIdQ > 0) {
      where += ' AND h.rule_id = ?'
      params.push(ruleIdQ)
    }
    if (Number.isFinite(byUserQ) && byUserQ > 0) {
      where += ' AND h.changed_by_user_id = ?'
      params.push(byUserQ)
    }
    if (changeTypeQ && allowedTypes.includes(changeTypeQ)) {
      where += ' AND h.change_type = ?'
      params.push(changeTypeQ)
    }
    if (fromD) {
      where += ' AND h.changed_at >= ?'
      params.push(fromD)
    }
    if (toD) {
      where += ' AND h.changed_at < DATE_ADD(?, INTERVAL 1 DAY)'
      params.push(toD)
    }

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM rule_history h ${where}`,
      params
    )
    const total = Number(countRows[0]?.total ?? 0)

    // LIMIT/OFFSET 不用预处理占位符：部分 MySQL 版本对 mysqld_stmt_execute 绑定 LIMIT 会报 ER_WRONG_ARGUMENTS(1210)
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 1))
    const safeOffset = Math.max(0, Math.floor(Number(offset)) || 0)

    const listSql = `
      SELECT h.id, h.rule_id, h.change_type, h.changed_at, h.source,
             h.changed_by_user_id, u.username AS changed_by_username,
             JSON_UNQUOTE(JSON_EXTRACT(h.rule_snapshot, '$.rule_name')) AS rule_name_preview
      FROM rule_history h
      LEFT JOIN users u ON u.id = h.changed_by_user_id
      ${where}
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `
    const [rows] = await pool.execute(listSql, params)

    res.json({
      success: true,
      items: rows,
      page,
      limit,
      total
    })
  } catch (err) {
    logger.error('rule-history 列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR', details: err?.message })
  }
})

// GET /api/admin/rule-history/:id — 单条详情（含字段级差异）
router.get('/rule-history/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: '无效的记录 ID', code: 'INVALID_ID' })
    }
    const [rows] = await pool.execute(
      `SELECT h.*, u.username AS changed_by_username
       FROM rule_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
       WHERE h.id = ?`,
      [id]
    )
    if (!rows.length) {
      return res.status(404).json({ error: '记录不存在', code: 'NOT_FOUND' })
    }
    const row = rows[0]
    const human =
      ['CREATE', 'UPDATE', 'DELETE', 'TOGGLE'].includes(row.change_type) &&
      row.changed_by_user_id != null &&
      ['api_save', 'api_toggle'].includes(row.source)
    if (!human) {
      return res.status(404).json({ error: '该记录非人为审计范围', code: 'NOT_FOUND' })
    }

    const snapshotAfter = parseMysqlJson(row.rule_snapshot)
    const snapshotBefore = parseMysqlJson(row.snapshot_before)

    let diff
    if (row.change_type === 'CREATE') {
      diff = {
        changes: [],
        notice: '新建规则：以下为创建时的完整配置（见 snapshot_after）。'
      }
    } else if (row.change_type === 'DELETE') {
      diff = {
        changes: [],
        notice: '规则已删除：以下为删除时保留的最终配置快照（见 snapshot_after）。'
      }
    } else if ((row.change_type === 'UPDATE' || row.change_type === 'TOGGLE') && !snapshotBefore) {
      diff = {
        changes: [],
        notice: '该记录在启用「变更前快照」之前产生，无字段级对比；以下为当时保存后的完整配置。'
      }
    } else {
      diff = diffRuleSnapshots(snapshotBefore, snapshotAfter)
    }

    res.json({
      success: true,
      record: {
        id: row.id,
        rule_id: row.rule_id,
        change_type: row.change_type,
        changed_at: row.changed_at,
        source: row.source,
        changed_by_user_id: row.changed_by_user_id,
        changed_by_username: row.changed_by_username,
        changed_by_owner_id: row.changed_by_owner_id
      },
      snapshot_before: snapshotBefore,
      snapshot_after: snapshotAfter,
      diff,
      added_ids: parseMysqlJson(row.added_ids),
      removed_ids: parseMysqlJson(row.removed_ids)
    })
  } catch (err) {
    logger.error('rule-history 详情失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR', details: err?.message })
  }
})

// ===========================
// 规则模板管理（2.3.2）
// ===========================

// GET /api/admin/templates
router.get('/templates', async (req, res) => {
  try {
    const { include_inactive, query, limit, offset } = req.query
    const includeInactive = include_inactive === '1' || include_inactive === 'true'
    const q = (query && typeof query === 'string' ? query.trim() : '') || ''
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 100))
    const off = Math.min(100000, Math.max(0, parseInt(offset, 10) || 0))

    let sql = `SELECT id, name, slug, description, when_lines, when_time_window, when_custom_range, actions, sort_order, is_active, created_by, updated_by, created_at, updated_at
               FROM rule_templates`
    const params = []
    if (!includeInactive) {
      sql += ' WHERE is_active = 1'
    }
    if (q) {
      sql += includeInactive ? ' WHERE' : ' AND'
      sql += ' (name LIKE ? OR slug LIKE ? OR description LIKE ?)'
      const p = `%${q}%`
      params.push(p, p, p)
    }
    sql += ' ORDER BY sort_order ASC, name ASC'
    sql += ` LIMIT ${lim} OFFSET ${off}`

    const [rows] = await pool.execute(sql, params)
    const templates = rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      when_lines: typeof r.when_lines === 'string' ? JSON.parse(r.when_lines) : r.when_lines,
      when_time_window: r.when_time_window,
      when_custom_range: r.when_custom_range ? (typeof r.when_custom_range === 'string' ? JSON.parse(r.when_custom_range) : r.when_custom_range) : null,
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : r.actions,
      sort_order: r.sort_order,
      is_active: !!r.is_active,
      created_by: r.created_by,
      updated_by: r.updated_by,
      created_at: r.created_at,
      updated_at: r.updated_at
    }))
    res.json({ success: true, templates })
  } catch (err) {
    logger.error('获取模板列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

// POST /api/admin/templates
router.post('/templates', async (req, res) => {
  try {
    const userId = req.user?.id
    const v = validateTemplateBody(req.body, false)
    if (!v.valid) {
      return res.status(400).json({ error: v.error, code: 'INVALID_PARAMS', field: v.field })
    }

    const { name, slug, description, when_lines, when_time_window, when_custom_range, actions, sort_order } = req.body
    const slugTrim = String(slug).trim()

    const [existing] = await pool.execute('SELECT id FROM rule_templates WHERE slug = ?', [slugTrim])
    if (existing.length > 0) {
      return res.status(409).json({ error: 'slug 已存在', code: 'DUPLICATE_SLUG' })
    }

    const whenLinesJson = JSON.stringify(when_lines)
    const whenCustomRangeJson = when_custom_range ? JSON.stringify(when_custom_range) : null
    const actionsJson = JSON.stringify(actions)
    const sort = sort_order != null ? Number(sort_order) : 0

    await pool.execute(
      `INSERT INTO rule_templates (name, slug, description, when_lines, when_time_window, when_custom_range, actions, sort_order, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [name.trim(), slugTrim, description?.trim() || null, whenLinesJson, when_time_window, whenCustomRangeJson, actionsJson, sort, userId, userId]
    )
    const [insertedRows] = await pool.execute(
      `SELECT id, name, slug, when_lines, when_time_window, when_custom_range, actions, created_at
       FROM rule_templates
       WHERE slug = ? LIMIT 1`,
      [slugTrim]
    )
    const inserted = insertedRows?.[0]

    // 增量铺底：管理员新建模板后，异步为每个活跃 owner 尝试插入 1 条半成品（幂等跳过）
    if (inserted) {
      setImmediate(async () => {
        try {
          const summary = await bootstrapTemplateForAllOwnersIncremental({
            templateRecord: inserted,
            actorUserId: userId ?? null,
            actorOwnerId: req.user?.owner_id ?? null
          })
          logger.info('[template-bootstrap] incremental bootstrap done', {
            templateId: inserted.id,
            templateSlug: inserted.slug,
            ...summary
          })
        } catch (e) {
          logger.error('[template-bootstrap] incremental bootstrap failed:', {
            templateId: inserted.id,
            templateSlug: inserted.slug,
            err: e.message
          })
        }
      })
    }

    res.status(201).json({
      success: true,
      template: inserted ? { id: inserted.id, name: inserted.name, slug: inserted.slug, created_at: inserted.created_at } : null,
      message: '模板创建成功'
    })
  } catch (err) {
    logger.error('创建模板失败:', err)
    res.status(500).json({ error: '创建失败', code: 'ERROR', details: err?.message })
  }
})

// PUT /api/admin/templates/:id（乐观并发：body.updated_at 不匹配返回 409）
router.put('/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_ID' })

    const userId = req.user?.id
    const clientUpdatedAt = req.body?.updated_at
    if (clientUpdatedAt == null || clientUpdatedAt === '') {
      return res.status(400).json({ error: '缺少 updated_at，请刷新后重试', code: 'MISSING_VERSION' })
    }

    const v = validateTemplateBody(req.body, true)
    if (!v.valid) {
      return res.status(400).json({ error: v.error, code: 'INVALID_PARAMS', field: v.field })
    }

    const [existing] = await pool.execute('SELECT id, slug, sort_order, updated_at FROM rule_templates WHERE id = ?', [id])
    if (existing.length === 0) {
      return res.status(404).json({ error: '模板不存在', code: 'NOT_FOUND' })
    }

    const dbUpdatedAt = existing[0].updated_at
    const dbSec = Math.floor((dbUpdatedAt instanceof Date ? dbUpdatedAt : new Date(dbUpdatedAt)).getTime() / 1000)
    const clientSec = Math.floor(new Date(clientUpdatedAt).getTime() / 1000)
    if (Number.isNaN(clientSec) || dbSec !== clientSec) {
      return res.status(409).json({ error: '模板已被他人修改，请刷新后重试', code: 'CONFLICT', current_updated_at: dbUpdatedAt })
    }

    const { name, description, when_lines, when_time_window, when_custom_range, actions, sort_order } = req.body
    const whenLinesJson = JSON.stringify(when_lines)
    const whenCustomRangeJson = when_custom_range ? JSON.stringify(when_custom_range) : null
    const actionsJson = JSON.stringify(actions)
    const sort = sort_order != null ? Number(sort_order) : existing[0].sort_order

    await pool.execute(
      `UPDATE rule_templates SET name=?, description=?, when_lines=?, when_time_window=?, when_custom_range=?, actions=?, sort_order=?, updated_by=?, updated_at=NOW() WHERE id=?`,
      [name?.trim() || existing[0].name, description?.trim() || null, whenLinesJson, when_time_window, whenCustomRangeJson, actionsJson, sort, userId, id]
    )
    const [updated] = await pool.execute('SELECT id, name, slug, updated_at FROM rule_templates WHERE id = ?', [id])
    res.json({ success: true, template: updated[0], message: '模板更新成功' })
  } catch (err) {
    logger.error('更新模板失败:', err)
    res.status(500).json({ error: '更新失败', code: 'ERROR', details: err?.message })
  }
})

// DELETE /api/admin/templates/:id（软删除）
router.delete('/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_ID' })

    const [existing] = await pool.execute('SELECT id, name FROM rule_templates WHERE id = ?', [id])
    if (existing.length === 0) {
      return res.status(404).json({ error: '模板不存在', code: 'NOT_FOUND' })
    }

    await pool.execute('UPDATE rule_templates SET is_active=0, updated_at=NOW() WHERE id=?', [id])
    res.json({ success: true, message: `模板「${existing[0].name}」已删除（软删除）。如需复用 slug，请使用「恢复」而非新建。` })
  } catch (err) {
    logger.error('删除模板失败:', err)
    res.status(500).json({ error: '删除失败', code: 'ERROR', details: err?.message })
  }
})

// POST /api/admin/templates/:id/restore（恢复软删除的模板）
router.post('/templates/:id/restore', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_ID' })

    const [existing] = await pool.execute('SELECT id, name, is_active FROM rule_templates WHERE id = ?', [id])
    if (existing.length === 0) {
      return res.status(404).json({ error: '模板不存在', code: 'NOT_FOUND' })
    }
    if (existing[0].is_active) {
      return res.status(400).json({ error: '模板已是启用状态，无需恢复', code: 'ALREADY_ACTIVE' })
    }

    await pool.execute('UPDATE rule_templates SET is_active=1, updated_at=NOW() WHERE id=?', [id])
    res.json({ success: true, message: `模板「${existing[0].name}」已恢复` })
  } catch (err) {
    logger.error('恢复模板失败:', err)
    res.status(500).json({ error: '恢复失败', code: 'ERROR', details: err?.message })
  }
})

export default router


