import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db/connection.js'
import { signToken, requireAuth } from '../middleware/authJwt.js'
import logger from '../utils/logger.js'
import {
  buildDingTalkAuthorizeUrl,
  fetchDingTalkIdentityByCode,
  generateOAuthState,
} from '../services/dingtalkAuthService.js'
import {
  AUTH_LOGIN_RESULT,
  AUTH_REJECT_REASON,
  getRequestClientMeta,
  writeAuthLoginAuditSafe,
} from '../services/authAuditService.js'
import {
  findBoundUserIdByDingTalkUnionId,
  findDingTalkMappingByUserId,
  getLocalUserAuthInfo,
  touchDingTalkMappingLastLoginAt,
  upsertDingTalkIdentityMapping,
} from '../services/identityMappingService.js'
import {
  DINGTALK_PENDING_BIND_COOKIE_KEY,
  buildPendingBindPayload,
  signPendingBindToken,
  verifyPendingBindToken,
} from '../services/dingtalkPendingBindService.js'

const router = Router()
const DINGTALK_STATE_COOKIE_KEY = 'dingtalk_oauth_state'

function parseBooleanEnv(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function shouldUseSecureCookie() {
  // 联调兜底：允许通过环境变量显式关闭 secure，便于 HTTP 场景验证。
  // 长期生产建议保持 true（尤其是切到 HTTPS 后）。
  const explicit = parseBooleanEnv(process.env.AUTH_COOKIE_SECURE)
  if (explicit !== null) return explicit
  return process.env.NODE_ENV === 'production'
}

function setLoginCookie(res, token) {
  // 登录态统一收口到 token cookie，保持与现有密码登录完全一致。
  res.cookie('token', token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function setStateCookie(res, state) {
  // state 放进 httpOnly cookie，防止前端脚本读取并降低被篡改风险。
  res.cookie(DINGTALK_STATE_COOKIE_KEY, state, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  })
}

function clearStateCookie(res) {
  res.clearCookie(DINGTALK_STATE_COOKIE_KEY, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
  })
}

function setPendingBindCookie(res, token) {
  // 待绑定态 cookie：必须 httpOnly，避免前端脚本直接篡改；短有效期即可
  res.cookie(DINGTALK_PENDING_BIND_COOKIE_KEY, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  })
}

function clearPendingBindCookie(res) {
  res.clearCookie(DINGTALK_PENDING_BIND_COOKIE_KEY, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
  })
}

function readPendingBindFromRequest(req) {
  const token = req.cookies?.[DINGTALK_PENDING_BIND_COOKIE_KEY]
  if (!token) return { error: 'missing' }
  const payload = verifyPendingBindToken(token)
  if (!payload?.unionId) return { error: 'expired' }
  return { payload }
}

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
    setLoginCookie(res, token)

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

router.get('/auth/dingtalk/login', async (req, res) => {
  try {
    // 每次发起授权都生成新的 state，避免重放攻击。
    const state = generateOAuthState()
    setStateCookie(res, state)
    const authorizeUrl = buildDingTalkAuthorizeUrl(state)
    return res.redirect(authorizeUrl)
  } catch (err) {
    logger.error('发起钉钉授权失败', { message: err.message })
    return res.status(500).json({ error: '发起钉钉授权失败', code: 'DINGTALK_LOGIN_INIT_ERROR' })
  }
})

