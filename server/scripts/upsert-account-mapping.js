/**
 * 交互式脚本：新增/更新 FB 广告账户映射（account_mappings）
 *
 * 运行后会一步步提示输入：
 * 1) 广告账户 ID
 * 2) owner_id
 * 3) 账户名称
 * 4) 时区
 * 5) 是否启用
 * 6) 最终确认（输入 YES 才真正写库）
 *
 * 行为约定：
 * - 先读取 owners 表并打印负责人列表
 * - 校验 owner_id 是否存在且启用
 * - 若 owner_id 不存在，可选择立即新增负责人（自动生成 owner_key）
 * - 检查 fb_account_id 是否存在：不存在 INSERT，存在 UPDATE
 * - 最后打印写入后的 account_mappings 记录
 */

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import pool from '../db/connection.js'

function ensureNonEmpty(v, fieldName) {
  const s = String(v ?? '').trim()
  if (!s) throw new Error(`字段不能为空：${fieldName}`)
  return s
}

function toTimezoneName(v) {
  const tz = String(v ?? '').trim()
  return tz || 'UTC'
}

function toIsActive(v) {
  const raw = String(v ?? '').trim().toLowerCase()
  if (['1', 'y', 'yes', 'true', 'on', '启用'].includes(raw)) return 1
  if (['0', 'n', 'no', 'false', 'off', '禁用'].includes(raw)) return 0
  throw new Error('是否启用仅支持：1/0、y/n、yes/no、true/false')
}

function normalizeOwnerKey(raw) {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return key || `owner_${Date.now()}`
}

async function listOwners() {
  const [rows] = await pool.execute(
    `SELECT id, owner_key, owner_name, is_active
     FROM owners
     ORDER BY id`
  )
  return rows || []
}

async function getOwnerById(ownerId) {
  const [rows] = await pool.execute(
    `SELECT id, owner_key, owner_name, is_active
     FROM owners
     WHERE id = ?
     LIMIT 1`,
    [ownerId]
  )
  return rows && rows.length > 0 ? rows[0] : null
}

async function createOwner(ownerName, ownerKeyRaw) {
  const ownerKey = normalizeOwnerKey(ownerKeyRaw || ownerName)
  const finalOwnerName = ensureNonEmpty(ownerName, '新负责人名称')
  await pool.execute(
    `INSERT INTO owners (owner_key, owner_name, is_active)
     VALUES (?, ?, 1)`,
    [ownerKey, finalOwnerName]
  )
  const [rows] = await pool.execute(
    `SELECT id, owner_key, owner_name, is_active
     FROM owners
     WHERE owner_key = ?
     ORDER BY id DESC
     LIMIT 1`,
    [ownerKey]
  )
  if (!rows || rows.length === 0) {
    throw new Error('创建负责人后读取失败')
  }
  return rows[0]
}

async function getMappingByAccountId(fbAccountId) {
  const [rows] = await pool.execute(
    `SELECT id, fb_account_id, fb_account_name, owner_id, is_active, timezone_name
     FROM account_mappings
     WHERE fb_account_id = ?
     LIMIT 1`,
    [fbAccountId]
  )
  return rows && rows.length > 0 ? rows[0] : null
}

async function printOwnerList() {
  const owners = await listOwners()
  console.log('\n当前负责人列表（owners）：')
  console.log('说明：这里只用于选择 owner_id，后面的“是否启用”是广告账户 is_active，不是负责人开关。')
  console.log('--------------------------------------------------------------------------------')
  console.log(
    `${'owner_id'.padEnd(10)}${'owner_active'.padEnd(14)}${'owner_key'.padEnd(20)}owner_name`
  )
  console.log('--------------------------------------------------------------------------------')
  for (const o of owners) {
    const ownerId = String(o.id ?? '').padEnd(10)
    const ownerActive = String(o.is_active ?? '').padEnd(14)
    const ownerKey = String(o.owner_key ?? '').padEnd(20)
    const ownerName = String(o.owner_name ?? '')
    console.log(`${ownerId}${ownerActive}${ownerKey}${ownerName}`)
  }
  console.log('--------------------------------------------------------------------------------')
}

