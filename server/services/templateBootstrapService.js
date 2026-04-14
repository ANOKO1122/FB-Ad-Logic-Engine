import pool from '../db/connection.js'
import logger from '../utils/logger.js'
import { insertRuleHistory, buildRuleSnapshot } from './ruleHistoryService.js'

function parseMysqlJson(val, fallback = null) {
  if (val == null) return fallback
  if (typeof val === 'object' && !Buffer.isBuffer(val)) return val
  if (Buffer.isBuffer(val)) {
    try { return JSON.parse(val.toString('utf8')) } catch { return fallback }
  }
  if (typeof val === 'string') {
    try { return JSON.parse(val) } catch { return fallback }
  }
  return fallback
}

function toV2ConditionsFromTemplate(template) {
  const linesRaw = parseMysqlJson(template.when_lines, [])
  const lines = Array.isArray(linesRaw) ? linesRaw : []
  const timeWindow = String(template.when_time_window || 'today').trim() || 'today'
  const customRangeRaw = parseMysqlJson(template.when_custom_range, null)
  const customRange = customRangeRaw && typeof customRangeRaw === 'object' ? customRangeRaw : null

  const groups = []
  let currentGroup = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const cond = {
      metric: line.metric,
      operator: line.operator,
      value: line.value,
      time_window: timeWindow
    }
    if (timeWindow === 'custom_range' && customRange) {
      cond.custom_range = { ...customRange }
    }
    if (line.join === 'OR') {
      if (currentGroup.length > 0) {
        groups.push({ operator: 'AND', conditions: currentGroup })
      }
      currentGroup = [cond]
    } else {
      currentGroup.push(cond)
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ operator: 'AND', conditions: currentGroup })
  }
  return { version: 2, groups }
}

async function selectOwnerTemplateStubsCount(ownerId) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c
     FROM rules r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE COALESCE(r.owner_id, u.owner_id) = ?`,
    [ownerId]
  )
  return Number(rows?.[0]?.c || 0)
}

async function selectBootstrapTemplates(mode, templateRecord = null) {
  if (mode === 'incremental' && templateRecord) return [templateRecord]
  const [rows] = await pool.execute(
    `SELECT id, name, slug, when_lines, when_time_window, when_custom_range, actions
     FROM rule_templates
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`
  )
  return rows || []
}

async function selectBootstrapUserId(ownerId) {
  const [rows] = await pool.execute(
    `SELECT id
     FROM users
     WHERE owner_id = ? AND status = 'active'
     ORDER BY id ASC
     LIMIT 1`,
    [ownerId]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}

async function insertStubRuleForTemplate({
  ownerId,
  userId,
  template,
  actorUserId = null,
  actorOwnerId = null
}) {
  const sourceTemplateSlug = String(template.slug || '').trim()
  if (!sourceTemplateSlug) {
    return { created: false, skipped: true, reason: 'missing_template_slug' }
  }

  const conditions = toV2ConditionsFromTemplate(template)
  const actions = parseMysqlJson(template.actions, [])
  const actionsArr = Array.isArray(actions) ? actions : []
  const ruleName = String(template.name || sourceTemplateSlug).trim() || sourceTemplateSlug

  try {
    const [result] = await pool.execute(
      `INSERT INTO rules (
        user_id, owner_id, account_id, rule_name, source_template_slug,
        target_level, target_ids, target_account_ids, target_by_account,
        conditions, logic_operator, actions, enabled,
        timezone_name, is_simulation, execution_interval_minutes, execution_time_windows,
        use_dynamic_scope, scope_filters, exclude_ids, max_dynamic_matches
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        ownerId,
        null,
        ruleName,
        sourceTemplateSlug,
        'ad',
        JSON.stringify([]),
        null,
        null,
        JSON.stringify(conditions),
        'AND',
        JSON.stringify(actionsArr),
        0,
        'UTC',
        0,
        15,
        null,
        0,
        null,
        null,
        1000
      ]
    )

    const ruleId = Number(result.insertId)
    const [rows] = await pool.execute('SELECT * FROM rules WHERE id = ? LIMIT 1', [ruleId])
    const createdRule = rows?.[0] || null
    if (createdRule) {
      try {
        await insertRuleHistory({
          ruleId,
          changeType: 'CREATE',
          source: 'api_save',
          changedByUserId: actorUserId ?? null,
          changedByOwnerId: actorOwnerId ?? null,
          ruleSnapshot: buildRuleSnapshot(createdRule),
          snapshotBefore: null
        })
      } catch (e) {
        logger.warn('[template-bootstrap] insert rule_history failed', {
          ruleId,
          ownerId,
          templateSlug: sourceTemplateSlug,
          err: e.message
        })
      }
    }
    return { created: true, skipped: false, ruleId, slug: sourceTemplateSlug }
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return { created: false, skipped: true, reason: 'duplicate_stub', slug: sourceTemplateSlug }
    }
    throw err
  }
}