router.get('/auth/dingtalk/callback', async (req, res) => {
  const clientMeta = getRequestClientMeta(req)

  try {
    const { code, state } = req.query
    const cookieState = req.cookies?.[DINGTALK_STATE_COOKIE_KEY]

    // 回调第一步先销毁 state cookie，确保一次性使用，避免被重复利用。
    clearStateCookie(res)

    if (!code || !state) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        loginResult: AUTH_LOGIN_RESULT.ERROR,
        rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_CALLBACK_PARAM,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(400).json({ error: '缺少回调参数', code: 'DINGTALK_CALLBACK_PARAM_ERROR' })
    }
    if (!cookieState || cookieState !== state) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_STATE_MISMATCH,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(400).json({ error: 'state 校验失败', code: 'DINGTALK_STATE_MISMATCH' })
    }

    const identity = await fetchDingTalkIdentityByCode(code)

    // 钉钉身份层：不是企业内部员工，直接拒绝。
    if (identity.contactType !== 0) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_NOT_INTERNAL,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(403).json({
        error: '仅企业内部员工可登录',
        code: 'DINGTALK_NOT_INTERNAL',
        identity: {
          unionId: identity.unionId,
          dingtalkUserId: identity.dingtalkUserId,
          contactType: identity.contactType,
        },
      })
    }

    // 钉钉身份层：不在职，直接拒绝。
    if (!identity.active) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_INACTIVE,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(403).json({
        error: '当前账号不在职或不可用',
        code: 'DINGTALK_USER_INACTIVE',
        identity: {
          unionId: identity.unionId,
          dingtalkUserId: identity.dingtalkUserId,
          active: identity.active,
        },
      })
    }

    // 绑定层：只有“已绑定成功关系”才允许进入系统。
    const boundUserId = await findBoundUserIdByDingTalkUnionId(identity.unionId)
    if (!boundUserId) {
      // 未绑定：写入“待绑定身份”cookie，并跳到绑定页（S3-1）
      const pendingPayload = buildPendingBindPayload(identity)
      const pendingToken = signPendingBindToken(pendingPayload)
      setPendingBindCookie(res, pendingToken)

      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_UNBOUND,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.redirect('/bind')
    }

    // 本地权限层：绑定到的本地用户必须存在，并且状态允许登录。
    const localUser = await getLocalUserAuthInfo(boundUserId)
    if (!localUser) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.ERROR,
        rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_TEMP_ADMIN_NOT_FOUND,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(500).json({
        error: '绑定关系异常：本地用户不存在',
        code: 'BOUND_USER_NOT_FOUND',
      })
    }

    if (localUser.status !== 'active') {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_LOCAL_STATUS,
        boundUserId: localUser.id,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(403).json({
        error: '本地账户状态不允许登录',
        code: 'LOCAL_ACCOUNT_NOT_ACTIVE',
        status: localUser.status,
      })
    }

    const token = signToken(localUser.id)
    setLoginCookie(res, token)
    // 成功登录后，清理待绑定态，避免用户刷新后仍看到绑定页数据
    clearPendingBindCookie(res)

    logger.info('钉钉临时映射登录成功', {
      localUserId: localUser.id,
      dingtalkUserId: identity.dingtalkUserId,
      unionId: identity.unionId,
    })

    await touchDingTalkMappingLastLoginAt(identity.unionId)

    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      providerUserId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      contactType: identity.contactType,
      active: identity.active,
      loginResult: AUTH_LOGIN_RESULT.SUCCESS,
      rejectReason: null,
      boundUserId: localUser.id,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })

    return res.redirect('/dashboard')
  } catch (err) {
    logger.error('处理钉钉回调失败', { message: err.message, stack: err.stack })
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_DINGTALK_API,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(500).json({ error: '钉钉登录失败，请稍后重试', code: 'DINGTALK_CALLBACK_ERROR' })
  }
})

router.get('/auth/dingtalk/pending-bind', async (req, res) => {
  // 读取待绑定态：前端绑定页用它展示 identity，并驱动后续“绑定旧账号/首次注册并绑定”接口
  const token = req.cookies?.[DINGTALK_PENDING_BIND_COOKIE_KEY]
  if (!token) {
    return res.status(404).json({ error: '无待绑定信息', code: 'NO_PENDING_BIND' })
  }

  const payload = verifyPendingBindToken(token)
  if (!payload?.unionId) {
    clearPendingBindCookie(res)
    return res.status(400).json({ error: '待绑定信息已过期，请重新扫码', code: 'PENDING_BIND_EXPIRED' })
  }

  return res.json({
    success: true,
    pending: {
      provider: payload.provider,
      unionId: payload.unionId,
      openId: payload.openId,
      mobile: payload.mobile,
      dingtalkUserId: payload.dingtalkUserId,
      contactType: payload.contactType,
      active: payload.active,
      issuedAtMs: payload.iat_ms || null,
    },
  })
})

