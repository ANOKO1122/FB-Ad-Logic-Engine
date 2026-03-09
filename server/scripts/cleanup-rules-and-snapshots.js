/**
 * 一键清理「规则管理」页面中的所有规则及其动态筛选快照。
 *
 * 注意：
 * - 只操作 rules 表和 rule_matched_objects 表，不会动模板表 rule_templates。
 * - 强烈建议先用 --dry-run 看清楚数量，再用 --confirm 真正删除。
 *
 * 用法：
 *   node server/scripts/cleanup-rules-and-snapshots.js --dry-run
 *   node server/scripts/cleanup-rules-and-snapshots.js --confirm
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
    console.log('  node server/scripts/cleanup-rules-and-snapshots.js --dry-run   # 只看数量，不删除')
    console.log('  node server/scripts/cleanup-rules-and-snapshots.js --confirm   # 真正删除（不可恢复）')
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

    // 统计当前数量
    const [[rulesCountRow]] = await connection.execute('SELECT COUNT(*) AS cnt FROM rules')
    const [[snapCountRow]] = await connection.execute('SELECT COUNT(*) AS cnt FROM rule_matched_objects')

    const rulesCount = Number(rulesCountRow?.cnt || 0)
    const snapCount = Number(snapCountRow?.cnt || 0)

    console.log('当前数据量：')
    console.log(`  rules 表：${rulesCount} 条（规则管理页面中的规则）`)
    console.log(`  rule_matched_objects 表：${snapCount} 条（动态筛选快照）`)
    console.log('')

    if (isDryRun) {
      console.log('dry-run 模式：仅展示数量，不做任何修改。')
      return
    }

    if (!rulesCount && !snapCount) {
      console.log('rules 与 rule_matched_objects 表本身就是空的，无需删除。')
      return
    }

    console.log('⚠️ 警告：即将删除所有规则及其动态筛选快照，这个操作不可恢复。')
    console.log('如果只是测试环境，可以继续；线上环境请务必确认已备份。')

    await connection.beginTransaction()

    // 先删快照，再删规则
    const [snapResult] = await connection.execute('DELETE FROM rule_matched_objects')
    const [rulesResult] = await connection.execute('DELETE FROM rules')

    await connection.commit()

    const deletedSnaps = Number(snapResult.affectedRows || 0)
    const deletedRules = Number(rulesResult.affectedRows || 0)

    console.log('')
    console.log('✅ 删除完成：')
    console.log(`  已删除规则：${deletedRules} 条（rules）`)
    console.log(`  已删除动态快照：${deletedSnaps} 条（rule_matched_objects）`)
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

