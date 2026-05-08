import fs from 'node:fs/promises'
import path from 'node:path'
import pool from '../../server/db/connection.js'
import { queryRuleDataByLevel } from '../../server/services/ruleDataService.js'

const CORE_SQL_P95_LIMIT_MS = Number(process.env.PERF_CORE_SQL_P95_MS || 500)
const FULL_EVAL_P95_LIMIT_MS = Number(process.env.PERF_FULL_EVAL_P95_MS || 3000)
const WARMUP_ROUNDS = Number(process.env.PERF_WARMUP_ROUNDS || 5)
const RUN_ROUNDS = Number(process.env.PERF_RUN_ROUNDS || 30)

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

async function loadBenchmarkScope() {
  const accountId = process.env.PERF_ACCOUNT_ID
  if (accountId) {
    const [campaignRows] = await pool.execute(
      'SELECT DISTINCT campaign_id FROM structure_ads WHERE account_id = ? AND campaign_id IS NOT NULL LIMIT 5',
      [accountId]
    )
    const objectIds = (campaignRows || []).map((row) => String(row.campaign_id || '')).filter(Boolean)
    if (objectIds.length > 0) return { accountId, objectIds }
  }

  const [accountRows] = await pool.execute(
    'SELECT fb_account_id FROM account_mappings WHERE is_active = 1 ORDER BY id ASC LIMIT 1'
  )
  const fallbackAccountId = accountRows?.[0]?.fb_account_id
  if (!fallbackAccountId) throw new Error('未找到可用于 benchmark 的 account_id')
  const [campaignRows] = await pool.execute(
    'SELECT DISTINCT campaign_id FROM structure_ads WHERE account_id = ? AND campaign_id IS NOT NULL LIMIT 5',
    [fallbackAccountId]
  )
  const objectIds = (campaignRows || []).map((row) => String(row.campaign_id || '')).filter(Boolean)
  if (objectIds.length === 0) throw new Error(`账户 ${fallbackAccountId} 不存在可用 campaign_id`)
  return { accountId: fallbackAccountId, objectIds }
}

async function measureCoreSql(accountId) {
  const costs = []
  const sql = `
    SELECT campaign_id, SUM(spend) AS spend_sum
    FROM daily_stats
    WHERE account_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND date <= CURDATE()
    GROUP BY campaign_id
  `
  for (let i = 0; i < WARMUP_ROUNDS + RUN_ROUNDS; i++) {
    const start = nowMs()
    await pool.execute(sql, [accountId])
    const elapsed = nowMs() - start
    if (i >= WARMUP_ROUNDS) costs.push(elapsed)
  }
  return {
    p95: percentile(costs, 95),
    samples: costs
  }
}

async function measureFullEval(accountId, objectIds) {
  const costs = []
  for (let i = 0; i < WARMUP_ROUNDS + RUN_ROUNDS; i++) {
    const start = nowMs()
    await queryRuleDataByLevel(accountId, objectIds, 'campaign', 'last_7_days', null, null)
    const elapsed = nowMs() - start
    if (i >= WARMUP_ROUNDS) costs.push(elapsed)
  }
  return {
    p95: percentile(costs, 95),
    samples: costs
  }
}

async function run() {
  const { accountId, objectIds } = await loadBenchmarkScope()
  const coreSql = await measureCoreSql(accountId)
  const fullEval = await measureFullEval(accountId, objectIds)

  const report = {
    generatedAt: new Date().toISOString(),
    accountId,
    objectIds,
    warmupRounds: WARMUP_ROUNDS,
    runRounds: RUN_ROUNDS,
    thresholds: {
      coreSqlP95Ms: CORE_SQL_P95_LIMIT_MS,
      fullEvalP95Ms: FULL_EVAL_P95_LIMIT_MS
    },
    coreSql,
    fullEval
  }

  const reportDir = path.resolve('docs/perf-reports')
  await fs.mkdir(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, 'benchmark-level-aggregation.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

  if ((coreSql.p95 ?? Infinity) > CORE_SQL_P95_LIMIT_MS) {
    throw new Error(`核心聚合 SQL p95=${coreSql.p95}ms 超过阈值 ${CORE_SQL_P95_LIMIT_MS}ms`)
  }
  if ((fullEval.p95 ?? Infinity) > FULL_EVAL_P95_LIMIT_MS) {
    throw new Error(`单账户完整评估 p95=${fullEval.p95}ms 超过阈值 ${FULL_EVAL_P95_LIMIT_MS}ms`)
  }

  console.log(`[perf:bench] 通过，报告已写入 ${reportPath}`)
}

run()
  .catch((error) => {
    console.error(`[perf:bench] ${error.message || String(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => {})
  })
