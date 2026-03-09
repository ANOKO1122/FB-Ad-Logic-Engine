// server/scripts/test-structure-page-after.js
import { FacebookMarketingAPI } from '../index.js'

async function main() {
  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    console.error('[ERROR] 缺少环境变量 FACEBOOK_ACCESS_TOKEN')
    process.exit(1)
  }

  const accountId = 'act_1155891202142879'

  // 把上一轮脚本打印的 sinceSec 原样填进来（确保和生成 after 的请求一致）
  const SINCE_SEC = 1772518705  // ← 用你上一轮输出的 sinceSec 替换

  // 这里用 ads 的 after 游标做演示，你也可以换成 campaigns/adsets 的 after
  const AFTER = 'QVFIUzZAQZAHEtMlloblJhbUw3T2N5S0tISURTNWRZAc1cwdlBkTDZAmQS1DVjlsVFFwRTM4UHNZASVczM2MyWEdQRXpsR00ZD'
  // ↑ 把你终端里 [ads] 那行的 after 全量粘过来

  const api = new FacebookMarketingAPI(token)

  try {
    const res = await api.getStructurePage(accountId, 'ads', {
      fields: 'id,name,status,effective_status,configured_status,updated_time,created_time,adset_id,campaign_id',
      limit: 100,
      after: AFTER,
      filtering: [
        {
          field: 'updated_time',
          operator: 'GREATER_THAN',
          value: String(SINCE_SEC)
        }
      ]
    })

    console.log('=== test-structure-page-after ===')
    console.log('items.length =', res.items.length)
    console.log('next after   =', res.paging.after || 'null')

    if (res.items.length > 0) {
      const sample = res.items.slice(0, 3).map(x => ({
        id: x.id,
        name: x.name,
        status: x.status,
        effective_status: x.effective_status,
        updated_time: x.updated_time,
        created_time: x.created_time
      }))
      console.log('sample(最多3条):', JSON.stringify(sample, null, 2))
    }

    console.log('=== DONE test-structure-page-after ===')
  } catch (e) {
    console.error('[ERROR] getStructurePage(after) 出错:', e.message)
    console.error(e)
    process.exit(1)
  }
}

main()