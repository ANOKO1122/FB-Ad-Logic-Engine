// 规则服务层 - 使用 Drizzle ORM 操作 rules 表
// 注意：这是新功能，使用 Drizzle；旧功能（用户管理）继续使用原生 SQL
import { db } from '../db/drizzle.js'
import { rules, users, owners } from '../db/schema.js'
import { eq, and, desc, inArray, or, sql } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'
import { getAccountTimezone } from './ruleDataService.js'
import pool from '../db/connection.js'
import { parseCompositeId } from '../utils/targetIdUtils.js'
import { insertRuleHistory, buildRuleSnapshot } from './ruleHistoryService.js'
import logger from '../utils/logger.js'

/**
 * 以 target_ids 为唯一真理，强制生成并覆盖 target_by_account，并归一化 target_ids（去 act_act_ 等脏数据）。
 * 约定：保存规则时 createRule/updateRule 必须经此归一化后再落库，见 docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md
 * @param {object} rule - 含 target_ids / targetIds 的对象，会被原地修改
 */
function syncTargetByAccount(rule) {
  const raw = rule.target_ids ?? rule.targetIds
  const targetIds = Array.isArray(raw) ? raw : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return [] } })() : [])
  const newMap = {}
  let normalizedTargetIds = []
  for (const compositeId of targetIds) {
    const parsed = parseCompositeId(compositeId)
    if (!parsed) continue
    const { accountId, objId } = parsed
    if (!newMap[accountId]) newMap[accountId] = []
    if (!newMap[accountId].includes(objId)) {
      newMap[accountId].push(objId)
      normalizedTargetIds.push(`${accountId}:${objId}`)
    }
  }
  // 兜底：targetIds 为裸 id 时 parse 全失败，用前端传来的 target_by_account 反推复合 ID 再落库
  const byAccountRaw = rule.target_by_account ?? rule.targetByAccount
  if (normalizedTargetIds.length === 0 && byAccountRaw && typeof byAccountRaw === 'object' && Object.keys(byAccountRaw).length > 0) {
    const fallbackMap = {}
    for (const accountId of Object.keys(byAccountRaw)) {
      const arr = byAccountRaw[accountId]
      if (!Array.isArray(arr)) continue
      fallbackMap[accountId] = []
      for (const objId of arr) {
        const s = String(objId || '').trim()
        if (!s) continue
        if (!fallbackMap[accountId].includes(s)) {
          fallbackMap[accountId].push(s)
          normalizedTargetIds.push(`${accountId}:${s}`)
        }
      }
    }
    if (Object.keys(fallbackMap).length > 0) {
      Object.assign(newMap, fallbackMap)
    }
  }
  rule.targetByAccount = newMap
  rule.target_by_account = newMap
  rule.targetIds = normalizedTargetIds
  rule.target_ids = normalizedTargetIds
}

/**
 * 创建规则
 * @param {number} userId - 用户 ID
 * @param {object} ruleData - 规则数据
 * @param {number|null} [ownerId] - 负责人 ID（可选，用于 rule_history.changed_by_owner_id）
 * @returns {Promise<object>} 新创建的规则
 */
export async function createRule(userId, ruleData, ownerId = null) {
  // 时区：空字符串/全空格/'UTC' 视为未指定，落库用账户时区
  const tzRaw = ruleData.timezoneName ?? ruleData.timezone_name
  const tzNorm = typeof tzRaw === 'string' ? tzRaw.trim() : ''
  const timezoneName = (!tzNorm || tzNorm === 'UTC')
    ? await getAccountTimezone(ruleData.accountId)
    : tzNorm
  syncTargetByAccount(ruleData)
  const result = await db.insert(rules).values({
    userId: userId,
    rulesOwnerId: ownerId ?? null,
    accountId: ruleData.accountId,
    ruleName: ruleData.ruleName,
    sourceTemplateSlug: ruleData.sourceTemplateSlug ?? null,
    targetLevel: ruleData.targetLevel || 'ad',
    targetIds: ruleData.targetIds || [],
    targetAccountIds: ruleData.targetAccountIds ?? null,
    targetByAccount: ruleData.targetByAccount ?? null,
    conditions: ruleData.conditions,
    logicOperator: ruleData.logicOperator || 'AND',
    timezoneName,
    isSimulation: ruleData.isSimulation ?? false,
    actions: ruleData.actions,
    enabled: ruleData.enabled ?? true,
    executionIntervalMinutes: ruleData.executionIntervalMinutes ?? ruleData.execution_interval_minutes ?? 15,
    executionTimeWindows: ruleData.executionTimeWindows ?? ruleData.execution_time_windows ?? null,
    useDynamicScope: ruleData.useDynamicScope ?? true,
    scopeFilters: ruleData.scopeFilters ?? null,
    excludeIds: ruleData.excludeIds ?? null,
    maxDynamicMatches: ruleData.maxDynamicMatches ?? 1000
  })
  
  // 获取新插入的规则 ID
  const newRuleId = result[0].insertId
  
  // 查询并返回完整的规则数据
  const newRule = await db
    .select()
    .from(rules)
    .where(eq(rules.id, newRuleId))
    .limit(1)
  
  const rule = newRule[0]
  try {
    await insertRuleHistory({
      ruleId: newRuleId,
      changeType: 'CREATE',
      source: 'api_save',
      changedByUserId: userId,
      changedByOwnerId: ownerId ?? null,
      ruleSnapshot: buildRuleSnapshot(rule),
      snapshotBefore: null
    })
  } catch (e) {
    logger.warn('[rule_history] createRule insert history failed', { ruleId: newRuleId, err: e.message })
  }
  return rule
}