/**
 * 为单个 owner 执行模板半成品铺底。
 * mode=full：按当前全部启用模板逐个尝试。
 * mode=incremental：仅对 templateRecord 尝试一次。
 */
export async function bootstrapTemplatesForOwner({
  ownerId,
  mode = 'full',
  templateRecord = null,
  actorUserId = null,
  actorOwnerId = null
}) {
  const summary = {
    ownerId,
    mode,
    templatesTotal: 0,
    created: 0,
    skipped: 0,
    skippedNoActiveUser: false
  }

  const userId = await selectBootstrapUserId(ownerId)
  if (!userId) {
    summary.skippedNoActiveUser = true
    logger.warn('[template-bootstrap] owner has no active user, skip', { ownerId })
    return summary
  }

  const templates = await selectBootstrapTemplates(mode, templateRecord)
  summary.templatesTotal = templates.length
  for (const template of templates) {
    const one = await insertStubRuleForTemplate({
      ownerId,
      userId,
      template,
      actorUserId,
      actorOwnerId
    })
    if (one.created) summary.created += 1
    else summary.skipped += 1
  }
  return summary
}

/**
 * 全量铺底：仅用于显式 POST /api/rules/bootstrap-from-templates
 * 规则：若 owner 下已有任意规则，直接返回（避免“非 0 规则仍全量铺底”）。
 */
export async function bootstrapTemplatesForOwnerIfEmpty({
  ownerId,
  actorUserId = null,
  actorOwnerId = null
}) {
  const existingCount = await selectOwnerTemplateStubsCount(ownerId)
  if (existingCount > 0) {
    return {
      ownerId,
      mode: 'full',
      templatesTotal: 0,
      created: 0,
      skipped: 0,
      skippedNoActiveUser: false,
      existingCount,
      reason: 'owner_rules_not_empty'
    }
  }
  const summary = await bootstrapTemplatesForOwner({
    ownerId,
    mode: 'full',
    actorUserId,
    actorOwnerId
  })
  return { ...summary, existingCount }
}

export async function listActiveBusinessOwners() {
  const [rows] = await pool.execute(
    `SELECT id, owner_key
     FROM owners
     WHERE is_active = 1
       AND (owner_key IS NULL OR owner_key <> 'none')
     ORDER BY id ASC`
  )
  return rows || []
}

/**
 * 增量铺底：管理员新建模板成功后，对每个活跃 owner 尝试插入一条半成品（幂等跳过）。
 */
export async function bootstrapTemplateForAllOwnersIncremental({
  templateRecord,
  actorUserId = null,
  actorOwnerId = null
}) {
  const owners = await listActiveBusinessOwners()
  const summary = {
    ownersTotal: owners.length,
    created: 0,
    skipped: 0,
    skippedNoActiveUserOwners: 0
  }
  for (const owner of owners) {
    const one = await bootstrapTemplatesForOwner({
      ownerId: Number(owner.id),
      mode: 'incremental',
      templateRecord,
      actorUserId,
      actorOwnerId
    })
    summary.created += one.created
    summary.skipped += one.skipped
    if (one.skippedNoActiveUser) {
      summary.skippedNoActiveUserOwners += 1
    }
  }
  return summary
}
