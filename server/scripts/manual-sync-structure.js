// 手动同步指定账户的广告结构到 structure_campaigns / structure_adsets / structure_ads（等同于前端「刷新列表」后端逻辑）
// 使用：node server/scripts/manual-sync-structure.js [account_id]
// 示例：node server/scripts/manual-sync-structure.js act_927139705822379
// 说明：无超时限制，适合大账户；遇限流会快速失败并提示 retry_after_sec

import 'dotenv/config'
import { syncAccountStructureAds } from '../services/structureSyncService.js'
import { FacebookMarketingAPI } from '../index.js'

const accountId = process.argv[2] || 'act_927139705822379'

console.log('')
console.log('='.repeat(50))
console.log('🔧 手动同步广告结构到 structure_ads')
console.log('   账户:', accountId)
console.log('='.repeat(50))
console.log('')

const token = process.env.FACEBOOK_ACCESS_TOKEN
if (!token) {
  console.error('❌ 缺少 FACEBOOK_ACCESS_TOKEN')
  process.exit(1)
}

try {
  const api = new FacebookMarketingAPI(token)
  const result = await syncAccountStructureAds(accountId, api)

  if (result.ok) {
    console.log('✅ 同步成功')
    console.log('   campaigns:', result.synced_campaigns ?? 0)
    console.log('   adsets:', result.synced_adsets ?? 0)
    console.log('   ads:', result.synced_count ?? 0)
    console.log('   耗时(ms):', result.duration_ms ?? '-')
  } else {
    console.log('❌ 同步未完成')
    console.log('   原因:', result.reason)
    if (result.retry_after_sec != null) {
      console.log('   建议等待(秒):', result.retry_after_sec)
    }
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
