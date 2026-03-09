/**
 * 一键清理「执行日志」页面的所有记录。
 *
 * 注意：
 * - 只操作 automation_logs 表，不会动规则、模板等其它表。
 * - 建议先用 --dry-run 看清楚数量，再用 --confirm 真正删除。
 *
 * 用法：
 *   node server/scripts/cleanup-automation-logs.js --dry-run
 *   node server/scripts/cleanup-automation-logs.js --confirm
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
    console.log('  node server/scripts/cleanup-automation-logs.js --dry-run   # 只看数量，不删除')
    console.log('  node server/scripts/cleanup-automation-logs.js --confirm   # 真正删除（不可恢复）')
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

    // 统计当前日志数量
    const [[logsCountRow]] = await connection.execute('SELECT COUNT(*) AS cnt FROM automation_logs')
    const logsCount = Number(logsCountRow?.cnt || 0)

    console.log('当前数据量：')
    console.log(`  automation_logs 表：${logsCount} 条（执行日志页面中的记录）`)
    console.log('')

    if (isDryRun) {
      console.log('dry-run 模式：仅展示数量，不做任何修改。')
      return
    }

    if (!logsCount) {
      console.log('automation_logs 表本身就是空的，无需删除。')
      return
    }

    console.log('⚠️ 警告：即将删除所有执行日志，这个操作不可恢复。')
    console.log('如果只是测试环境，可以继续；线上环境请务必确认已备份。')

    const [deleteResult] = await connection.execute('DELETE FROM automation_logs')
    const deleted = Number(deleteResult.affectedRows || 0)

    console.log('')
    console.log('✅ 删除完成：')
    console.log(`  已删除执行日志：${deleted} 条（automation_logs）`)
  } catch (err) {
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

