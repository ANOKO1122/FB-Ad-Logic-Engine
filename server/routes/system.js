// 系统状态与审计日志路由
import { Router } from 'express'
import logger from '../utils/logger.js'
import pool from '../db/connection.js'
import { requireAuth, requireActive } from '../middleware/authJwt.js'
import { getCronStatus, manualSyncAccounts } from '../services/cronService.js'
import { getCircuitBreakerStatus } from '../services/rateLimitService.js'

const router = Router()

/**
 * 将 DB 返回的 triggered_at/created_at 统一转为「带 Z 的 UTC ISO 字符串」供前端按 UTC 解析后转北京展示。
 */
function toUTCISO(val) {
  if (val == null) return val
  if (val instanceof Date) return val.toISOString()
  const s = String(val).trim()
  if (!s) return val
  if (s.endsWith('Z')) return s
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  return normalized.includes('.') ? `${normalized}Z` : `${normalized}.000Z`
}

// ===========================
// 审计日志端点
// ===========================

/**
 * GET /api/automation-logs/stats/summary
 * 获取审计日志统计摘要
 * 注意：静态路由必须放在动态路由 /:id 前面
 */
router.get('/automation-logs/stats/summary', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const userRole = req.user.role
    
    // 权限过滤
    let whereClause = ''
    const params = []
    if (userRole !== 'admin') {
      // ✅ 先查询用户的 owner_id
      const [userRows] = await pool.execute(
        'SELECT owner_id FROM users WHERE id = ?',
        [userId]
      )
      const userOwnerId = userRows[0]?.owner_id || 0
      whereClause = 'WHERE owner_id = ?'
      params.push(userOwnerId)  // ✅ 使用 users.owner_id 过滤 automation_logs.owner_id
      // ✅ 非 admin 用户 summary 也默认只统计 success（符合"展示层只看成功改动"的产品预期）
      whereClause += ' AND status = ?'
      params.push('success')
    }
    
    // 今日统计
    const todaySql = `
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
        SUM(CASE WHEN is_simulation = 1 THEN 1 ELSE 0 END) AS simulation_count
      FROM automation_logs
      ${whereClause ? whereClause + ' AND' : 'WHERE'} DATE(triggered_at) = CURDATE()
    `
    const [todayRows] = await pool.execute(todaySql, params)
    
    // 最近7天每日统计
    const weekSql = `
      SELECT 
        DATE(triggered_at) AS date,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count
      FROM automation_logs
      ${whereClause ? whereClause + ' AND' : 'WHERE'} triggered_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(triggered_at)
      ORDER BY DATE(triggered_at) DESC
    `
    const [weekRows] = await pool.execute(weekSql, params)
    
    res.json({
      success: true,
      today: todayRows[0],
      week: weekRows
    })
  } catch (err) {
    logger.error('获取日志统计失败:', err)
    res.status(500).json({ error: '获取日志统计失败', code: 'ERROR' })
  }
})

/**
 * GET /api/automation-logs
 * 获取审计日志列表（支持筛选和分页）
 * 
 * 查询参数：
 *   - account_id: 账户ID（可选）
 *   - rule_id: 规则ID（可选）
 *   - rule_name: 规则名称（可选，精确匹配）
 *   - status: 状态（success/fail/skipped，可选）
 *   - start_date: 开始日期（可选，格式 YYYY-MM-DD）
 *   - end_date: 结束日期（可选，格式 YYYY-MM-DD）
 *   - page: 页码（默认 1）
 *   - limit: 每页条数（默认 50，最大 100）
 */