/**
 * 获取用户的所有规则（方案 B：联表一次查询，带出负责人信息并按 ownerIds 过滤）
 * @param {number} userId - 用户 ID
 * @param {object} options - 查询选项
 * @param {boolean} options.isAdmin - 是否为管理员（管理员可查看所有规则）
 * @param {number[]} [options.ownerIds] - 仅当 isAdmin 时有效；有值时只查这些负责人下的规则，空/未传表示不按负责人过滤
 * @param {boolean} [options.includeNoOwner] - 仅当 isAdmin 时有效；为 true 时包含管理员创建的规则（卡片负责人显示为“无”）
 * @param {number|null} [options.viewerOwnerId] - 非管理员必填：当前登录用户所属负责人 ID，列表按「同一负责人下所有用户创建的规则」过滤
 * @returns {Promise<Array>} 规则列表（每项为扁平对象，含 ownerId、ownerName，与旧结构兼容）
 */
export async function getUserRules(userId, options = {}) {
  const { isAdmin, ownerIds, includeNoOwner, onlyEnabled, orderBy, limit, offset, viewerOwnerId } = options
  const ruleOwnerExpr = sql`COALESCE(${rules.rulesOwnerId}, ${users.ownerId})`

  // 显式扁平化 select：规则表全部列 + 负责人 id/name，避免 Drizzle 默认返回嵌套 { rules, users, owners }
  const selectColumns = {
    ...getTableColumns(rules),
    ownerId: ruleOwnerExpr,
    ownerName: owners.ownerName
  }

  let query = db
    .select(selectColumns)
    .from(rules)
    .leftJoin(users, eq(rules.userId, users.id))
    .leftJoin(owners, sql`${owners.id} = ${ruleOwnerExpr}`)

  const filters = []
  if (!isAdmin) {
    // 模板半成品铺底方案：同一负责人下多名运营共享规则列表（按创建者 users.owner_id 对齐）
    if (viewerOwnerId == null || !Number.isFinite(Number(viewerOwnerId))) {
      return []
    }
    filters.push(eq(users.ownerId, Number(viewerOwnerId)))
  } else {
    // 管理员：支持三分支筛选 —— 真实负责人 / 管理员创建 / 两者并集
    const adminOwnerFilters = []
    if (ownerIds && ownerIds.length > 0) {
      adminOwnerFilters.push(inArray(ruleOwnerExpr, ownerIds))
    }
    if (includeNoOwner) {
      adminOwnerFilters.push(inArray(users.role, ['admin', 'super_admin']))
    }
    if (adminOwnerFilters.length === 1) {
      filters.push(adminOwnerFilters[0])
    } else if (adminOwnerFilters.length > 1) {
      filters.push(or(...adminOwnerFilters))
    }
    // 二者都不传 → 无过滤，展示全部规则
  }
  if (onlyEnabled) {
    filters.push(eq(rules.enabled, true))
  }
  if (filters.length > 0) {
    query = query.where(and(...filters))
  }

  if (orderBy === 'createdAt' || !orderBy) {
    query = query.orderBy(desc(rules.createdAt))
  }
  if (limit) {
    query = query.limit(limit)
    if (offset) {
      query = query.offset(offset)
    }
  }

  const userRules = await query
  return userRules
}

/**
 * 根据 ID 获取规则（带用户验证）
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} isAdmin - 是否为管理员（管理员可查看所有规则）
 * @param {number|null} [viewerOwnerId] - 非管理员：当前用户 owner_id；与列表一致，仅允许查看同负责人下创建者所属维度内的规则
 * @returns {Promise<object|null>} 规则对象或 null
 */
export async function getRuleById(ruleId, userId, isAdmin = false, viewerOwnerId = null) {
  if (isAdmin) {
    const result = await db
      .select()
      .from(rules)
      .where(eq(rules.id, ruleId))
      .limit(1)
    return result[0] || null
  }
  if (viewerOwnerId == null || !Number.isFinite(Number(viewerOwnerId))) {
    return null
  }
  const oid = Number(viewerOwnerId)
  const result = await db
    .select(getTableColumns(rules))
    .from(rules)
    .innerJoin(users, eq(rules.userId, users.id))
    .where(and(eq(rules.id, ruleId), eq(users.ownerId, oid)))
    .limit(1)
  return result[0] || null
}

/**
 * 更新规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {object} updates - 要更新的字段
 * @param {boolean} isAdmin - 是否为管理员（管理员可更新所有规则）
 * @param {number|null} [ownerId] - 负责人 ID（可选，用于 rule_history.changed_by_owner_id）
 * @param {number|null} [viewerOwnerId] - 非管理员：当前用户 owner_id，用于鉴权（与 getRuleById 一致）
 * @returns {Promise<object>} 更新结果
 */
