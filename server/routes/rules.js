// 规则管理路由 - 使用 Drizzle ORM
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { Router } from 'express'
import logger from '../utils/logger.js'
import { requireAuth, requireActive, isAdminLikeRole } from '../middleware/authJwt.js'
import * as rulesService from '../services/rulesService.js'
import { getCronStatus, executeSingleRule } from '../services/cronService.js'
import { assertAccountAccess } from '../utils/accountAccess.js'
import { generateRunId } from '../services/ruleExecutionSummaryService.js'
import pool from '../db/connection.js'
import { parseCompositeId, normalizeAccountId } from '../utils/targetIdUtils.js'
import { validateConditionsStructure, validateTimeWindowConsistency, normalizeConditionsToV2 } from '../utils/conditionsValidator.js'
import { validateActions } from '../utils/templateValidator.js'
import { refreshDynamicTargetsForAccount, refreshDynamicTargetsForRule, scheduleDynamicScopeRefreshForRule, isDynamicScopeFeatureEnabled, previewDynamicScope } from '../services/dynamicScopeService.js'
import { mergeRuleForEnableCheck, assertRuleReadyToEnable } from '../services/ruleEnableGateService.js'
import { bootstrapTemplatesForOwnerIfEmpty } from '../services/templateBootstrapService.js'

const router = Router()

/**
 * 保存规则时分层错误响应（方案 1.4）：业务错误 400/404，系统错误 500，便于前端区分展示。
 */
function mapRuleErrorToResponse(error) {
  const msg = error?.message || ''
  if (msg === '规则不存在或无权访问') return { statusCode: 404, code: 'NOT_FOUND' }
  if (/^INVALID_|^RULE_NOT_FOUND|ACCOUNT_NOT_FOUND|ACCOUNT_FORBIDDEN|ENABLE_MISSING_ACCOUNT|FEATURE_DISABLED/.test(msg)) return { statusCode: 400, code: msg.split(' ')[0] || 'BAD_REQUEST' }
  if (msg.includes('必填') || msg.includes('必须是') || msg.includes('仅支持')) return { statusCode: 400, code: 'VALIDATION_ERROR' }
  return { statusCode: 500, code: 'ERROR' }
}

function parseDynamicScopePayload(body = {}) {
  const hasUse = Object.prototype.hasOwnProperty.call(body, 'useDynamicScope')
  const hasFilters = Object.prototype.hasOwnProperty.call(body, 'scopeFilters')
  const hasExclude = Object.prototype.hasOwnProperty.call(body, 'excludeIds')
  const hasMax = Object.prototype.hasOwnProperty.call(body, 'maxDynamicMatches')
  return {
    hasAny: hasUse || hasFilters || hasExclude || hasMax,
    useDynamicScope: hasUse ? !!body.useDynamicScope : undefined,
    scopeFilters: hasFilters ? body.scopeFilters : undefined,
    excludeIds: hasExclude ? body.excludeIds : undefined,
    maxDynamicMatches: hasMax ? body.maxDynamicMatches : undefined
  }
}

function hasEffectiveScopeFilters(scopeFilters) {
  if (!scopeFilters || typeof scopeFilters !== 'object') return false
  const conditions = Array.isArray(scopeFilters.conditions) ? scopeFilters.conditions : []
  return conditions.some((item) => item && typeof item === 'object')
}

