/**
 * 只清理「模拟执行」的日志 + 「开启模拟运行」的规则（及其动态快照）。
 *
 * 注意：
 * - 只删 automation_logs 中 is_simulation = 1 的记录；
 * - 只删 rules 中 is_simulation = 1 的规则，并先删其 rule_matched_objects。
 * - 建议先用 --dry-run 看清楚数量，再用 --confirm 真正删除。
 *
 * 用法：
 *   node server/scripts/cleanup-simulation-only.js --dry-run
 *   node server/scripts/cleanup-simulation-only.js --confirm
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

async function main() {
  const args = process.argv.slice(2)
  const isDryRun = args.includes('--dry-run')
  const isConfirm = args.includes('--confirm')

  if (!isDryRun && !isConfirm) {
    console.log('用法：')
    console.log('  node server/scripts/cleanup-simulation-only.js --dry-run   # 只看数量，不删除')
    console.log('  node server/scripts/cleanup-simulation-only.js --confirm   # 真正删除（不可恢复）')
    process.exit(1)
  }

  let connection = null
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'fb_ad_brain'
    })

    // 统计将要删除的数量（仅模拟）
    const [[logCntRow]] = await connection.execute(
      'SELECT COUNT(*) AS cnt FROM automation_logs WHERE is_simulation = 1'
    )
    const [[ruleCntRow]] = await connection.execute(
      'SELECT COUNT(*) AS cnt FROM rules WHERE is_simulation = 1'
    )
    const [[snapCntRow]] = await connection.execute(
      `SELECT COUNT(*) AS cnt FROM rule_matched_objects rmo
       INNER JOIN rules r ON rmo.rule_id = r.id
       WHERE r.is_simulation = 1`
    )

    const logCnt = Number(logCntRow?.cnt || 0)
    const ruleCnt = Number(ruleCntRow?.cnt || 0)
    const snapCnt = Number(snapCntRow?.cnt || 0)

    console.log('当前「仅模拟」数据量：')
    console.log(`  模拟执行日志（automation_logs.is_simulation = 1）：${logCnt} 条`)
    console.log(`  模拟规则（rules.is_simulation = 1）：${ruleCnt} 条`)
    console.log(`  上述规则的动态快照（rule_matched_objects）：${snapCnt} 条`)
    console.log('')

    if (isDryRun) {
      console.log('dry-run 模式：仅展示数量，不做任何修改。')
      return
    }

    if (logCnt === 0 && ruleCnt === 0) {
      console.log('没有模拟日志和模拟规则，无需删除。')
      return
    }

    console.log('⚠️ 警告：即将删除上述模拟日志、模拟规则及其快照，不可恢复。')
    console.log('确认无误后再执行；线上环境请务必确认已备份。')

    await connection.beginTransaction()

    const [logRes] = await connection.execute(
      'DELETE FROM automation_logs WHERE is_simulation = 1'
    )
    await connection.execute(
      `DELETE rmo FROM rule_matched_objects rmo
       INNER JOIN rules r ON rmo.rule_id = r.id
       WHERE r.is_simulation = 1`
    )
    const [ruleRes] = await connection.execute(
      'DELETE FROM rules WHERE is_simulation = 1'
    )

    await connection.commit()

    const deletedLogs = Number(logRes?.affectedRows || 0)
    const deletedRules = Number(ruleRes?.affectedRows || 0)

    console.log('')
    console.log('✅ 删除完成：')
    console.log(`  已删除模拟执行日志：${deletedLogs} 条`)
    console.log(`  已删除模拟规则：${deletedRules} 条（其动态快照已一并删除）`)
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {}
    }
    console.error('❌ 执行失败：', err.message)
    process.exit(1)
  } finally {
    if (connection) {
      try {
        await connection.end()
      } catch {}
    }
  }
}

main()