router.get('/automation-logs', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const userRole = req.user.role
    
    // 解析查询参数
    const {
      account_id,
      rule_id,
      rule_name,
      status,
      start_date,
      end_date,
      page = 1,
      limit = 50,
      include_all_status
    } = req.query
    
    // 限制每页条数
    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50))
    const offset = (pageNum - 1) * limitNum
    
    // ✅ 只有 admin 用户才能通过参数查看全部状态，非 admin 强制只看 success
    // ✅ 修复大小写问题：使用 toLowerCase() 处理参数
    const includeAllStatus = String(include_all_status || '').toLowerCase() === 'true' && userRole === 'admin'
    
    // 构建查询条件
    let whereClause = 'WHERE 1=1'
    const params = []
    
    // 非管理员只能看到自己负责的账户的日志
    // 需要先查询用户对应的 owner_id
    if (userRole !== 'admin') {
      // 查询用户的 owner_id
      const [userRows] = await pool.execute(
        'SELECT owner_id FROM users WHERE id = ?',
        [userId]
      )
      const userOwnerId = userRows[0]?.owner_id || 0
      whereClause += ' AND al.owner_id = ?'
      params.push(userOwnerId)
    }
    
    if (account_id) {
      whereClause += ' AND al.account_id = ?'
      params.push(account_id)
    }
    
    if (rule_id) {
      whereClause += ' AND al.rule_id = ?'
      params.push(parseInt(rule_id))
    }
    
    if (rule_name) {
      whereClause += ' AND al.rule_name = ?'
      params.push(String(rule_name).trim())
    }
    
    // ✅ 默认只返回 status=success 的日志（除非 admin 通过 include_all_status=true 查看全部）
    if (!includeAllStatus) {
      whereClause += ' AND al.status = ?'
      params.push('success')
    } else if (status && ['success', 'fail', 'skipped'].includes(status)) {
      // admin 用户可以通过 status 参数进一步筛选
      whereClause += ' AND al.status = ?'
      params.push(status)
    }
    
    if (start_date) {
      whereClause += ' AND al.triggered_at >= ?'
      params.push(`${start_date} 00:00:00`)
    }
    
    if (end_date) {
      whereClause += ' AND al.triggered_at <= ?'
      params.push(`${end_date} 23:59:59`)
    }
    
    // 查询总数
    const countSql = `
      SELECT COUNT(*) AS total
      FROM automation_logs al
      ${whereClause}
    `
    const [countRows] = await pool.execute(countSql, params)
    const total = countRows[0].total
    
    // 查询日志列表
    // 注意：LIMIT 和 OFFSET 直接内联到 SQL 中，避免 mysql2 prepared statement 的参数类型问题
    const dataSql = `
      SELECT 
        al.id,
        al.account_id,
        al.ad_id,
        al.ad_name,
        al.rule_id,
        al.rule_name,
        al.owner_id,
        al.metrics_snapshot,
        al.action_type,
        al.action_payload,
        al.is_simulation,
        al.status,
        al.error_message,
        al.triggered_at,
        al.created_at,
        am.fb_account_name AS account_name,
        am.timezone_name,
        o.owner_name
      FROM automation_logs al
      LEFT JOIN account_mappings am ON al.account_id = am.fb_account_id
      LEFT JOIN owners o ON al.owner_id = o.id
      ${whereClause}
      ORDER BY al.triggered_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `
    const [rows] = await pool.execute(dataSql, params)
    
    // 解析 JSON 字段；triggered_at/created_at 统一为 UTC ISO（带 Z），前端按 UTC 转北京展示
    const logs = rows.map(row => ({
      ...row,
      triggered_at: toUTCISO(row.triggered_at),
      created_at: toUTCISO(row.created_at),
      metrics_snapshot: typeof row.metrics_snapshot === 'string' 
        ? JSON.parse(row.metrics_snapshot || '{}') 
        : (row.metrics_snapshot || {}),
      action_payload: typeof row.action_payload === 'string'
        ? JSON.parse(row.action_payload || '{}')
        : (row.action_payload || {})
    }))
    
    res.json({
      success: true,
      logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    })
  } catch (err) {
    logger.error('获取审计日志失败:', err)
    res.status(500).json({ error: '获取审计日志失败', code: 'ERROR' })
  }
})

/**
 * GET /api/automation-logs/:id
 * 获取单条审计日志详情（包含 API 请求/响应）
 */
