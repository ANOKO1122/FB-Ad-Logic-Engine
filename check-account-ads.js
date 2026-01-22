// 检查账户下是否有广告
import { FacebookMarketingAPI } from './server/index.js'

async function checkAccountAds() {
  try {
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置')
      process.exit(1)
    }
    
    const accountId = 'act_927139705822379'
    const facebookApi = new FacebookMarketingAPI(accessToken)
    
    console.log(`🔄 检查账户 ${accountId} 下的广告...`)
    
    // 获取广告列表
    const ads = await facebookApi.getAds(accountId)
    
    console.log(`\n✅ 找到 ${ads.length} 个广告：`)
    if (ads.length === 0) {
      console.log('⚠️  账户下没有广告，无法进行数据同步测试')
      console.log('💡 提示：')
      console.log('   1. 在 Facebook Ads Manager 中创建一些测试广告')
      console.log('   2. 或者使用其他有广告的账户')
      console.log('   3. 或者使用手动插入测试数据的方式验证落盘逻辑')
      return
    }
    
    ads.slice(0, 10).forEach((ad, index) => {
      console.log(`\n广告 ${index + 1}:`)
      console.log(`  ad_id: ${ad.id || ad.ad_id}`)
      console.log(`  ad_name: ${ad.name || ad.ad_name || '(无名称)'}`)
      console.log(`  status: ${ad.status || ad.effective_status || '(未知)'}`)
    })
    
    if (ads.length > 10) {
      console.log(`\n... 还有 ${ads.length - 10} 个广告`)
    }
    
    // 检查活跃广告
    const activeAds = ads.filter(ad => {
      const status = ad.effective_status || ad.status || ''
      return status === 'ACTIVE' || status === 'PAUSED'
    })
    
    console.log(`\n📊 统计：`)
    console.log(`  总广告数: ${ads.length}`)
    console.log(`  活跃/暂停广告: ${activeAds.length}`)
    
    if (activeAds.length === 0) {
      console.log('⚠️  没有活跃或暂停的广告，无法获取 Insights 数据')
      console.log('💡 提示：Facebook API 只能获取活跃/暂停广告的 Insights 数据')
    }
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkAccountAds()

