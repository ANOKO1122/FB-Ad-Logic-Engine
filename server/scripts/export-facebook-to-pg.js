/**
 * 独立任务：将 MySQL daily_stats（指定自然日）同步到 PostgreSQL facebook_ads_daily_export
 *
 * 设计要点（对照方案文档）：
 * - 只读 MySQL，不写核心引擎表；PG 用 INSERT ... ON CONFLICT 做幂等 UPSERT
 * - 条件：stat_date = 指定日 且 spend > 0；分页读取，每批再写 PG，避免一次性载入全表
 * - ad_name：优先 daily_stats.ad_name，空则 structure_ads.name
 * - campaign_name：structure_campaigns.name（按 account_id + campaign_id）
 * - 整次任务失败时自动重试 1 次（共最多 2 次尝试）
 *
 * 用法示例：
 *   node server/scripts/export-facebook-to-pg.js --mode=yesterday
 *   node server/scripts/export-facebook-to-pg.js --date=2026-04-10
 *   node server/scripts/export-facebook-to-pg.js --backfill-days=7
 *
 * 环境变量（PostgreSQL，勿提交到仓库）：
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD（与 libpq 惯例一致）
 *   也支持别名：PG_HOST、PG_PORT、PG_DATABASE、PG_USER、PG_PASSWORD
 * 可选：在项目根目录放置 .env.pg（仅服务器本地），脚本会尝试加载（不覆盖已有 export 变量）
 *
 * MySQL：沿用项目根目录 .env 中 DB_*（由 ../db/connection.js 读取）
 *
 * 【日期口径】stat_date 必须与 daily_stats.date 的日历日完全一致。
 * mysql2 可能把 DATE 列编成 JS Date（UTC 午夜）；若用本地时区格式化成 yyyy-MM-dd 会偏一天。
 * 处理：查询侧用 DATE_FORMAT 得到字符串；写入侧对 Date 一律按 UTC 取日历日。
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { DateTime } from 'luxon'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '../..')

// 必须先加载 .env，再动态 import connection.js；否则连接池会在无 DB_* 时初始化
dotenv.config({ path: path.join(projectRoot, '.env') })
dotenv.config({ path: path.join(projectRoot, '.env.pg') })

const { Pool: PgPool } = pg

/** 默认每批从 MySQL 拉取行数（方案建议 500～1000） */
const DEFAULT_BATCH = 800

/** 短暂停顿：重试前等待毫秒数 */
const RETRY_DELAY_MS = 3000

/**
 * 将 MySQL 读出的「业务日」统一为 yyyy-MM-dd，与 daily_stats.date 一致（不做 UTC+8 换算，只做正确解码）。
 * @param {Date|string|null|undefined} v
 * @returns {string}
 */
function statDateToYmd(v) {
  if (v == null || v === '') {
    throw new Error('stat_date 为空，无法写入 PG')
  }
  if (typeof v === 'string') {
    const s = v.trim().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    return String(v).slice(0, 10)
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new Error('stat_date 为无效 Date')
    }
    return DateTime.fromJSDate(v, { zone: 'utc' }).toFormat('yyyy-MM-dd')
  }
  return String(v).slice(0, 10)
}

/**
 * @typedef {Object} MysqlExportRow
 * @property {number} id
 * @property {string} account_id
 * @property {string} ad_id
 * @property {string | null} ad_name_resolved
 * @property {string | null} campaign_name
 * @property {string | number} spend
 * @property {Date | string} stat_date
 */

/**
 * @param {string[]} argv
 * @returns {{ mode?: string, date?: string, backfillDays?: number, batchSize: number }}
 */