router.post('/auth/dingtalk/bind-existing', async (req, res) => {
  const clientMeta = getRequestClientMeta(req)
  const pending = readPendingBindFromRequest(req)
  if (pending.error === 'missing') {
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_PENDING_BIND_MISSING,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(400).json({ error: '待绑定信息不存在，请重新扫码', code: 'NO_PENDING_BIND' })
  }
  if (pending.error === 'expired') {
    clearPendingBindCookie(res)
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_PENDING_BIND_EXPIRED,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(400).json({ error: '待绑定信息已过期，请重新扫码', code: 'PENDING_BIND_EXPIRED' })
  }

  const identity = pending.payload

  try {
    const { username, password } = req.body || {}
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码', code: 'MISSING_PARAMS' })
    }

    const [rows] = await pool.execute(
      `SELECT id, username, password_hash, role, status
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    )
    if (!rows.length) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_INVALID_CREDENTIALS,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' })
    }

    const user = rows[0]
    const isValid = await bcrypt.compare(password, user.password_hash || '')
    if (!isValid) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_INVALID_CREDENTIALS,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(401).json({ error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' })
    }

    if (user.status === 'rejected' || user.status === 'banned') {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_LOCAL_STATUS,
        boundUserId: user.id,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(403).json({ error: '该账号状态不允许绑定', code: 'LOCAL_ACCOUNT_NOT_BINDABLE' })
    }

    const existingMapping = await findDingTalkMappingByUserId(user.id)
    if (existingMapping && existingMapping.provider_user_id !== identity.unionId) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_ALREADY_BOUND_OTHER,
        boundUserId: user.id,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(409).json({ error: '该本地账号已绑定其他钉钉身份', code: 'ACCOUNT_ALREADY_BOUND_OTHER' })
    }

    await upsertDingTalkIdentityMapping({
      unionId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      userId: user.id,
    })

    const token = signToken(user.id)
    setLoginCookie(res, token)
    clearPendingBindCookie(res)

    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      providerUserId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      contactType: identity.contactType,
      active: identity.active,
      loginResult: AUTH_LOGIN_RESULT.SUCCESS,
      rejectReason: null,
      boundUserId: user.id,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })

    return res.json({
      success: true,
      message: '绑定旧账号成功',
      token,
      next: user.status === 'pending' ? '/pending' : '/dashboard',
    })
  } catch (err) {
    logger.error('绑定旧账号失败', { message: err.message, stack: err.stack })
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      providerUserId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      contactType: identity.contactType,
      active: identity.active,
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_CALLBACK_UNKNOWN,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(500).json({ error: '绑定旧账号失败', code: 'BIND_EXISTING_ERROR' })
  }
})

router.post('/auth/dingtalk/register-and-bind', async (req, res) => {
  const clientMeta = getRequestClientMeta(req)
  const pending = readPendingBindFromRequest(req)
  if (pending.error === 'missing') {
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_PENDING_BIND_MISSING,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(400).json({ error: '待绑定信息不存在，请重新扫码', code: 'NO_PENDING_BIND' })
  }
  if (pending.error === 'expired') {
    clearPendingBindCookie(res)
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_PENDING_BIND_EXPIRED,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(400).json({ error: '待绑定信息已过期，请重新扫码', code: 'PENDING_BIND_EXPIRED' })
  }

  const identity = pending.payload

  try {
    const { username, password, owner_id } = req.body || {}
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
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_USERNAME_EXISTS,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(400).json({ error: '用户名已存在', code: 'USERNAME_EXISTS' })
    }

    const [ownerRows] = await pool.execute(
      'SELECT id FROM owners WHERE id = ? AND is_active = 1',
      [owner_id]
    )
    if (ownerRows.length === 0) {
      await writeAuthLoginAuditSafe({
        provider: 'dingtalk',
        providerUserId: identity.unionId,
        openId: identity.openId,
        mobile: identity.mobile,
        dingtalkUserId: identity.dingtalkUserId,
        contactType: identity.contactType,
        active: identity.active,
        loginResult: AUTH_LOGIN_RESULT.REJECT,
        rejectReason: AUTH_REJECT_REASON.AUTH_REJECT_OWNER_NOT_FOUND,
        ip: clientMeta.ip,
        userAgent: clientMeta.userAgent,
      })
      return res.status(400).json({ error: '选择的负责人不存在', code: 'OWNER_NOT_FOUND' })
    }

    const salt = await bcrypt.genSalt(10)
    const passwordHash = await bcrypt.hash(password, salt)
    const [result] = await pool.execute(
      `INSERT INTO users (username, password_hash, role, status, owner_id)
       VALUES (?, ?, 'staff', 'pending', ?)`,
      [username, passwordHash, owner_id]
    )

    const userId = result.insertId
    await upsertDingTalkIdentityMapping({
      unionId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      userId,
    })

    const token = signToken(userId)
    setLoginCookie(res, token)
    clearPendingBindCookie(res)

    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      providerUserId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      contactType: identity.contactType,
      active: identity.active,
      loginResult: AUTH_LOGIN_RESULT.SUCCESS,
      rejectReason: null,
      boundUserId: userId,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })

    return res.status(201).json({
      success: true,
      message: '注册并绑定成功，请等待管理员审核',
      token,
      next: '/pending',
    })
  } catch (err) {
    logger.error('首次注册并绑定失败', { message: err.message, stack: err.stack })
    await writeAuthLoginAuditSafe({
      provider: 'dingtalk',
      providerUserId: identity.unionId,
      openId: identity.openId,
      mobile: identity.mobile,
      dingtalkUserId: identity.dingtalkUserId,
      contactType: identity.contactType,
      active: identity.active,
      loginResult: AUTH_LOGIN_RESULT.ERROR,
      rejectReason: AUTH_REJECT_REASON.AUTH_ERROR_CALLBACK_UNKNOWN,
      ip: clientMeta.ip,
      userAgent: clientMeta.userAgent,
    })
    return res.status(500).json({ error: '首次注册并绑定失败', code: 'REGISTER_BIND_ERROR' })
  }
})

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
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



