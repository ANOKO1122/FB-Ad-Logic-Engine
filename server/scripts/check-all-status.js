/**
 * 系统状态一键检查脚本
 *
 * 检查内容：
 *  1. 后端 API 服务是否运行、Token 是否配置
 *  2. MySQL 数据库是否可连接
 *  3. 统一心跳锁是否正常（无残留锁）
 *
 * 使用方法（在项目根目录执行）：
 *  node server/scripts/check-all-status.js
 *
 * 说明：完整系统状态（Cron、各账户同步、熔断、失败队列）需登录后访问
 *  GET /api/system/health 或前端「系统状态」页面。
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

const PORT = parseInt(process.env.PORT || '3001', 10)
const BASE_URL = `http://127.0.0.1:${PORT}`
const HEARTBEAT_LOCK_NAME = 'fb_ad_brain:unified_heartbeat'

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'fb_ad_brain'
}

// ---------- 检查项清单（供对照） ----------
function printChecklist() {
  console.log('')
  console.log('========== 系统状态检查项 ==========')
  console.log('  1. 后端 API 服务   - 进程是否在跑、端口是否可访问')
  console.log('  2. Facebook Token  - 是否已配置（由 /api/health 返回）')
  console.log('  3. MySQL 数据库    - 能否连接、库是否存在')
  console.log('  4. 统一心跳锁      - 是否有残留锁导致任务无法执行')
  console.log('--------------------------------------')
  console.log('  以下为需登录后查看的项（本脚本不执行）：')
  console.log('  5. Cron 定时任务   - 是否在跑、上次执行时间')
  console.log('  6. 各账户同步状态 - 最近一次同步是否及时')
  console.log('  7. 熔断器状态     - Token 是否被限流锁定')
  console.log('  8. 失败任务队列   - 最近 1 小时失败数量')
  console.log('  查看方式：浏览器登录 → 系统状态页，或 curl -b "cookie" /api/system/health')
  console.log('======================================')
  console.log('')
}

async function checkApiHealth() {
  const section = '1. 后端 API 服务 + Token'
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    const ok = res.ok && data && data.status === 'ok'
    console.log(`[${section}] ${ok ? '✅ 通过' : '❌ 未通过'}`)
    console.log(`    - 状态: ${data?.status ?? res.status}`)
    console.log(`    - 消息: ${data?.message ?? '-'}`)
    console.log(`    - Token 已配置: ${data?.token_configured ? '是' : '否'}`)
    if (data?.token_length != null) console.log(`    - Token 长度: ${data.token_length}`)
    return ok
  } catch (err) {
    const msg = err?.message ?? String(err)
    console.log(`[${section}] ❌ 失败`)
    console.log(`    - 错误: ${msg}`)
    console.log(`    - 提示: 请确认后端已启动（如 npm run dev:server），且端口为 ${PORT}`)
    return false
  }
}

async function checkDatabase() {
  const section = '2. MySQL 数据库'
  let connection = null
  try {
    connection = await mysql.createConnection(dbConfig)
    await connection.query('SELECT 1 AS ok')
    console.log(`[${section}] ✅ 通过`)
    console.log(`    - 主机: ${dbConfig.host}:${dbConfig.port}`)
    console.log(`    - 数据库: ${dbConfig.database}`)
    return true
  } catch (err) {
    const msg = err?.message ?? String(err)
    console.log(`[${section}] ❌ 失败`)
    console.log(`    - 错误: ${msg}`)
    return false
  } finally {
    if (connection) await connection.end()
  }
}

async function checkLock() {
  const section = '3. 统一心跳锁'
  let connection = null
  try {
    connection = await mysql.createConnection(dbConfig)
    const [freeRows] = await connection.query(`SELECT IS_FREE_LOCK(?) AS is_free`, [HEARTBEAT_LOCK_NAME])
    const [usedRows] = await connection.query(`SELECT IS_USED_LOCK(?) AS is_used`, [HEARTBEAT_LOCK_NAME])
    const [acquireRows] = await connection.query(`SELECT GET_LOCK(?, 0) AS acquired`, [HEARTBEAT_LOCK_NAME])

    const isFree = freeRows[0]?.is_free === 1
    const isUsed = usedRows[0]?.is_used === 1
    const acquired = acquireRows[0]?.acquired === 1

    const ok = isFree && !isUsed
    console.log(`[${section}] ${ok ? '✅ 通过' : '⚠️ 异常'}`)
    console.log(`    - 锁名称: ${HEARTBEAT_LOCK_NAME}`)
    console.log(`    - 是否空闲: ${isFree ? '是' : '否'}`)
    console.log(`    - 是否被占用: ${isUsed ? '是' : '否'}`)
    console.log(`    - 能否获取: ${acquired ? '能' : '不能'}`)

    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [HEARTBEAT_LOCK_NAME])

    if (!ok && isUsed && !acquired) {
      console.log('    - 建议: 执行 node server/scripts/force-release-heartbeat-lock.js 释放残留锁')
    }
    return ok
  } catch (err) {
    const msg = err?.message ?? String(err)
    console.log(`[${section}] ❌ 失败`)
    console.log(`    - 错误: ${msg}`)
    return false
  } finally {
    if (connection) await connection.end()
  }
}

async function main() {
  printChecklist()

  const r1 = await checkApiHealth()
  console.log('')
  const r2 = await checkDatabase()
  console.log('')
  const r3 = await checkLock()
  console.log('')

  const allOk = r1 && r2 && r3
  console.log(allOk ? '✅ 全部检查通过' : '⚠️ 存在未通过项，请根据上方提示处理')
  process.exit(allOk ? 0 : 1)
}

main().catch(err => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})