router.get('/automation-logs/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const logId = parseInt(req.params.id)
    const userId = req.user.id
    const userRole = req.user.role
    
    if (isNaN(logId)) {
      return res.status(400).json({ error: '无效的日志 ID', code: 'INVALID_ID' })
    }
    
    let sql = `
      SELECT 
        al.*,
        am.fb_account_name AS account_name,
        o.owner_name,
        r.rule_name AS current_rule_name
      FROM automation_logs al
      LEFT JOIN account_mappings am ON al.account_id = am.fb_account_id
      LEFT JOIN owners o ON al.owner_id = o.id
      LEFT JOIN rules r ON al.rule_id = r.id
      WHERE al.id = ?
    `
    const params = [logId]
    
    // 非管理员只能看到自己的日志
    if (userRole !== 'admin') {
      // ✅ 先查询用户的 owner_id
      const [userRows] = await pool.execute(
        'SELECT owner_id FROM users WHERE id = ?',
        [userId]
      )
      const userOwnerId = userRows[0]?.owner_id || 0
      sql += ' AND al.owner_id = ?'
      params.push(userOwnerId)  // ✅ 使用 users.owner_id 过滤 automation_logs.owner_id
      // ✅ 非 admin 用户详情接口也默认只看 success（符合"展示层只看成功改动"的产品预期）
      sql += ' AND al.status = ?'
      params.push('success')
    }
    
    const [rows] = await pool.execute(sql, params)
    
    if (rows.length === 0) {
      return res.status(404).json({ error: '日志不存在或无权访问', code: 'NOT_FOUND' })
    }
    
    const row = rows[0]
    const log = {
      ...row,
      triggered_at: toUTCISO(row.triggered_at),
      created_at: toUTCISO(row.created_at),
      metrics_snapshot: typeof row.metrics_snapshot === 'string'
        ? JSON.parse(row.metrics_snapshot || '{}')
        : (row.metrics_snapshot || {}),
      action_payload: typeof row.action_payload === 'string'
        ? JSON.parse(row.action_payload || '{}')
        : (row.action_payload || {})
    }
    
    res.json({ success: true, log })
  } catch (err) {
    logger.error('获取日志详情失败:', err)
    res.status(500).json({ error: '获取日志详情失败', code: 'ERROR' })
  }
})

// ===========================
// 系统健康检查端点
// ===========================

/**
 * GET /api/system/health
 * 获取系统健康状态
 * - admin：返回所有账户健康情况
 * - 非 admin：只返回自己 owner_id 下的账户
 */
router.get('/system/health', requireAuth, requireActive, async (req, res) => {
  try {
    const cronStatus = getCronStatus()
    const breaker = getCircuitBreakerStatus()
    
    const isAdmin = req.user.role === 'admin'
    const ownerId = req.user?.owner_id ?? null
    // 非 admin 只查自己负责人下的账户
    const accountSql = isAdmin
      ? `
      SELECT 
        am.fb_account_id AS account_id,
        am.fb_account_name AS account_name,
        am.timezone_name,
        MAX(ad.synced_at) AS last_sync_time
      FROM account_mappings am
      LEFT JOIN ad_snapshots ad ON am.fb_account_id = ad.account_id
      WHERE am.is_active = 1
      GROUP BY am.fb_account_id, am.fb_account_name, am.timezone_name
      ORDER BY am.fb_account_name
    `
      : `
      SELECT 
        am.fb_account_id AS account_id,
        am.fb_account_name AS account_name,
        am.timezone_name,
        MAX(ad.synced_at) AS last_sync_time
      FROM account_mappings am
      LEFT JOIN ad_snapshots ad ON am.fb_account_id = ad.account_id
      WHERE am.is_active = 1 AND am.owner_id = ?
      GROUP BY am.fb_account_id, am.fb_account_name, am.timezone_name
      ORDER BY am.fb_account_name
    `
    const accountParams = isAdmin ? [] : [ownerId]
    const [accountSyncRows] = await pool.execute(accountSql, accountParams)
    const rows = Array.isArray(accountSyncRows) ? accountSyncRows : []
    
    // 处理同步状态
    const now = new Date()
    const accountSyncStatus = rows.map(row => {
      let status = 'unknown'
      let minutesSinceSync = null
      
      if (row.last_sync_time) {
        const lastSync = new Date(row.last_sync_time)
        minutesSinceSync = Math.round((now - lastSync) / (1000 * 60))
        
        if (minutesSinceSync <= 15) {
          status = 'healthy'
        } else if (minutesSinceSync <= 60) {
          status = 'stale'
        } else {
          status = 'error'
        }
      }
      
      return {
        account_id: row.account_id,
        account_name: row.account_name || row.account_id,
        timezone: row.timezone_name || 'UTC',
        last_sync_time: row.last_sync_time,
        minutes_since_sync: minutesSinceSync,
        status
      }
    })
    
    // 获取待执行任务数（从 automation_logs 统计最近失败的）；非 admin 只统计自己负责人下的
    const queueSql = isAdmin
      ? `SELECT COUNT(*) AS pending_count FROM automation_logs WHERE status = 'fail' AND triggered_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`
      : `SELECT COUNT(*) AS pending_count FROM automation_logs WHERE status = 'fail' AND owner_id = ? AND triggered_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`
    const queueParams = isAdmin ? [] : [ownerId]
    const [queueRows] = await pool.execute(queueSql, queueParams)
    const pendingCount = (queueRows && queueRows[0] != null && queueRows[0].pending_count != null)
      ? Number(queueRows[0].pending_count)
      : 0
    
    // 判断整体系统状态（Token 熔断来自 rateLimitService）
    const hasError = accountSyncStatus.some(a => a.status === 'error')
    const hasStale = accountSyncStatus.some(a => a.status === 'stale')
    const isLocked = breaker?.isLocked === true || false
    
    let systemStatus = 'healthy'
    if (isLocked || hasError) {
      systemStatus = 'error'
    } else if (hasStale) {
      systemStatus = 'warning'
    }
    
    res.json({
      success: true,
      system_status: systemStatus,
      is_system_locked: isLocked,
      cron: {
        is_running: cronStatus.isRunning || false,
        last_run_time: cronStatus.lastExecutionTime || null,
        last_run_duration_ms: cronStatus.lastExecutionResult?.durationMs ?? null,
        last_stats: cronStatus.lastExecutionResult || null
      },
      accounts: accountSyncStatus,
      queue: { pending_count: pendingCount },
      timestamp: now.toISOString()
    })
  } catch (err) {
    const msg = err?.message ?? String(err)
    const stack = err?.stack ?? ''
    logger.error(`获取系统健康状态失败: ${msg}${stack ? '\n' + stack : ''}`)
    res.status(500).json({ 
      error: '获取系统健康状态失败', 
      code: 'ERROR',
      system_status: 'error'
    })
  }
})