function validateDynamicScopePayload(dynamicPayload, fallbackTargetLevel) {
  const errors = []
  const updates = {}
  if (!dynamicPayload?.hasAny) return { valid: true, updates }

  if (dynamicPayload.useDynamicScope !== undefined) {
    updates.useDynamicScope = !!dynamicPayload.useDynamicScope
  }
  if (dynamicPayload.excludeIds !== undefined) {
    if (Array.isArray(dynamicPayload.excludeIds)) {
      const ad_ids = []
      const adset_ids = []
      const campaign_ids = []
      for (const item of dynamicPayload.excludeIds) {
        if (!item || typeof item !== 'object') continue
        const level = String(item.level || '').trim().toLowerCase()
        const id = String(item.id || '').trim()
        if (!id) continue
        if (level === 'ad') ad_ids.push(id)
        else if (level === 'adset') adset_ids.push(id)
        else if (level === 'campaign') campaign_ids.push(id)
      }
      updates.excludeIds = { ad_ids, adset_ids, campaign_ids }
    } else if (dynamicPayload.excludeIds && typeof dynamicPayload.excludeIds === 'object') {
      updates.excludeIds = {
        ad_ids: Array.isArray(dynamicPayload.excludeIds.ad_ids) ? dynamicPayload.excludeIds.ad_ids.map(v => String(v)).filter(Boolean) : [],
        adset_ids: Array.isArray(dynamicPayload.excludeIds.adset_ids) ? dynamicPayload.excludeIds.adset_ids.map(v => String(v)).filter(Boolean) : [],
        campaign_ids: Array.isArray(dynamicPayload.excludeIds.campaign_ids) ? dynamicPayload.excludeIds.campaign_ids.map(v => String(v)).filter(Boolean) : []
      }
    } else {
      errors.push('excludeIds 必须是数组或对象')
    }
  }
  if (dynamicPayload.maxDynamicMatches !== undefined) {
    const n = Number(dynamicPayload.maxDynamicMatches)
    if (!Number.isFinite(n) || n < 1 || n > 5000) {
      errors.push('maxDynamicMatches 必须在 1~5000 之间')
    } else {
      updates.maxDynamicMatches = Math.floor(n)
    }
  }
  if (dynamicPayload.scopeFilters !== undefined) {
    const sf = dynamicPayload.scopeFilters
    // 显式传 null 视为「清空监控范围条件」，用于关闭动态筛选时归零。
    if (sf === null) {
      updates.scopeFilters = null
    } else if (!sf || typeof sf !== 'object') {
      errors.push('scopeFilters 必须是对象')
    } else {
      const level = String(sf.level || fallbackTargetLevel || 'ad').trim().toLowerCase()
      if (!['ad', 'adset', 'campaign'].includes(level)) {
        errors.push(`scopeFilters.level 仅支持 ad/adset/campaign，当前: ${level}`)
      }
      const conditions = Array.isArray(sf.conditions) ? sf.conditions : []
      updates.scopeFilters = { level, conditions }
    }
  }
  if (dynamicPayload.useDynamicScope === false && hasEffectiveScopeFilters(updates.scopeFilters)) {
    return {
      valid: false,
      error: '动态筛选关闭时不可设置监控范围条件',
      code: 'DYNAMIC_SCOPE_DISABLED_SCOPE_FILTERS_FORBIDDEN',
      updates
    }
  }
  return { valid: errors.length === 0, error: errors[0], updates }
}

/**
 * GET /api/templates
 * 获取启用的规则模板（普通用户只读，用于规则创建时应用）
 */
router.get('/templates', requireAuth, requireActive, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, slug, description, when_lines, when_time_window, when_custom_range, actions, sort_order
       FROM rule_templates
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    )
    const templates = rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      when_lines: typeof r.when_lines === 'string' ? JSON.parse(r.when_lines) : r.when_lines,
      when_time_window: r.when_time_window,
      when_custom_range: r.when_custom_range ? (typeof r.when_custom_range === 'string' ? JSON.parse(r.when_custom_range) : r.when_custom_range) : null,
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : r.actions,
      sort_order: r.sort_order
    }))
    res.json({ success: true, templates })
  } catch (err) {
    logger.error('获取模板列表失败:', err)
    res.status(500).json({ error: '获取失败', code: 'ERROR' })
  }
})

/**
 * GET /api/rules
 * 获取当前用户的所有规则
 * 查询参数：
 *   - onlyEnabled: true/false（只查询启用的规则）
 *   - orderBy: createdAt（排序字段）
 *   - limit: 数量限制
 *   - offset: 偏移量
 *   - ownerIds: 逗号分隔的负责人 ID（仅管理员有效，如 "1,2,3"；不传或空表示全部负责人）
 */
