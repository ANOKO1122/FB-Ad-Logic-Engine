// 检查 Facebook API 是否返回了该广告
// 目的：验证前端为什么没有显示这个广告

import { FacebookMarketingAPI } from './server/index.js'
import dotenv from 'dotenv'

dotenv.config()

async function checkFacebookAPI() {
  try {
    const accountId = process.argv[2] || 'act_927139705822379'
    const adId = process.argv[3] || '120240158513030388'
    
    console.log('🔍 检查 Facebook API 是否返回该广告...\n')
    console.log(`账户ID: ${accountId}`)
    console.log(`广告ID: ${adId}\n`)
    
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置')
      process.exit(1)
    }
    
    const api = new FacebookMarketingAPI(accessToken)
    
    // 1. 获取所有广告列表
    console.log('📋 第一步：获取账户下的所有广告列表...')
    const ads = await api.getAds(accountId)
    console.log(`✅ 找到 ${ads.length} 个广告`)
    
    const targetAd = ads.find(ad => String(ad.id || ad.ad_id) === adId)
    if (targetAd) {
      console.log(`✅ 广告 ${adId} 在广告列表中`)
      console.log(`   广告名称: ${targetAd.name || targetAd.ad_name || 'N/A'}`)
      console.log(`   状态: ${targetAd.status || targetAd.effective_status || 'N/A'}`)
    } else {
      console.log(`❌ 广告 ${adId} 不在广告列表中`)
      console.log(`   可能原因：广告已被删除、归档或暂停`)
    }
    console.log()
    
    // 2. 获取 today 的 insights
    console.log('📋 第二步：获取 today 的 insights 数据...')
    const insights = await api.getAdInsights(accountId, { preset: 'today' }, { level: 'ad' })
    console.log(`✅ 找到 ${insights.length} 个广告的 insights 数据`)
    
    const targetInsight = insights.find(insight => String(insight.ad_id) === adId)
    if (targetInsight) {
      console.log(`✅ 广告 ${adId} 在 insights 数据中`)
      console.log(`   花费: $${targetInsight.spend || 0}`)
      console.log(`   点击: ${targetInsight.clicks || 0}`)
      console.log(`   展示: ${targetInsight.impressions || 0}`)
    } else {
      console.log(`❌ 广告 ${adId} 不在 insights 数据中`)
      console.log(`   可能原因：`)
      console.log(`   1. 今天没有数据（新广告或今天未投放）`)
      console.log(`   2. 广告已被暂停/删除`)
      console.log(`   3. Facebook API 过滤了该广告`)
    }
    console.log()
    
    // 3. 列出前10个广告的ID，方便对比
    console.log('📋 第三步：前10个广告的ID（用于对比）...')
    ads.slice(0, 10).forEach((ad, i) => {
      const adIdStr = String(ad.id || ad.ad_id)
      const isTarget = adIdStr === adId
      console.log(`   ${i + 1}. ${adIdStr} ${isTarget ? '← 目标广告' : ''}`)
    })
    console.log()
    
    // 4. 列出前10个 insights 的广告ID
    console.log('📋 第四步：前10个 insights 的广告ID（用于对比）...')
    insights.slice(0, 10).forEach((insight, i) => {
      const adIdStr = String(insight.ad_id)
      const isTarget = adIdStr === adId
      console.log(`   ${i + 1}. ${adIdStr} ${isTarget ? '← 目标广告' : ''}`)
    })
    console.log()
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkFacebookAPI()