export async function updateRule(ruleId, userId, updates, isAdmin = false, ownerId = null, viewerOwnerId = null) {
  // 鉴权在 getRuleById；此处仅按主键更新，避免与「同负责人共享规则」冲突
  const whereCondition = eq(rules.id, ruleId)

  const oldRule = await getRuleById(ruleId, userId, isAdmin, viewerOwnerId)
  if (!oldRule) {
    throw new Error('规则不存在或无权访问')
  }
  const snapshotBefore = buildRuleSnapshot(oldRule)

  if (Object.prototype.hasOwnProperty.call(updates, 'targetIds') && updates.targetIds !== undefined) {
    syncTargetByAccount(updates)
  }
  const result = await db
    .update(rules)
    .set({
      ...updates,
      updatedAt: new Date()  // 自动更新更新时间
    })
    .where(whereCondition)
  
  if (result[0].affectedRows === 0) {
    throw new Error('规则不存在或无权访问')
  }
  
  // 返回更新后的规则（管理员可以查看所有规则）
  const updatedRule = await getRuleById(ruleId, userId, isAdmin, viewerOwnerId)
  const changeType = (Object.keys(updates).length === 1 && Object.prototype.hasOwnProperty.call(updates, 'enabled'))
    ? 'TOGGLE'
    : 'UPDATE'
  const source = changeType === 'TOGGLE' ? 'api_toggle' : 'api_save'
  try {
    await insertRuleHistory({
      ruleId,
      changeType,
      source,
      changedByUserId: userId,
      changedByOwnerId: ownerId ?? null,
      ruleSnapshot: buildRuleSnapshot(updatedRule),
      snapshotBefore: changeType === 'UPDATE' || changeType === 'TOGGLE' ? snapshotBefore : null
    })
  } catch (e) {
    logger.warn('[rule_history] updateRule insert history failed', { ruleId, err: e.message })
  }
  return updatedRule
}

/**
 * 删除规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} isAdmin - 是否为管理员（管理员可删除所有规则）
 * @param {number|null} [viewerOwnerId] - 非管理员：当前用户 owner_id（按创建者负责人鉴权，与列表一致）
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteRule(ruleId, userId, isAdmin = false, viewerOwnerId = null) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    // 1) SELECT 规则快照（同一事务内，用于写入 rule_history）
    const selectSql = isAdmin
      ? 'SELECT r.* FROM rules r WHERE r.id = ? LIMIT 1'
      : `SELECT r.* FROM rules r
         INNER JOIN users u ON r.user_id = u.id
         WHERE r.id = ? AND u.owner_id = ? LIMIT 1`
    const selectParams = isAdmin ? [ruleId] : [ruleId, viewerOwnerId]
    const [selectResult] = await connection.execute(selectSql, selectParams)
    const row = selectResult?.[0]
    if (!row) {
      await connection.rollback()
      throw new Error('规则不存在或无权访问')
    }

    // 2) INSERT rule_history（DELETE 类型，快照仅配置字段）
    const snapshot = buildRuleSnapshot(row)
    await insertRuleHistory({
      ruleId,
      changeType: 'DELETE',
      source: 'api_save',
      changedByUserId: userId,
      changedByOwnerId: null,
      ruleSnapshot: snapshot,
      snapshotBefore: null,
      connection
    })

    // 3) DELETE rule_matched_objects
    await connection.execute(
      'DELETE FROM rule_matched_objects WHERE rule_id = ?',
      [ruleId]
    )

    // 4) DELETE rules
    const deleteRuleSql = isAdmin
      ? 'DELETE FROM rules WHERE id = ? LIMIT 1'
      : `DELETE r FROM rules r
         INNER JOIN users u ON r.user_id = u.id
         WHERE r.id = ? AND u.owner_id = ?`
    const deleteRuleParams = isAdmin ? [ruleId] : [ruleId, viewerOwnerId]
    const [ruleResult] = await connection.execute(deleteRuleSql, deleteRuleParams)
    if (!ruleResult || ruleResult.affectedRows === 0) {
      await connection.rollback()
      throw new Error('规则不存在或无权访问')
    }

    await connection.commit()
    return true
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch {}
    }
    throw error
  } finally {
    connection.release()
  }
}

/**
 * 启用/禁用规则
 * @param {number} ruleId - 规则 ID
 * @param {number} userId - 用户 ID（用于验证权限）
 * @param {boolean} enabled - 是否启用
 * @param {boolean} isAdmin - 是否为管理员（管理员可操作所有规则）
 * @param {number|null} [ownerId] - 负责人 ID（可选，用于 rule_history）
 * @param {number|null} [viewerOwnerId] - 非管理员：当前用户 owner_id
 * @returns {Promise<object>} 更新后的规则
 */
export async function toggleRule(ruleId, userId, enabled, isAdmin = false, ownerId = null, viewerOwnerId = null) {
  return await updateRule(ruleId, userId, { enabled }, isAdmin, ownerId, viewerOwnerId)
}