function parseArgs(argv) {
  let mode
  let date
  let backfillDays
  let batchSize = DEFAULT_BATCH

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--date=')) date = arg.slice('--date='.length)
    else if (arg.startsWith('--backfill-days=')) {
      backfillDays = parseInt(arg.slice('--backfill-days='.length), 10)
      if (Number.isNaN(backfillDays) || backfillDays < 1) {
        throw new Error(`无效参数 --backfill-days，需要正整数，收到: ${arg}`)
      }
    } else if (arg.startsWith('--batch-size=')) {
      const n = parseInt(arg.slice('--batch-size='.length), 10)
      if (Number.isNaN(n) || n < 50 || n > 2000) {
        throw new Error(`无效 --batch-size（建议 50～2000），收到: ${arg}`)
      }
      batchSize = n
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { mode, date, backfillDays, batchSize }
}

function printHelp() {
  console.log(`
用法:
  node server/scripts/export-facebook-to-pg.js --mode=yesterday
  node server/scripts/export-facebook-to-pg.js --date=YYYY-MM-DD
  node server/scripts/export-facebook-to-pg.js --backfill-days=7

可选:
  --batch-size=800   每批从 MySQL 读取行数（默认 ${DEFAULT_BATCH}）

说明:
  --mode=yesterday   同步「本地日历的昨天」对应 daily_stats.date（请保证 ECS 时区与业务一致）
  --backfill-days=N  从「昨天」起向前共 N 个自然日，逐日同步（含昨天）
`)
}

/**
 * 取「昨天」的日历日期字符串 yyyy-MM-dd（依赖运行环境的本地时区）
 * @returns {string}
 */
function yesterdayYmd() {
  return DateTime.now().minus({ days: 1 }).toFormat('yyyy-MM-dd')
}

/**
 * 从某天往前推 (days-1) 天，共 days 个日期（用于近 N 天回补）
 * @param {string} endYmd
 * @param {number} days
 * @returns {string[]}
 */
function dateRangeEnding(endYmd, days) {
  const end = DateTime.fromISO(endYmd, { zone: 'local' })
  const out = []
  for (let i = 0; i < days; i++) {
    out.push(end.minus({ days: i }).toFormat('yyyy-MM-dd'))
  }
  return out.reverse()
}

/**
 * @returns {import('pg').Pool}
 */
function createPgPool() {
  const host = process.env.PGHOST || process.env.PG_HOST
  const port = parseInt(process.env.PGPORT || process.env.PG_PORT || '5432', 10)
  const database = process.env.PGDATABASE || process.env.PG_DATABASE
  const user = process.env.PGUSER || process.env.PG_USER
  const password = process.env.PGPASSWORD || process.env.PG_PASSWORD

  if (!host || !database || !user || password === undefined) {
    throw new Error(
      'PostgreSQL 连接参数不完整。请设置 PGHOST、PGDATABASE、PGUSER、PGPASSWORD（可选 PGPORT），或同名 PG_* 别名'
    )
  }

  return new PgPool({
    host,
    port,
    database,
    user,
    password,
    max: 5,
    idleTimeoutMillis: 30_000
  })
}

/**
 * 将一批行写入 PG（单条 SQL 多行 VALUES + ON CONFLICT）
 * @param {import('pg').Pool} pgPool
 * @param {MysqlExportRow[]} rows
 */
async function upsertBatch(pgPool, rows) {
  if (rows.length === 0) return

  const placeholders = []
  const values = []
  let i = 1
  for (const r of rows) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`)
    const spendNum =
      typeof r.spend === 'string' ? parseFloat(r.spend) : Number(r.spend)
    const statStr = statDateToYmd(r.stat_date)

    values.push(
      r.account_id,
      r.ad_id,
      r.ad_name_resolved,
      r.campaign_name,
      spendNum,
      statStr
    )
  }

  const sql = `
    INSERT INTO facebook_ads_daily_export (account_id, ad_id, ad_name, campaign_name, spend, stat_date)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (account_id, ad_id, stat_date) DO UPDATE SET
      ad_name = EXCLUDED.ad_name,
      campaign_name = EXCLUDED.campaign_name,
      spend = EXCLUDED.spend,
      updated_at = NOW()
  `
  await pgPool.query(sql, values)
}

/**
 * 同步单个 stat_date（MySQL 按 id 游标分页）
 * @param {import('mysql2/promise').Pool} mysqlPool
 * @param {import('pg').Pool} pgPool
 * @param {string} statDateYmd
 * @param {number} batchSize
 */
async function syncOneStatDate(mysqlPool, pgPool, statDateYmd, batchSize) {
  let lastId = 0
  let totalRead = 0

  const selectSql = `
    SELECT
      d.id,
      d.account_id,
      d.ad_id,
      NULLIF(TRIM(COALESCE(d.ad_name, sa.name)), '') AS ad_name_resolved,
      sc.name AS campaign_name,
      d.spend,
      DATE_FORMAT(d.date, '%Y-%m-%d') AS stat_date
    FROM daily_stats d
    LEFT JOIN structure_campaigns sc
      ON sc.account_id = d.account_id AND sc.campaign_id = d.campaign_id
    LEFT JOIN structure_ads sa
      ON sa.account_id = d.account_id AND sa.ad_id = d.ad_id
    WHERE d.date = ?
      AND d.spend > 0
      AND d.id > ?
    ORDER BY d.id ASC
    LIMIT ${batchSize}
  `

  for (;;) {
    const [rows] = await mysqlPool.query(selectSql, [statDateYmd, lastId])
    /** @type {MysqlExportRow[]} */
    const list = rows
    if (!list.length) break

    await upsertBatch(pgPool, list)
    totalRead += list.length
    lastId = list[list.length - 1].id

    if (list.length < batchSize) break
  }

  return totalRead
}

/**
 * @param {import('mysql2/promise').Pool} mysqlPool
 * @param {import('pg').Pool} pgPool
 * @param {string[]} statDates
 * @param {number} batchSize
 */
async function runSync(mysqlPool, pgPool, statDates, batchSize) {
  const summary = { dates: statDates, perDate: {}, totalRows: 0 }

  for (const d of statDates) {
    const n = await syncOneStatDate(mysqlPool, pgPool, d, batchSize)
    summary.perDate[d] = n
    summary.totalRows += n
    console.log(`[export-pg] stat_date=${d} 读取并写入行数（估算）=${n}`)
  }

  return summary
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const argv = parseArgs(process.argv.slice(2))
  let mysqlPool = null
  let pgPool = null

  let statDates = []

  if (argv.backfillDays != null) {
    const end = yesterdayYmd()
    statDates = dateRangeEnding(end, argv.backfillDays)
  } else if (argv.date) {
    statDates = [argv.date]
  } else if (argv.mode === 'yesterday' || argv.mode === undefined) {
    statDates = [yesterdayYmd()]
  } else {
    throw new Error('请指定 --mode=yesterday、--date=YYYY-MM-DD 或 --backfill-days=N')
  }

  console.log(`[export-pg] 将同步 stat_date 列表: ${statDates.join(', ')}`)

  const mysqlModule = await import('../db/connection.js')
  mysqlPool = mysqlModule.default
  pgPool = createPgPool()

  try {
    const summary = await runSync(mysqlPool, pgPool, statDates, argv.batchSize)
    console.log('[export-pg] 完成', JSON.stringify(summary, null, 2))
  } finally {
    const closeTasks = []
    if (mysqlPool?.end) {
      closeTasks.push(mysqlPool.end())
    }
    if (pgPool?.end) {
      closeTasks.push(pgPool.end())
    }
    if (closeTasks.length > 0) {
      await Promise.allSettled(closeTasks)
    }
  }
}

async function mainWithRetry() {
  try {
    await main()
  } catch (e) {
    console.error('[export-pg] 第一次执行失败:', e && e.message ? e.message : e)
    console.error(`[export-pg] ${RETRY_DELAY_MS}ms 后重试一次…`)
    await sleep(RETRY_DELAY_MS)
    await main()
  }
}

mainWithRetry().catch((err) => {
  console.error('[export-pg] 重试后仍失败:', err)
  process.exit(1)
})
