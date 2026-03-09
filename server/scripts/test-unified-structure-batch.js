// server/scripts/test-unified-structure-batch.js
import { FacebookMarketingAPI } from '../index.js'

async function main() {
  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    console.error('[ERROR] 缺少环境变量 FACEBOOK_ACCESS_TOKEN')
    process.exit(1)
  }

  // 用你指定的测试账户
  const accountId = 'act_1155891202142879'

  // 时间窗口与方案一致：首次/无上次同步 = 近 3 天；有上次同步时 = max(上次同步 - 缓冲, now-3d)，方案里缓冲 2h，可选 4h
  const THREE_DAYS_SEC = 3 * 24 * 3600
  const sinceSec = Math.floor(Date.now() / 1000) - THREE_DAYS_SEC
  console.log('(口径: 近3天 sinceSec，与 Track1/Track2 首次拉取一致)')

  console.log('=== test-unified-structure-batch ===')
  console.log('accountId =', accountId)
  console.log('sinceSec  =', sinceSec)

  const api = new FacebookMarketingAPI(token)

  try {
    const result = await api.unifiedStructureBatch(accountId, {
      sinceSec,
      limit: 100
    })

    // 简要统计输出，避免打印巨量数据
    for (const edge of ['campaigns', 'adsets', 'ads']) {
      const r = result[edge] || {}
      const items = Array.isArray(r.items) ? r.items : []
      console.log(`\n[${edge}] code=${r.code} error=${r.error || 'null'} count=${items.length} after=${r.after || 'null'}`)
      if (items.length > 0) {
        const sample = items.slice(0, 3).map(x => ({
          id: x.id,
          name: x.name,
          status: x.status,
          effective_status: x.effective_status,
          updated_time: x.updated_time,
          created_time: x.created_time
        }))
        console.log(`  sample(最多3条):`, JSON.stringify(sample, null, 2))
      }
    }

    console.log('\n=== DONE test-unified-structure-batch ===')
  } catch (e) {
    console.error('[ERROR] 调用 unifiedStructureBatch 出错:', e.message)
    console.error(e)
    process.exit(1)
  }
}

main()