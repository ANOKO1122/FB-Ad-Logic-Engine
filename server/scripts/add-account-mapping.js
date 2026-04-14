import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import pool from '../db/connection.js'

function normalizeAccountId(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return value.startsWith('act_') ? value : `act_${value}`
}

function normalizeBool(raw, defaultValue = true) {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return defaultValue
  if (['y', 'yes', '1', 'true'].includes(value)) return true
  if (['n', 'no', '0', 'false'].includes(value)) return false
  return defaultValue
}

async function askRequired(rl, label, transform = (v) => v.trim()) {
  while (true) {
    const answer = transform(await rl.question(label))
    if (answer) return answer
    console.log('⚠️  该项不能为空，请重新输入。')
  }
}

async function main() {
  const rl = readline.createInterface({ input, output })

  console.log('')
  console.log('='.repeat(60))
  console.log('📌 新增 / 更新 Facebook 广告账户映射脚本')
  console.log('作用：把广告账户写入 account_mappings，让系统像其它账户一样纳入使用')
  console.log('说明：脚本会先检查负责人、再检查账户是否已存在，最后让你确认后再写库')
  console.log('='.repeat(60))
  console.log('')

  try {
    // 先列出负责人，方便你直接填写 owner_id
    const [owners] = await pool.execute(
      'SELECT id, owner_name, owner_key, is_active FROM owners ORDER BY id'
    )

    console.log('当前负责人列表：')
    for (const owner of owners) {
      const statusText = Number(owner.is_active) === 1 ? 'active' : 'inactive'
      console.log(`- owner_id=${owner.id} | owner_name=${owner.owner_name} | owner_key=${owner.owner_key || '-'} | ${statusText}`)
    }
    console.log('')

    const fbAccountId = await askRequired(
      rl,
      '请输入广告账户 ID（可输 act_123 或纯数字 123）: ',
      normalizeAccountId
    )

    const ownerIdRaw = await askRequired(
      rl,
      '请输入负责人 owner_id（必填）: ',
      (value) => String(value || '').trim()
    )
    const ownerId = Number(ownerIdRaw)
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      throw new Error(`owner_id 非法: ${ownerIdRaw}`)
    }

    const accountNameRaw = await rl.question('请输入账户名称（可留空，后续也可在系统内补）: ')
    const timezoneRaw = await rl.question('请输入时区（默认 UTC，例如 Asia/Shanghai）: ')
    const activeRaw = await rl.question('是否启用该账户？(Y/n，默认 Y): ')

    const fbAccountName = String(accountNameRaw || '').trim() || null
    const timezoneName = String(timezoneRaw || '').trim() || 'UTC'
    const isActive = normalizeBool(activeRaw, true) ? 1 : 0

    const [ownerRows] = await pool.execute(
      'SELECT id, owner_name, owner_key, is_active FROM owners WHERE id = ? LIMIT 1',
      [ownerId]
    )
    if (!ownerRows.length) {
      throw new Error(`负责人不存在，owner_id=${ownerId}`)
    }
    if (Number(ownerRows[0].is_active) !== 1) {
      throw new Error(`负责人不是 active 状态，owner_id=${ownerId}`)
    }

    const [existingRows] = await pool.execute(
      `SELECT id, fb_account_id, fb_account_name, owner_id, is_active, timezone_name
       FROM account_mappings
       WHERE fb_account_id = ?
       LIMIT 1`,
      [fbAccountId]
    )

    console.log('')
    console.log('即将写入的信息：')
    console.log(`- fb_account_id: ${fbAccountId}`)
    console.log(`- fb_account_name: ${fbAccountName || '(空)'}`)
    console.log(`- owner_id: ${ownerId}`)
    console.log(`- owner_name: ${ownerRows[0].owner_name}`)
    console.log(`- timezone_name: ${timezoneName}`)
    console.log(`- is_active: ${isActive}`)
    console.log(`- 模式: ${existingRows.length > 0 ? 'UPDATE 已有账户' : 'INSERT 新账户'}`)
    console.log('')

    if (existingRows.length > 0) {
      const existing = existingRows[0]
      console.log('数据库现有记录：')
      console.log(`- id: ${existing.id}`)
      console.log(`- fb_account_id: ${existing.fb_account_id}`)
      console.log(`- fb_account_name: ${existing.fb_account_name || '(空)'}`)
      console.log(`- owner_id: ${existing.owner_id}`)
      console.log(`- timezone_name: ${existing.timezone_name || '(空)'}`)
      console.log(`- is_active: ${existing.is_active}`)
      console.log('')
    }

    // 二次确认，防止误把新账户写进错误负责人
    const confirm = String(await rl.question('确认写库请输入 YES，其他任意输入将取消: ')).trim()
    if (confirm !== 'YES') {
      console.log('⏹️  已取消，本次未写入数据库。')
      return
    }

    if (existingRows.length > 0) {
      await pool.execute(
        `UPDATE account_mappings
         SET fb_account_name = ?, owner_id = ?, is_active = ?, timezone_name = ?, updated_at = NOW()
         WHERE fb_account_id = ?`,
        [fbAccountName, ownerId, isActive, timezoneName, fbAccountId]
      )
    } else {
      await pool.execute(
        `INSERT INTO account_mappings (fb_account_id, fb_account_name, owner_id, is_active, timezone_name)
         VALUES (?, ?, ?, ?, ?)`,
        [fbAccountId, fbAccountName, ownerId, isActive, timezoneName]
      )
    }

    const [savedRows] = await pool.execute(
      `SELECT id, fb_account_id, fb_account_name, owner_id, is_active, timezone_name, created_at, updated_at
       FROM account_mappings
       WHERE fb_account_id = ?
       LIMIT 1`,
      [fbAccountId]
    )

    console.log('')
    console.log('✅ 写库成功，当前记录如下：')
    console.table(savedRows)
    console.log('')
    console.log('后续建议：')
    console.log('1. 去管理页检查该账户是否已显示。')
    console.log('2. 如时区暂时填了 UTC，可后续再运行时区同步脚本修正。')
    console.log('3. 如需让 staff 用户可见，请确认该用户绑定的 owner_id 与这里一致。')
  } catch (error) {
    console.error('')
    console.error('❌ 脚本执行失败：', error.message)
    console.error('请先看提示信息，确认 account_id / owner_id / 时区是否填写正确。')
    process.exitCode = 1
  } finally {
    rl.close()
    await pool.end()
  }
}

await main()