router.get('/rules', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)

    // 解析 ownerIds：仅管理员使用；空数组/未传表示不按负责人过滤
    let ownerIds = undefined
    if (isAdmin && req.query.ownerIds != null && String(req.query.ownerIds).trim() !== '') {
      const raw = String(req.query.ownerIds).split(',').map(s => parseInt(s.trim(), 10))
      ownerIds = [...new Set(raw)].filter(n => Number.isFinite(n) && n > 0)
      if (ownerIds.length === 0) ownerIds = undefined
    }

    const options = {
      onlyEnabled: req.query.onlyEnabled === 'true',
      orderBy: req.query.orderBy || 'createdAt',
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset) : undefined,
      isAdmin,
      ownerIds,
      // 非管理员：按负责人维度列出规则（与模板铺底「一负责人一套」一致）
      viewerOwnerId: isAdmin ? undefined : req.user.owner_id
    }

    const userRules = await rulesService.getUserRules(userId, options)

    const dynamicRuleIds = (userRules || [])
      .filter((r) => Number(r.useDynamicScope ?? r.use_dynamic_scope) === 1 && r.id != null)
      .map((r) => r.id)
    if (dynamicRuleIds.length > 0) {
      const placeholders = dynamicRuleIds.map(() => '?').join(',')
      const [rows] = await pool.execute(
        `SELECT rule_id, COUNT(*) AS cnt FROM rule_matched_objects WHERE rule_id IN (${placeholders}) GROUP BY rule_id`,
        dynamicRuleIds
      )
      const countByRuleId = new Map()
      for (const row of rows || []) {
        countByRuleId.set(row.rule_id, row.cnt == null ? 0 : Number(row.cnt))
      }
      for (const rule of userRules) {
        if (countByRuleId.has(rule.id)) {
          rule.matched_count = countByRuleId.get(rule.id)
        }
      }
    }

    res.json({
      rules: userRules,
      count: userRules.length,
      isAdmin: isAdmin  // 返回给前端，方便 UI 展示
    })
  } catch (error) {
    logger.error('获取规则列表失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules/bootstrap-from-templates
 * 显式全量铺底：仅当当前 owner 维度下规则数为 0 时，按启用模板生成半成品（enabled=false）
 * 原则 B：禁止在 GET /api/rules 内做写入副作用
 */
router.post('/rules/bootstrap-from-templates', requireAuth, requireActive, async (req, res) => {
  try {
    const ownerId = req.user.owner_id != null ? Number(req.user.owner_id) : null
    if (!ownerId || !Number.isFinite(ownerId)) {
      return res.status(400).json({ error: '当前用户未绑定负责人(owner_id)，无法执行铺底', code: 'MISSING_OWNER' })
    }

    const [ownerRows] = await pool.execute(
      `SELECT id, owner_key, is_active FROM owners WHERE id = ? LIMIT 1`,
      [ownerId]
    )
    const owner = ownerRows?.[0]
    if (!owner || Number(owner.is_active) !== 1 || String(owner.owner_key || '') === 'none') {
      return res.status(400).json({ error: '当前负责人不可用于模板铺底', code: 'INVALID_OWNER' })
    }

    const summary = await bootstrapTemplatesForOwnerIfEmpty({
      ownerId,
      actorUserId: req.user.id ?? null,
      actorOwnerId: ownerId
    })
    return res.json({
      success: true,
      message: summary.created > 0 ? `已生成 ${summary.created} 条半成品规则` : '无新增规则（可能已存在规则或模板为空）',
      ...summary
    })
  } catch (error) {
    logger.error('模板半成品铺底失败:', error)
    return res.status(500).json({ error: error.message || '铺底失败', code: 'ERROR' })
  }
})

/**
 * POST /api/rules/preview-dynamic-scope
 * 预览动态范围全量 ID（与规则执行共用 calculateMatchedAdIdsForRule，消除 91 vs 101 盲区）
 * 须注册在 /rules/:id 之前，避免 preview-dynamic-scope 被当作 id。
 * 请求体：account_ids（必）, scope_filters（必）, target_level（可选默认 ad）, exclude_ids（可选）, max_dynamic_matches（可选）
 */
router.post('/rules/preview-dynamic-scope', requireAuth, requireActive, async (req, res, next) => {
  try {
    const body = req.body || {}
    let accountIds = []
    const rawAccounts = body.account_ids
    if (Array.isArray(rawAccounts)) {
      accountIds = rawAccounts.map((id) => String(id || '').trim()).filter(Boolean)
    } else if (typeof rawAccounts === 'string') {
      accountIds = rawAccounts.split(',').map((s) => s.trim()).filter(Boolean)
    }
    accountIds = [...new Set(accountIds)]
    if (accountIds.length === 0) {
      return res.status(400).json({ error: 'account_ids 必填且至少一个有效账户', code: 'ACCOUNT_IDS_REQUIRED' })
    }

    let scopeFilters = body.scope_filters
    if (!scopeFilters || typeof scopeFilters !== 'object') {
      return res.status(400).json({ error: 'scope_filters 必填且为对象', code: 'SCOPE_FILTERS_REQUIRED' })
    }
    const targetLevel = (body.target_level || 'ad').trim().toLowerCase()
    if (!['ad', 'adset', 'campaign'].includes(targetLevel)) {
      return res.status(400).json({ error: 'target_level 仅支持 ad/adset/campaign', code: 'INVALID_TARGET_LEVEL' })
    }
    scopeFilters = { ...scopeFilters }
    if (!scopeFilters.level) {
      scopeFilters.level = targetLevel
    }

    const rawExclude = body.exclude_ids
    const excludeIds = !rawExclude || typeof rawExclude !== 'object'
      ? null
      : {
          ad_ids: Array.isArray(rawExclude.ad_ids) ? rawExclude.ad_ids.map((id) => String(id)).filter(Boolean) : [],
          adset_ids: Array.isArray(rawExclude.adset_ids) ? rawExclude.adset_ids.map((id) => String(id)).filter(Boolean) : [],
          campaign_ids: Array.isArray(rawExclude.campaign_ids) ? rawExclude.campaign_ids.map((id) => String(id)).filter(Boolean) : []
        }

    for (const accountId of accountIds) {
      if (!(await assertAccountAccess(req, res, accountId))) return
    }

    const maxDynamicMatches = body.max_dynamic_matches != null && Number.isFinite(Number(body.max_dynamic_matches))
      ? Math.max(1, Math.min(Number(body.max_dynamic_matches), 5000))
      : undefined

    const result = await previewDynamicScope(accountIds, {
      scopeFilters,
      excludeIds,
      targetLevel,
      maxDynamicMatches
    })
    return res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/rules/:id
 * 获取特定规则的详情
 */
router.get('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    const rule = await rulesService.getRuleById(ruleId, userId, isAdmin, req.user.owner_id ?? null)
    
    if (!rule) {
      return res.status(404).json({ error: '规则不存在或无权访问' })
    }

    if (Number(rule.useDynamicScope ?? rule.use_dynamic_scope) === 1) {
      const [rows] = await pool.execute(
        'SELECT COUNT(*) AS cnt FROM rule_matched_objects WHERE rule_id = ?',
        [ruleId]
      )
      rule.matched_count = rows?.[0]?.cnt ?? 0
      const [matchedRows] = await pool.execute(
        'SELECT account_id, object_id FROM rule_matched_objects WHERE rule_id = ?',
        [ruleId]
      )
      const rawTargetIds = rule.targetIds ?? rule.target_ids ?? []
      const targetIds = Array.isArray(rawTargetIds) ? rawTargetIds : (typeof rawTargetIds === 'string' ? (() => { try { return JSON.parse(rawTargetIds) } catch { return [] } })() : [])
      const matchedSet = new Set((matchedRows || []).map((r) => `${normalizeAccountId(r.account_id)}:${String(r.object_id || '').trim()}`))
      const configuredSet = new Set()
      for (const compositeId of targetIds) {
        const p = parseCompositeId(compositeId)
        if (p) configuredSet.add(`${p.accountId}:${p.objId}`)
      }
      rule.invalid_ids = [...configuredSet].filter((c) => !matchedSet.has(c))
      // 可选：最近一次历史中的 manual_count / dynamic_count，便于界面展示「动态 X / 手动 Y」
      const [historyRows] = await pool.execute(
        `SELECT manual_count, dynamic_count, refreshed_at, trigger_type
         FROM rule_matched_objects_history
         WHERE rule_id = ? ORDER BY refreshed_at DESC LIMIT 1`,
        [ruleId]
      )
      if (historyRows?.[0]) {
        const h = historyRows[0]
        rule.last_matched_history = {
          manualCount: h.manual_count,
          dynamicCount: h.dynamic_count,
          refreshedAt: h.refreshed_at,
          triggerType: h.trigger_type
        }
      }
    }

    res.json({ rule })
  } catch (error) {
    logger.error('获取规则详情失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules
 * 创建新规则
 * 请求体：
 *   - ruleName: 规则名称（必填）
 *   - accountId: 广告账户ID（必填，规则必须绑定账户）
 *   - conditions: 规则条件数组（必填）
 *   - actions: 执行操作数组（必填）
 *   - enabled: 是否启用（可选，默认 true）
 *   - targetLevel, targetIds, logicOperator, timezoneName, isSimulation: M3 新增字段
 * 
 * 权限校验：
 *   - 普通用户：accountId 必须属于该用户的负责人（owner_id），且账户必须激活
 *   - 管理员：可以绑定任意账户，但账户必须存在且激活
 */
router.post('/rules', requireAuth, requireActive, async (req, res) => {
  try {
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    const ownerId = req.user.owner_id
    
    const { 
      ruleName, 
      accountId,
      conditions, 
      actions, 
      enabled,
      targetLevel,
      targetIds,
      targetAccounts,      // 多选账户：['act_1','act_2']，落库为 target_account_ids
      target_by_account,   // 方案B：{ "act_1": ["id1","id2"], "act_2": ["id3"] }
      logicOperator,
      timezoneName,
      isSimulation,
      executionIntervalMinutes,
      executionTimeWindows,
      useDynamicScope,
      scopeFilters,
      excludeIds,
      maxDynamicMatches
    } = req.body
    
    // ✅ 方案三：accountId 必填校验（防止反向索引退化）
    // 使用 String() 防御非字符串类型，避免 .trim() 抛异常
    const accountIdStr = accountId != null ? String(accountId).trim() : ''
    if (!accountIdStr) {
      return res.status(400).json({ 
        error: '缺少必填字段: accountId（请选择广告账户）',
        code: 'MISSING_ACCOUNT_ID'
      })
    }
    
    // 验证必填字段
    if (!ruleName || !conditions || !actions) {
      return res.status(400).json({ 
        error: '缺少必填字段：ruleName, conditions, actions',
        code: 'MISSING_FIELDS'
      })
    }
    
    // 验证 actions 是数组且结构合法（与模板校验一致）
    if (!Array.isArray(actions)) {
      return res.status(400).json({ 
        error: 'actions 必须是数组',
        code: 'INVALID_FORMAT'
      })
    }
    const actCheck = validateActions(actions)
    if (!actCheck.valid) {
      return res.status(400).json({ error: actCheck.error, code: 'INVALID_ACTIONS' })
    }
    // 验证 conditions：允许 v1 array 或 v2 object
    const condCheck = validateConditionsStructure(conditions)
    if (!condCheck.valid) {
      return res.status(400).json({ error: condCheck.error, code: 'INVALID_CONDITIONS' })
    }
    const logicOp = logicOperator || 'AND'
    const normalizedForTw = normalizeConditionsToV2(conditions, logicOp)
    const twCheck = validateTimeWindowConsistency(normalizedForTw)
    if (!twCheck.valid) {
      return res.status(400).json({ error: twCheck.error, code: 'INCONSISTENT_TIME_WINDOW' })
    }
    
    // 验证 targetLevel（如果提供）
    if (targetLevel && !['ad', 'adset', 'campaign'].includes(targetLevel)) {
      return res.status(400).json({ 
        error: 'targetLevel 必须是 ad、adset 或 campaign',
        code: 'INVALID_TARGET_LEVEL'
      })
    }
    
    // 验证 logicOperator（如果提供）
    if (logicOperator && !['AND', 'OR'].includes(logicOperator)) {
      return res.status(400).json({ 
        error: 'logicOperator 必须是 AND 或 OR',
        code: 'INVALID_LOGIC_OPERATOR'
      })
    }
    
    // ✅ 方案三：权限校验（防止普通用户把规则绑到不属于自己的账户）
    if (!isAdmin) {
      // 普通用户：accountId 必须属于自己的负责人且 active
      if (!ownerId) {
        return res.status(400).json({ 
          error: '当前用户未绑定负责人(owner_id)，无法创建规则',
          code: 'MISSING_OWNER'
        })
      }
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings 
         WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
         LIMIT 1`,
        [accountIdStr, ownerId]
      )
      if (rows.length === 0) {
        return res.status(403).json({ 
          error: '无权访问该广告账户，无法创建规则',
          code: 'ACCOUNT_FORBIDDEN'
        })
      }
    } else {
      // 管理员：建议也校验账户存在且 active（避免写错 accountId）
      const [rows] = await pool.execute(
        `SELECT 1 FROM account_mappings 
         WHERE fb_account_id = ? AND is_active = 1 
         LIMIT 1`,
        [accountIdStr]
      )
      if (rows.length === 0) {
        return res.status(400).json({ 
          error: '广告账户不存在或未激活(account_mappings)，无法创建规则',
          code: 'ACCOUNT_NOT_FOUND'
        })
      }
    }
    
    // 多选账户：校验 targetAccounts / target_by_account 中每个账户的权限（与 accountId 一致）
    const targetAccountIds = Array.isArray(targetAccounts) && targetAccounts.length > 0
      ? targetAccounts.map(a => String(a).trim()).filter(Boolean)
      : null
    const targetByAccount = target_by_account && typeof target_by_account === 'object' ? target_by_account : null
    if (targetAccountIds && targetAccountIds.length > 0 && !isAdmin) {
      for (const aid of targetAccountIds) {
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1`,
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    const dynamicPayload = parseDynamicScopePayload({
      useDynamicScope,
      scopeFilters,
      excludeIds,
      maxDynamicMatches
    })
    const dynamicCheck = validateDynamicScopePayload(dynamicPayload, targetLevel)
    if (!dynamicCheck.valid) {
      return res.status(400).json({ error: dynamicCheck.error, code: dynamicCheck.code || 'INVALID_DYNAMIC_SCOPE' })
    }

    const newRule = await rulesService.createRule(userId, {
      ruleName,
      accountId: accountIdStr,
      conditions,
      actions,
      enabled,
      targetLevel,
      targetIds: targetIds ?? [],
      targetAccountIds: targetAccountIds ?? null,
      targetByAccount: targetByAccount ?? null,
      logicOperator,
      timezoneName,
      isSimulation,
      executionIntervalMinutes: executionIntervalMinutes ?? 15,
      executionTimeWindows: executionTimeWindows ?? null,
      ...dynamicCheck.updates
    }, ownerId ?? undefined)

    // TriggerB：规则保存后异步刷新动态快照（多账户规则按目标账户逐个防抖）
    if (isDynamicScopeFeatureEnabled()) {
      await scheduleDynamicScopeRefreshForRule(newRule.id, { trigger: 'rule_saved' })
    }
    
    res.status(201).json({
      message: '规则创建成功',
      rule: newRule
    })
  } catch (error) {
    logger.error('创建规则失败:', error)
    const mapped = mapRuleErrorToResponse(error)
    res.status(mapped.statusCode).json({ error: error.message, code: mapped.code })
  }
})

/**
 * PUT /api/rules/:id
 * 更新规则
 * 请求体：要更新的字段（白名单模式，只允许更新指定字段）
 * 
 * 权限校验：
 *   - 如果更新 accountId，必须做权限校验（同 POST 规则）
 *   - 普通用户：只能绑定自己负责的账户
 *   - 管理员：可以绑定任意账户，但账户必须存在且激活
 */
router.put('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    const ownerId = req.user.owner_id
    const body = req.body || {}
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }

    
    // 验证 updates 不为空
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: '请提供要更新的字段' })
    }
    
    const allowed = [
      'ruleName',
      'accountId',
      'conditions',
      'actions',
      'enabled',
      'targetLevel',
      'targetIds',
      'targetAccountIds',
      'targetByAccount',
      'logicOperator',
      'timezoneName',
      'isSimulation',
      'executionIntervalMinutes',
      'executionTimeWindows',
      'useDynamicScope',
      'scopeFilters',
      'excludeIds',
      'maxDynamicMatches'
    ]
    
    const updates = {}
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        updates[k] = body[k]
      }
    }
    if (body.targetAccounts != null) updates.targetAccountIds = Array.isArray(body.targetAccounts) ? body.targetAccounts : null
    if (body.target_by_account != null && typeof body.target_by_account === 'object') updates.targetByAccount = body.target_by_account
    if (body.execution_interval_minutes != null) updates.executionIntervalMinutes = body.execution_interval_minutes
    if (body.execution_time_windows != null) updates.executionTimeWindows = body.execution_time_windows
    const dynamicPayload = parseDynamicScopePayload(body)
    const dynamicCheck = validateDynamicScopePayload(dynamicPayload, updates.targetLevel || body.targetLevel || 'ad')
    if (!dynamicCheck.valid) {
      return res.status(400).json({ error: dynamicCheck.error, code: dynamicCheck.code || 'INVALID_DYNAMIC_SCOPE' })
    }
    Object.assign(updates, dynamicCheck.updates)


    if (updates.targetAccountIds && updates.targetAccountIds.length > 0 && !isAdmin) {
      for (const aid of updates.targetAccountIds) {
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1`,
          [aid, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ error: `无权访问广告账户 ${aid}`, code: 'ACCOUNT_FORBIDDEN' })
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有可更新的合法字段' })
    }
    
    if (updates.conditions) {
      const condCheck = validateConditionsStructure(updates.conditions)
      if (!condCheck.valid) {
        return res.status(400).json({ error: condCheck.error, code: 'INVALID_CONDITIONS' })
      }
      const logicOp = updates.logicOperator ?? 'AND'
      const normalizedForTw = normalizeConditionsToV2(updates.conditions, logicOp)
      const twCheck = validateTimeWindowConsistency(normalizedForTw)
      if (!twCheck.valid) {
        return res.status(400).json({ error: twCheck.error, code: 'INCONSISTENT_TIME_WINDOW' })
      }
    }
    if (updates.actions) {
      if (!Array.isArray(updates.actions)) {
        return res.status(400).json({ error: 'actions 必须是数组' })
      }
      const actCheck = validateActions(updates.actions)
      if (!actCheck.valid) {
        return res.status(400).json({ error: actCheck.error, code: 'INVALID_ACTIONS' })
      }
    }
    
    // ✅ 方案三：如果更新 accountId，必须做权限校验
    if (Object.prototype.hasOwnProperty.call(updates, 'accountId')) {
      // 使用 String() 防御非字符串类型，避免 .trim() 抛异常
      const accountIdStr = updates.accountId != null ? String(updates.accountId).trim() : ''
      if (!accountIdStr) {
        return res.status(400).json({ 
          error: '缺少必填字段: accountId（请选择广告账户）',
          code: 'MISSING_ACCOUNT_ID'
        })
      }
      
      if (!isAdmin) {
        // 普通用户：accountId 必须属于自己的负责人且 active
        if (!ownerId) {
          return res.status(400).json({ 
            error: '当前用户未绑定负责人(owner_id)，无法修改规则账户',
            code: 'MISSING_OWNER'
          })
        }
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings 
           WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
           LIMIT 1`,
          [accountIdStr, ownerId]
        )
        if (rows.length === 0) {
          return res.status(403).json({ 
            error: '无权访问该广告账户，无法修改规则',
            code: 'ACCOUNT_FORBIDDEN'
          })
        }
      } else {
        // 管理员：建议也校验账户存在且 active（避免写错 accountId）
        const [rows] = await pool.execute(
          `SELECT 1 FROM account_mappings 
           WHERE fb_account_id = ? AND is_active = 1 
           LIMIT 1`,
          [accountIdStr]
        )
        if (rows.length === 0) {
          return res.status(400).json({ 
            error: '广告账户不存在或未激活(account_mappings)，无法修改规则',
            code: 'ACCOUNT_NOT_FOUND'
          })
        }
      }
      
      // 确保 accountId 是字符串（使用已校验的值）
      updates.accountId = accountIdStr
    }
    
    // ✅ 方案三：补充 PUT 路由的校验（与 POST 保持一致）
    // 验证 targetLevel（如果提供）
    if (updates.targetLevel && !['ad', 'adset', 'campaign'].includes(updates.targetLevel)) {
      return res.status(400).json({ 
        error: 'targetLevel 必须是 ad、adset 或 campaign',
        code: 'INVALID_TARGET_LEVEL'
      })
    }
    
    // 验证 logicOperator（如果提供）
    if (updates.logicOperator && !['AND', 'OR'].includes(updates.logicOperator)) {
      return res.status(400).json({ 
        error: 'logicOperator 必须是 AND 或 OR',
        code: 'INVALID_LOGIC_OPERATOR'
      })
    }
    
    // 验证 targetIds（如果提供，必须是数组）
    if (updates.targetIds && !Array.isArray(updates.targetIds)) {
      return res.status(400).json({ 
        error: 'targetIds 必须是数组',
        code: 'INVALID_TARGET_IDS'
      })
    }

    // 原则 A：合并后若 enabled=true，校验执行所需最小配置（半成品未补全不可开闸）
    const existingForGate = await rulesService.getRuleById(ruleId, userId, isAdmin, req.user.owner_id ?? null)
    if (!existingForGate) {
      return res.status(404).json({ error: '规则不存在或无权访问', code: 'NOT_FOUND' })
    }
    const currentUseDynamicScope = Number(existingForGate.useDynamicScope ?? existingForGate.use_dynamic_scope) === 1
    const mergedUseDynamicScope = Object.prototype.hasOwnProperty.call(updates, 'useDynamicScope')
      ? !!updates.useDynamicScope
      : currentUseDynamicScope
    if (mergedUseDynamicScope === false && hasEffectiveScopeFilters(updates.scopeFilters)) {
      return res.status(400).json({
        error: '动态筛选关闭时不可设置监控范围条件',
        code: 'DYNAMIC_SCOPE_DISABLED_SCOPE_FILTERS_FORBIDDEN'
      })
    }
    const mergedForGate = mergeRuleForEnableCheck(existingForGate, updates)
    const gate = await assertRuleReadyToEnable(mergedForGate, { isAdmin, ownerId: ownerId ?? null })
    if (!gate.ok) {
      return res.status(400).json({ error: gate.error, code: gate.code })
    }
    
    // 更新规则（管理员可以更新所有规则）
    const updatedRule = await rulesService.updateRule(
      ruleId,
      userId,
      updates,
      isAdmin,
      ownerId ?? undefined,
      req.user.owner_id ?? null
    )

    // TriggerB：规则保存后异步刷新动态快照（多账户规则按目标账户逐个防抖）
    if (isDynamicScopeFeatureEnabled()) {
      await scheduleDynamicScopeRefreshForRule(updatedRule.id, { trigger: 'rule_saved' })
    }
    
    res.json({
      message: '规则更新成功',
      rule: updatedRule
    })
  } catch (error) {
    logger.error('更新规则失败:', error)
    const mapped = mapRuleErrorToResponse(error)
    res.status(mapped.statusCode).json({ error: error.message, code: mapped.code })
  }
})