// ===========================
// 手动同步端点
// ===========================

/**
 * POST /api/system/sync-accounts
 * 手动触发账户列表同步（从 FB API 同步到 DB）
 * 仅管理员可用
 */
router.post('/system/sync-accounts', requireAuth, requireActive, async (req, res) => {
  try {
    // 权限检查：仅管理员可触发
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: '仅管理员可触发账户同步' 
      })
    }
    
    logger.info(`👤 管理员 ${req.user.username} 触发手动账户同步`)
    
    const result = await manualSyncAccounts()
    
    res.json({
      success: result.success,
      message: result.success 
        ? `同步完成：共 ${result.totalAccounts} 个账户，新增 ${result.newAccounts}，更新 ${result.updatedAccounts}`
        : `同步失败：${result.error}`,
      data: result
    })
  } catch (err) {
    logger.error('手动账户同步失败:', err)
    res.status(500).json({ 
      success: false, 
      error: err.message 
    })
  }
})

// ===========================
// 规则执行摘要端点（仅 admin 可见）
// ===========================

/**
 * GET /api/rule-execution-summaries
 * 查询规则执行摘要（系统层可观测性）
 * 仅管理员可用
 */
router.get('/rule-execution-summaries', requireAuth, requireActive, async (req, res) => {
  try {
    // 权限检查：仅管理员可查看
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: '仅管理员可查看规则执行摘要' 
      })
    }
    
    const {
      run_id,
      account_id,
      rule_id,
      rule_name,
      user_id,
      owner_id,
      status,
      skip_reason,
      page = 1,
      limit = 50,
      start_date,
      end_date
    } = req.query
    
    // 构建 WHERE 条件
    const whereConditions = []
    const params = []
    
    if (run_id) {
      whereConditions.push('run_id = ?')
      params.push(run_id)
    }
    if (account_id) {
      whereConditions.push('account_id = ?')
      params.push(account_id)
    }
    if (rule_id) {
      whereConditions.push('rule_id = ?')
      params.push(parseInt(rule_id))
    }
    if (rule_name) {
      whereConditions.push('rule_name = ?')
      params.push(String(rule_name).trim())
    }
    if (user_id) {
      whereConditions.push('user_id = ?')
      params.push(parseInt(user_id))
    }
    if (owner_id) {
      whereConditions.push('owner_id = ?')
      params.push(parseInt(owner_id))
    }
    if (status) {
      whereConditions.push('status = ?')
      params.push(status)
    }
    if (skip_reason) {
      whereConditions.push('skip_reason = ?')
      params.push(skip_reason)
    }
    if (start_date) {
      whereConditions.push('evaluated_at >= ?')
      params.push(start_date)
    }
    if (end_date) {
      whereConditions.push('evaluated_at <= ?')
      params.push(end_date)
    }
    
    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : ''
    
    // 分页（确保是整数）
    const pageNum = parseInt(page) || 1
    const limitNum = parseInt(limit) || 50
    const offset = (pageNum - 1) * limitNum
    
    // 查询总数
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM rule_execution_summaries ${whereClause}`,
      params
    )
    const total = countRows[0].total
    
    // 查询数据（LIMIT 和 OFFSET 直接拼接，避免参数绑定问题）
    const [rows] = await pool.execute(
      `SELECT 
        id, run_id, rule_id, rule_name, account_id, user_id, owner_id,
        matched_count, executed_count, failed_count, skipped_count,
        status, skip_reason, skip_details, error_message, duration_ms,
        evaluated_at, created_at
       FROM rule_execution_summaries
       ${whereClause}
       ORDER BY evaluated_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params
    )
    
    // 解析 JSON 字段（兼容对象、字符串、Buffer 三种情况）
    const summaries = rows.map(row => {
      let skipDetails = null
      if (row.skip_details) {
        if (typeof row.skip_details === 'object' && !Buffer.isBuffer(row.skip_details)) {
          // 已经是对象，直接使用
          skipDetails = row.skip_details
        } else if (Buffer.isBuffer(row.skip_details)) {
          // 是 Buffer，先转字符串再解析
          skipDetails = JSON.parse(row.skip_details.toString())
        } else if (typeof row.skip_details === 'string') {
          // 是字符串，解析
          skipDetails = JSON.parse(row.skip_details)
        }
      }
      return {
        ...row,
        skip_details: skipDetails
      }
    })
    
    res.json({
      success: true,
      data: summaries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    })
  } catch (err) {
    logger.error('查询规则执行摘要失败:', err)
    logger.error('错误详情:', {
      message: err.message,
      stack: err.stack,
      whereClause,
      paramsLength: params.length,
      params
    })
    res.status(500).json({ 
      success: false, 
      error: err.message 
    })
  }
})

