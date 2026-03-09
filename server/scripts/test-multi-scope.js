/**
 * 监控范围 / multi 接口本地测试脚本
 * 用途：用不同参数请求 /api/structure/objects/multi，自动翻页汇总条数，对比「仅 ACTIVE」vs「ACTIVE+PAUSED」。
 *
 * 使用（二选一）：
 * 1) 环境变量：JWT_TOKEN、ACCOUNT_IDS（逗号分隔），可选 BASE_URL
 *    set ACCOUNT_IDS=act_1,act_2,act_3,act_4
 *    set JWT_TOKEN=eyJhbGciOiJIUzI1NiIs...
 *    node server/scripts/test-multi-scope.js
 *
 * 2) 命令行参数：node server/scripts/test-multi-scope.js <JWT> <account_ids>
 *    node server/scripts/test-multi-scope.js "eyJhbGc..." "act_1,act_2,act_3,act_4"
 *
 * 前置：后端已启动（npm run dev:server），.env 可无 JWT（用命令行或 set 传即可）
 */
import 'dotenv/config'
import https from 'https'
import http from 'http'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'
const JWT = process.env.JWT_TOKEN || process.env.BEARER_TOKEN || process.argv[2]
const ACCOUNT_IDS_RAW = process.env.ACCOUNT_IDS || process.argv[3]

function parseUrl(u) {
  const url = new URL(u)
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search
  }
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const { protocol, host, port, path } = parseUrl(url)
    const lib = protocol === 'https:' ? https : http
    const req = lib.get(
      { host, port: port || (protocol === 'https:' ? 443 : 80), path, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          try {
            const data = JSON.parse(body)
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.error || body}`))
            } else {
              resolve(data)
            }
          } catch (e) {
            reject(new Error(`Parse error: ${body.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
  })
}

async function fetchMultiTotal(accountIds, opts = {}) {
  const params = new URLSearchParams({
    account_ids: accountIds,
    type: 'ad',
    limit: String(opts.limit || 500)
  })
  if (opts.include_paused) params.set('include_paused', '1')
  if (opts.scope_status) params.set('scope_status', opts.scope_status)

  let total = 0
  let after = null
  const seen = new Set()

  while (true) {
    if (after) params.set('after', after)
    const url = `${BASE_URL}/api/structure/objects/multi?${params.toString()}`
    const headers = { Authorization: `Bearer ${JWT}` }
    const data = await request(url, headers)

    const items = data.items || []
    for (const it of items) {
      const key = `${it.account_id}:${it.id}`
      if (seen.has(key)) continue
      seen.add(key)
      total++
    }

    const nextAfter = data.paging?.after
    const hasMore = data.has_more && nextAfter
    if (!hasMore || !nextAfter) break
    after = nextAfter
  }

  return { total, unique: seen.size }
}

async function main() {
  if (!JWT) {
    console.error('缺少 JWT。请设置环境变量 JWT_TOKEN 或命令行参数：')
    console.error('  node server/scripts/test-multi-scope.js <JWT> <account_ids>')
    console.error('示例：node server/scripts/test-multi-scope.js "eyJhbGc..." "act_1,act_2,act_3,act_4"')
    process.exit(1)
  }
  const accountIds = (ACCOUNT_IDS_RAW || '').trim().replace(/\s+/g, '')
  if (!accountIds) {
    console.error('缺少 account_ids。请设置环境变量 ACCOUNT_IDS 或命令行第三个参数（逗号分隔）')
    process.exit(1)
  }

  console.log('')
  console.log('multi 接口测试（type=ad，自动翻页汇总）')
  console.log('BASE_URL:', BASE_URL)
  console.log('account_ids:', accountIds)
  console.log('')

  try {
    // 1) 默认：仅 ACTIVE（不传 include_paused / scope_status）
    console.log('1/3 请求中：默认（仅 ACTIVE）…')
    const r1 = await fetchMultiTotal(accountIds, {})
    console.log('   结果:', r1.total, '条')

    // 2) include_paused=1 → ACTIVE + PAUSED
    console.log('2/3 请求中：include_paused=1（ACTIVE + PAUSED）…')
    const r2 = await fetchMultiTotal(accountIds, { include_paused: true })
    console.log('   结果:', r2.total, '条')

    // 3) scope_status=active_and_paused
    console.log('3/3 请求中：scope_status=active_and_paused…')
    const r3 = await fetchMultiTotal(accountIds, { scope_status: 'active_and_paused' })
    console.log('   结果:', r3.total, '条')

    console.log('')
    console.log('汇总：')
    console.log('  仅 ACTIVE（默认）:', r1.total)
    console.log('  include_paused=1 :', r2.total)
    console.log('  active_and_paused:', r3.total)
    console.log('')
    if (r1.total < r2.total || r1.total < r3.total) {
      console.log('说明：Thunder Client 想拿到更多广告时，在 Query 里增加：')
      console.log('  include_paused = 1')
      console.log('或')
      console.log('  scope_status = active_and_paused')
      console.log('')
    }
  } catch (e) {
    console.error('请求失败:', e.message)
    process.exit(1)
  }
}

main()