/**
 * POST /api/rules/dynamic-scope/refresh-account
 * TriggerC：手动重算指定账户的动态筛选快照（立即执行，非防抖）
 * 请求体：
 *   - accountId: string（可选）
 *   - ruleId: number（可选，提供时将自动推导 accountId）
 */
router.post('/rules/dynamic-scope/refresh-account', requireAuth, requireActive, async (req, res) => {
  try {
    if (!isDynamicScopeFeatureEnabled()) {
      return res.status(400).json({ error: '动态筛选功能未开启(ENABLE_DYNAMIC_SCOPE=false)', code: 'FEATURE_DISABLED' })
    }

    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    const accountIdFromBody = req.body?.accountId != null ? String(req.body.accountId).trim() : ''
    const ruleIdFromBody = req.body?.ruleId != null ? parseInt(req.body.ruleId, 10) : null

    let accountId = accountIdFromBody
    let refreshByRule = false
    if (!accountId && ruleIdFromBody && !Number.isNaN(ruleIdFromBody)) {
      const rule = await rulesService.getRuleById(ruleIdFromBody, userId, isAdmin, req.user.owner_id ?? null)
      if (!rule) {
        return res.status(404).json({ error: '规则不存在或无权访问', code: 'RULE_NOT_FOUND' })
      }
      refreshByRule = true
      accountId = String(rule.accountId || '').trim()
    }

    if (!accountId) {
      return res.status(400).json({ error: '请提供 accountId 或 ruleId', code: 'MISSING_ACCOUNT' })
    }

    if (!isAdmin && accountId) {
      const ok = await assertAccountAccess(req, res, accountId)
      if (!ok) return
    }

    if (refreshByRule && ruleIdFromBody) {
      const result = await refreshDynamicTargetsForRule(ruleIdFromBody, { trigger: 'manual' })
      return res.json({ success: true, ruleId: ruleIdFromBody, trigger: 'manual', result })
    }

    const result = await refreshDynamicTargetsForAccount(accountId, { trigger: 'manual' })
    return res.json({ success: true, accountId, trigger: 'manual', result })
  } catch (error) {
    logger.error('手动刷新动态筛选失败:', error)
    return res.status(500).json({ error: error.message || '刷新失败', code: 'ERROR' })
  }
})

