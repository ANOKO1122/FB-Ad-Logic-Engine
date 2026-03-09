// 仅补齐指定账户的广告组（adsets）到 structure_adsets，不拉 campaigns、不拉 ads。
// 使用：node server/scripts/backfill-adsets-act_927139705822379.js
// 说明：按现有结构同步逻辑全量分页拉取 adsets 并 upsert；遇限流会抛错，可稍后重试。

import 'dotenv/config'
import { syncAccountStructureAdsetsOnly } from '../services/structureSyncService.js'
import { FacebookMarketingAPI } from '../index.js'

const ACCOUNT_ID = 'act_927139705822379'

console.log('')
console.log('='.repeat(50))
console.log('🔧 补数：仅同步广告组（adsets）→ structure_adsets')
console.log('   账户:', ACCOUNT_ID)
console.log('='.repeat(50))
console.log('')

const token = process.env.FACEBOOK_ACCESS_TOKEN
if (!token) {
  console.error('❌ 缺少 FACEBOOK_ACCESS_TOKEN')
  process.exit(1)
}

try {
  const api = new FacebookMarketingAPI(token)
  const result = await syncAccountStructureAdsetsOnly(ACCOUNT_ID, api, { skipLock: true })

  if (result.ok) {
    console.log('✅ 同步成功')
    console.log('   adsets:', result.synced_count ?? 0)
  } else {
    console.log('❌ 同步未完成')
    console.log('   原因:', result.reason)
    process.exit(1)
  }
  console.log('')
  console.log('='.repeat(50))
  process.exit(0)
} catch (err) {
  const msg = err?.message ?? String(err)
  if (/user request limit reached/i.test(msg) || /rate limit/i.test(msg)) {
    console.error('❌ FB API 限流:', msg)
    console.error('   建议等待约 1 小时后再试')
  } else {
    console.error('❌ 同步失败:', msg)
    console.error(err.stack)
  }
  process.exit(1)
}
