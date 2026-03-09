// server/scripts/test-fast-sync-structure.js
import { FacebookMarketingAPI } from '../index.js'
import { fastSyncStructureForAccount } from '../services/structureSyncService.js'

async function main() {
  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    console.error('[ERROR] 缺少环境变量 FACEBOOK_ACCESS_TOKEN')
    process.exit(1)
  }

  const accountId = 'act_1155891202142879'

  // 和前两次验证保持一致的窗口与 limit
  const sinceSec = 1772518705
  const limit = 100

  console.log('=== test-fast-sync-structure ===')
  console.log('accountId =', accountId)
  console.log('sinceSec  =', sinceSec, '(近3天窗口起点)')
  console.log('limit     =', limit)

  const api = new FacebookMarketingAPI(token)

  try {
    const res = await fastSyncStructureForAccount(accountId, api, {
      sinceSec,
      limit
    })

    // 建议 fastSyncStructureForAccount 返回形如：
    // {
    //   synced_campaigns,
    //   synced_adsets,
    //   synced_ads,
    //   edges: { campaigns: { after }, adsets: { after }, ads: { after } }
    // }

    console.log('\n[FastSync result]')
    console.log('synced_campaigns =', res.synced_campaigns)
    console.log('synced_adsets    =', res.synced_adsets)
    console.log('synced_ads       =', res.synced_ads)

    console.log('\n[Edges after]')
    console.log('campaigns.after  =', res.edges?.campaigns?.after || 'null')
    console.log('adsets.after     =', res.edges?.adsets?.after || 'null')
    console.log('ads.after        =', res.edges?.ads?.after || 'null')

    console.log('\n[Soft pages]')
    console.log('campaigns.pages =', res.edges?.campaigns?.pages)
    console.log('adsets.pages    =', res.edges?.adsets?.pages)
    console.log('ads.pages       =', res.edges?.ads?.pages)

    console.log('\n=== DONE test-fast-sync-structure ===')
  } catch (e) {
    console.error('[ERROR] fastSyncStructureForAccount 出错:', e.message)
    console.error(e)
    process.exit(1)
  }
}

main()