async function resolveOwnerByPrompt(rl) {
  const ownerIdRaw = ensureNonEmpty(await rl.question('\n请输入 owner_id：'), 'owner_id')
  const ownerId = Number(ownerIdRaw)
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error(`owner_id 非法：${ownerIdRaw}`)
  }

  let owner = await getOwnerById(ownerId)
  if (owner) {
    if (owner.is_active !== 1) {
      throw new Error(`负责人存在但未启用（仅负责人校验）：owner_id=${owner.id}, owner_name=${owner.owner_name}`)
    }
    return owner
  }

  console.log(`\n⚠️ owner_id=${ownerId} 不存在。`)
  const createAnswer = String(await rl.question('是否新增负责人并继续？输入 yes 继续，其他取消：')).trim().toLowerCase()
  if (createAnswer !== 'yes') {
    throw new Error('负责人不存在，且你取消了新增')
  }

  const ownerName = ensureNonEmpty(await rl.question('请输入新负责人名称（owner_name）：'), 'owner_name')
  const ownerKeyInput = String(await rl.question('请输入新负责人 key（owner_key，可回车自动生成）：')).trim()
  owner = await createOwner(ownerName, ownerKeyInput)
  console.log(`✅ 已新增负责人：id=${owner.id}, key=${owner.owner_key}, name=${owner.owner_name}`)
  return owner
}

async function upsertMapping(payload) {
  const before = await getMappingByAccountId(payload.fb_account_id)
  if (!before) {
    await pool.execute(
      `INSERT INTO account_mappings (fb_account_id, fb_account_name, owner_id, is_active, timezone_name)
       VALUES (?, ?, ?, ?, ?)`,
      [
        payload.fb_account_id,
        payload.fb_account_name,
        payload.owner_id,
        payload.is_active,
        payload.timezone_name
      ]
    )
    return { action: 'INSERT' }
  }

  await pool.execute(
    `UPDATE account_mappings
     SET fb_account_name = ?, owner_id = ?, is_active = ?, timezone_name = ?
     WHERE fb_account_id = ?`,
    [
      payload.fb_account_name,
      payload.owner_id,
      payload.is_active,
      payload.timezone_name,
      payload.fb_account_id
    ]
  )
  return { action: 'UPDATE' }
}

async function printFinalRecord(fbAccountId) {
  const [rows] = await pool.execute(
    `SELECT am.id, am.fb_account_id, am.fb_account_name, am.owner_id, am.is_active, am.timezone_name,
            o.owner_name, o.owner_key
     FROM account_mappings am
     LEFT JOIN owners o ON am.owner_id = o.id
     WHERE am.fb_account_id = ?
     LIMIT 1`,
    [fbAccountId]
  )
  if (!rows || rows.length === 0) {
    throw new Error('写入后未查询到记录')
  }
  const r = rows[0]
  console.log('\n写入后的记录：')
  console.log(JSON.stringify(r, null, 2))
}

async function main() {
  const rl = readline.createInterface({ input, output })
  try {
    console.log('\n============================================================')
    console.log('FB 广告账户写库向导（account_mappings）')
    console.log('============================================================')

    await printOwnerList()

    // 按你要求的顺序：广告账户 ID -> owner_id -> 账户名称 -> 时区 -> 是否启用
    const fbAccountId = ensureNonEmpty(await rl.question('\n请输入广告账户 ID（fb_account_id）：'), 'fb_account_id')
    const owner = await resolveOwnerByPrompt(rl)
    const fbAccountName = ensureNonEmpty(await rl.question('请输入账户名称（fb_account_name）：'), 'fb_account_name')
    const timezoneName = toTimezoneName(await rl.question('请输入时区（timezone_name，回车默认 UTC）：'))
    const isActive = toIsActive(
      await rl.question('请输入广告账户是否启用（1=启用，0=禁用，也可 yes/no）：')
    )

    const payload = {
      fb_account_id: fbAccountId,
      fb_account_name: fbAccountName,
      owner_id: owner.id,
      timezone_name: timezoneName,
      is_active: isActive
    }

    const existed = await getMappingByAccountId(fbAccountId)
    console.log('\n待写入摘要：')
    console.log(`- 动作：${existed ? 'UPDATE（账户已存在）' : 'INSERT（账户不存在）'}`)
    console.log(`- fb_account_id：${payload.fb_account_id}`)
    console.log(`- fb_account_name：${payload.fb_account_name}`)
    console.log(`- owner_id：${payload.owner_id}（${owner.owner_name} / ${owner.owner_key}）`)
    console.log(`- timezone_name：${payload.timezone_name}`)
    console.log(`- 广告账户 is_active：${payload.is_active}`)

    const confirm = String(await rl.question('\n输入 YES 才会真正写库：')).trim()
    if (confirm !== 'YES') {
      console.log('已取消，未写入数据库。')
      process.exit(0)
    }

    const result = await upsertMapping(payload)
    console.log(`\n✅ 写库成功：${result.action}`)
    await printFinalRecord(fbAccountId)

    console.log('\n说明：这条记录已进入 account_mappings，后续可被系统同步/规则/权限链路使用。')
    process.exit(0)
  } catch (e) {
    console.error('\n❌ 执行失败：', e.message)
    process.exit(1)
  } finally {
    rl.close()
  }
}

await main()

