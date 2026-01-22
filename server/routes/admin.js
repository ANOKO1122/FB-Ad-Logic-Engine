import { Router } from 'express'
import pool from '../db/connection.js'
import { requireAuth, requireActive, requireAdmin } from '../middleware/authJwt.js'
import { manualExecute, getCronStatus } from '../services/cronService.js'

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

export default router


