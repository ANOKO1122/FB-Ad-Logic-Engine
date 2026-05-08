import fs from 'node:fs/promises'
import path from 'node:path'
import pool from '../../server/db/connection.js'

function fail(message) {
  console.error(`[perf:explain] ${message}`)
  process.exitCode = 1
}

async function loadAnyAccountId() {
  const [rows] = await pool.execute(
    'SELECT fb_account_id FROM account_mappings WHERE is_active = 1 ORDER BY id ASC LIMIT 1'
  )
  return rows?.[0]?.fb_account_id || null
}

function pickFirstPlanRow(explainRows) {
  if (!Array.isArray(explainRows) || explainRows.length === 0) return null
  if (explainRows[0]?.table) return explainRows[0]
  return explainRows.find((row) => row?.table) || explainRows[0]
}

async function run() {
  const accountId = process.env.PERF_ACCOUNT_ID || await loadAnyAccountId()
  if (!accountId) {
    throw new Error('未找到可用 account_id，请设置 PERF_ACCOUNT_ID')
  }

  const today = new Date().toISOString().slice(0, 10)
  const checks = [
    {
      name: 'ad_level_today_latest_snapshot',
      sql: `
        EXPLAIN SELECT s.ad_id, s.ad_set_id, s.campaign_id
        FROM ad_snapshots s
        INNER JOIN (
          SELECT ad_id, MAX(synced_at) AS max_synced_at
          FROM ad_snapshots
          WHERE account_id = ? AND data_date = ?
          GROUP BY ad_id
        ) t ON s.ad_id = t.ad_id AND s.synced_at = t.max_synced_at
        WHERE s.account_id = ? AND s.data_date = ?
      `,
      params: [accountId, today, accountId, today]
    },
    {
      name: 'adset_level_history_group_by',
      sql: `
        EXPLAIN SELECT ad_set_id, SUM(spend) AS spend_sum
        FROM daily_stats
        WHERE account_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND date <= CURDATE()
        GROUP BY ad_set_id
      `,
      params: [accountId]
    },
    {
      name: 'campaign_level_history_group_by',
      sql: `
        EXPLAIN SELECT campaign_id, SUM(spend) AS spend_sum
        FROM daily_stats
        WHERE account_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND date <= CURDATE()
        GROUP BY campaign_id
      `,
      params: [accountId]
    }
  ]

  const reportDir = path.resolve('docs/perf-reports')
  await fs.mkdir(reportDir, { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    accountId,
    checks: []
  }

  let allScanCount = 0
  for (const check of checks) {
    const [rows] = await pool.execute(check.sql, check.params)
    const planRows = Array.isArray(rows) ? rows : []
    const allScanRows = planRows.filter((row) => String(row.type || '').toUpperCase() === 'ALL')
    allScanCount += allScanRows.length
    const sample = pickFirstPlanRow(planRows)
    report.checks.push({
      name: check.name,
      rowCount: planRows.length,
      allScanRows: allScanRows.length,
      sample: sample
        ? {
            table: sample.table || null,
            type: sample.type || null,
            key: sample.key || null,
            rows: sample.rows || null,
            filtered: sample.filtered || null
          }
        : null,
      raw: planRows
    })
    const singlePath = path.join(reportDir, `explain-${check.name}.json`)
    await fs.writeFile(singlePath, JSON.stringify({
      generatedAt: report.generatedAt,
      accountId,
      check: check.name,
      raw: planRows
    }, null, 2), 'utf8')
  }

  const reportPath = path.join(reportDir, 'explain-level-aggregation.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

  if (allScanCount > 0) {
    fail(`检测到 type=ALL 的执行计划行：${allScanCount}，详见 ${reportPath}`)
  } else {
    console.log(`[perf:explain] 通过，报告已写入 ${reportPath}`)
  }
}

run()
  .catch((error) => {
    fail(error.message || String(error))
  })
  .finally(async () => {
    await pool.end().catch(() => {})
  })