/**
 * GET /api/rule-execution-summaries/stats
 * 获取规则执行摘要统计（按状态、跳过原因分组）
 * 仅管理员可用
 */
router.get('/rule-execution-summaries/stats', requireAuth, requireActive, async (req, res) => {
  try {
    // 权限检查：仅管理员可查看
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: '仅管理员可查看规则执行摘要统计' 
      })
    }
    
    const { start_date, end_date } = req.query
    
    // 构建 WHERE 条件
    const whereConditions = []
    const params = []
    
    if (start_date) {
      whereConditions.push('evaluated_at >= ?')
      params.push(start_date)
    }
    if (end_date) {
      whereConditions.push('evaluated_at <= ?')
      params.push(end_date)
    }
    
    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : ''
    
    // 按状态统计
    const [statusRows] = await pool.execute(
      `SELECT status, COUNT(*) AS count 
       FROM rule_execution_summaries 
       ${whereClause}
       GROUP BY status
       ORDER BY count DESC`,
      params
    )
    
    // 按跳过原因统计（修复：whereClause 为空时用 WHERE，否则用 AND）
    const skipReasonWhereClause = whereClause
      ? `${whereClause} AND skip_reason IS NOT NULL`
      : 'WHERE skip_reason IS NOT NULL'
    
    const [skipReasonRows] = await pool.execute(
      `SELECT skip_reason, COUNT(*) AS count 
       FROM rule_execution_summaries 
       ${skipReasonWhereClause}
       GROUP BY skip_reason
       ORDER BY count DESC`,
      params
    )
    
    // 总体统计
    const [totalRows] = await pool.execute(
      `SELECT 
        COUNT(*) AS total,
        SUM(matched_count) AS total_matched,
        SUM(executed_count) AS total_executed,
        SUM(failed_count) AS total_failed,
        AVG(duration_ms) AS avg_duration_ms
       FROM rule_execution_summaries
       ${whereClause}`,
      params
    )
    
    res.json({
      success: true,
      data: {
        total: totalRows[0],
        by_status: statusRows,
        by_skip_reason: skipReasonRows
      }
    })
  } catch (err) {
    logger.error('查询规则执行摘要统计失败:', err)
    res.status(500).json({ 
      success: false, 
      error: err.message 
    })
  }
})

export default router