/**
 * DELETE /api/rules/:id
 * 删除规则
 */
router.delete('/rules/:id', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    // 删除规则（管理员可以删除所有规则）
    await rulesService.deleteRule(ruleId, userId, isAdmin, req.user.owner_id ?? null)
    
    res.json({
      message: '规则删除成功'
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    logger.error('删除规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/rules/:id/toggle
 * 启用/禁用规则
 * 请求体：
 *   - enabled: true/false
 */
router.patch('/rules/:id/toggle', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    const { enabled } = req.body
    
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID' })
    }
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值' })
    }

    const existingToggle = await rulesService.getRuleById(ruleId, userId, isAdmin, req.user.owner_id ?? null)
    if (!existingToggle) {
      return res.status(404).json({ error: '规则不存在或无权访问' })
    }
    if (enabled) {
      const mergedToggle = mergeRuleForEnableCheck(existingToggle, { enabled })
      const gateToggle = await assertRuleReadyToEnable(mergedToggle, {
        isAdmin,
        ownerId: req.user.owner_id ?? null
      })
      if (!gateToggle.ok) {
        return res.status(400).json({ error: gateToggle.error, code: gateToggle.code })
      }
    }
    
    // 启用/禁用规则（管理员可以操作所有规则）
    const updatedRule = await rulesService.toggleRule(
      ruleId,
      userId,
      enabled,
      isAdmin,
      req.user.owner_id ?? undefined,
      req.user.owner_id ?? null
    )
    
    res.json({
      message: `规则已${enabled ? '启用' : '禁用'}`,
      rule: updatedRule
    })
  } catch (error) {
    if (error.message === '规则不存在或无权访问') {
      return res.status(404).json({ error: error.message })
    }
    logger.error('启用/禁用规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/rules/:id/execute
 * 单条规则手动执行（仅执行这一条规则，force 忽略冷却期）
 * - admin：可执行任意规则
 * - 非 admin：只能执行自己创建的规则，且规则绑定的 accountId 须属于自己 owner_id
 */
router.post('/rules/:id/execute', requireAuth, requireActive, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id)
    const userId = req.user.id
    const isAdmin = isAdminLikeRole(req.user.role)
    if (isNaN(ruleId)) {
      return res.status(400).json({ error: '无效的规则 ID', code: 'INVALID_ID' })
    }
    const rule = await rulesService.getRuleById(ruleId, userId, isAdmin, req.user.owner_id ?? null)
    if (!rule) {
      return res.status(404).json({ error: '规则不存在或无权访问', code: 'NOT_FOUND' })
    }
    if (!isAdmin && !(await assertAccountAccess(req, res, rule.accountId))) return
    let ownerId = req.user.owner_id
    if (isAdmin) {
      const [rows] = await pool.execute(
        'SELECT owner_id FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
        [rule.accountId]
      )
      ownerId = rows[0]?.owner_id ?? 0
    }
    const status = getCronStatus()
    if (status.isRunning) {
      return res.status(409).json({
        error: '规则正在执行中，请稍后再试',
        code: 'ALREADY_RUNNING'
      })
    }
    const runId = generateRunId()
    const result = await executeSingleRule(rule, { force: true, runId, ownerId })
    if (result == null) {
      return res.status(409).json({
        error: '该账户规则正在执行中，请稍后再试',
        code: 'ACCOUNT_LOCKED'
      })
    }
    res.json({
      success: true,
      message: '已执行',
      rule_id: result.rule_id,
      account_id: result.account_id,
      matched_count: result.matched_count,
      executed_count: result.executed_count,
      failed_count: result.failed_count,
      status: result.status,
      run_id: result.run_id
    })
  } catch (error) {
    logger.error('单条规则执行失败:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router


