import { Router } from 'express'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { requireAuth, requireActive, requireAdmin } from '../middleware/authJwt.js'
import { manualExecute, getCronStatus } from '../services/cronService.js'
import { validateTemplateBody } from '../utils/templateValidator.js'

const router = Router()

router.use(requireAuth, requireActive, requireAdmin)

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

// POST /api/admin/cron/execute
// 手动触发一次规则执行（用于测试/演练）
router.post('/cron/execute', async (req, res) => {
  try {
    // 手动触发：会走同一套并发保护 + 分布式锁逻辑
    await manualExecute()
    res.json({ success: true, message: '已触发规则执行，请查看后端日志' })
  } catch (err) {
    res.status(500).json({ error: '触发失败', code: 'ERROR', details: err?.message })
  }
})

router.get('/pending-count', async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM users WHERE status = 'pending'`)
    res.json({ success: true, count: rows[0].count })
  } catch (err) {
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

router.get('/users', async (req, res) => {
  try {
    const { status } = req.query
    let sql = `
      SELECT u.id, u.username, u.role, u.status, u.owner_id, u.created_at,
             o.owner_name
      FROM users u
      LEFT JOIN owners o ON u.owner_id = o.id
    `
    const params = []
    if (status) {
      sql += ' WHERE u.status = ?'
      params.push(status)
    }
    sql += ' ORDER BY u.created_at DESC'
    const [rows] = await pool.execute(sql, params)
    res.json({ success: true, users: rows })
  } catch (err) {
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
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

router.get('/owners', async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT id, owner_key, owner_name, is_active FROM owners ORDER BY id`)
    res.json({ success: true, owners: rows })
  } catch (err) {
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
    
    // 插入新负责人
    await pool.execute(
      'INSERT INTO owners (owner_name, owner_key, is_active) VALUES (?, ?, 1)',
      [owner_name.trim(), finalOwnerKey]
    )
    
    res.json({ success: true, message: `负责人 "${owner_name.trim()}" 创建成功` })
  } catch (err) {
    logger.error('创建负责人失败:', err)
    res.status(500).json({ error: '创建失败', code: 'ERROR', details: err?.message })
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

router.post('/account-mappings/batch-import', async (req, res) => {
  try {
    const { mappings } = req.body
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ error: '请提供账户映射数组', code: 'MISSING_PARAMS' })
    }

    let successCount = 0
    let failCount = 0

    for (const item of mappings) {
      try {
        const { fb_account_id, owner_key } = item
        const [owners] = await pool.execute(
          'SELECT id FROM owners WHERE owner_key = ? OR owner_name = ?',
          [owner_key, owner_key]
        )
        if (owners.length === 0) {
          failCount++
          continue
        }
        await pool.execute(
          `INSERT INTO account_mappings (fb_account_id, owner_id, is_active)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id)`,
          [fb_account_id, owners[0].id]
        )
        successCount++
      } catch {
        failCount++
      }
    }

    res.json({ success: true, message: `导入完成：成功 ${successCount} 条，失败 ${failCount} 条`, successCount, failCount })
  } catch (err) {
    res.status(500).json({ error: '操作失败', code: 'ERROR' })
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
    const [inserted] = await pool.execute('SELECT id, name, slug, created_at FROM rule_templates WHERE slug = ?', [slugTrim])
    res.status(201).json({ success: true, template: inserted[0], message: '模板创建成功' })
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


