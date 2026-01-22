import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db/connection.js'
import { signToken, requireAuth } from '../middleware/authJwt.js'

const router = Router()

router.post('/auth/register', async (req, res) => {
  try {
    const { username, password, owner_id } = req.body
    if (!username || !password || !owner_id) {
      return res.status(400).json({ error: '请填写完整信息（用户名、密码、负责人）', code: 'MISSING_PARAMS' })
    }
    if (username.length < 2 || username.length > 50) {
      return res.status(400).json({ error: '用户名长度应在 2-50 个字符之间', code: 'INVALID_USERNAME' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少 6 位', code: 'INVALID_PASSWORD' })
    }

    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username])
    if (existing.length > 0) {
      return res.status(400).json({ error: '用户名已存在', code: 'USERNAME_EXISTS' })
    }

    const [ownerRows] = await pool.execute(
      'SELECT id, owner_name FROM owners WHERE id = ? AND is_active = 1',
      [owner_id]
    )
    if (ownerRows.length === 0) {
      return res.status(400).json({ error: '选择的负责人不存在', code: 'OWNER_NOT_FOUND' })
    }

    const salt = await bcrypt.genSalt(10)
    const passwordHash = await bcrypt.hash(password, salt)

    const [result] = await pool.execute(
      `INSERT INTO users (username, password_hash, role, status, owner_id)
       VALUES (?, ?, 'staff', 'pending', ?)`,
      [username, passwordHash, owner_id]
    )

    res.status(201).json({
      success: true,
      message: '注册成功，请等待管理员审核',
      user: { id: result.insertId, username, status: 'pending', owner_name: ownerRows[0].owner_name }
    })
  } catch (err) {
    console.error('❌ 注册失败:', err.message)
    res.status(500).json({ error: '注册失败，请稍后重试', code: 'REGISTER_ERROR' })
  }
})

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码', code: 'MISSING_PARAMS' })
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.password_hash, u.role, u.status, u.owner_id,
              o.owner_name
       FROM users u
       LEFT JOIN owners o ON u.owner_id = o.id
       WHERE u.username = ?`,
      [username]
    )
    if (rows.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' })
    }
    const user = rows[0]

    if (user.status === 'rejected') {
      return res.status(403).json({ error: '您的注册申请已被拒绝', code: 'ACCOUNT_REJECTED' })
    }
    if (user.status === 'banned') {
      return res.status(403).json({ error: '您的账户已被禁用', code: 'ACCOUNT_BANNED' })
    }

    const isValid = await bcrypt.compare(password, user.password_hash || '')
    if (!isValid) {
      return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' })
    }

    const token = signToken(user.id)
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.json({
      success: true,
      message: '登录成功',
      token: token,  // 在响应体中也返回 token（方便测试工具使用）
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        owner_id: user.owner_id,
        owner_name: user.owner_name
      }
    })
  } catch (err) {
    console.error('❌ 登录失败:', err.message)
    res.status(500).json({ error: '登录失败，请稍后重试', code: 'LOGIN_ERROR' })
  }
})

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  })
  res.json({ success: true, message: '已退出登录' })
})

router.get('/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      status: req.user.status,
      owner_id: req.user.owner_id,
      owner_name: req.user.owner_name
    }
  })
})

// 注册下拉框：负责人列表（不返回“无”）
router.get('/owners', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, owner_key, owner_name FROM owners
       WHERE is_active = 1 AND owner_key != 'none'
       ORDER BY owner_name`
    )
    res.json({ success: true, owners: rows })
  } catch (err) {
    console.error('❌ 获取负责人列表失败:', err.message)
    res.status(500).json({ error: '获取负责人列表失败', code: 'GET_OWNERS_ERROR' })
  }
})

export default router



