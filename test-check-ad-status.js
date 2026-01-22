// 检查广告的当前状态
// 目的：验证广告是否被暂停/删除，导致 Facebook API 不返回

import { FacebookMarketingAPI } from './server/index.js'
import dotenv from 'dotenv'

dotenv.config()

async function checkAdStatus() {
  try {
    const accountId = process.argv[2] || 'act_927139705822379'
    const adId = process.argv[3] || '120240158513030388'
    
    console.log('🔍 检查广告状态...\n')
    console.log(`账户ID: ${accountId}`)
    console.log(`广告ID: ${adId}\n`)
    
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置')
      process.exit(1)
    }
    
    const api = new FacebookMarketingAPI(accessToken)
    
    // 1. 直接查询广告信息
    console.log('📋 第一步：直接查询广告信息...')
    try {
      const url = `https://graph.facebook.com/v24.0/${adId}`
      const params = {
        fields: 'id,name,status,effective_status,configured_status,adset_id,campaign_id',
        access_token: accessToken
      }
      
      const data = await api.makeRequest(url, params, 'GET')
      
      if (data.error) {
        console.log(`❌ 查询失败: ${data.error.message}`)
        console.log(`   可能原因：广告已被删除或 Token 无权限`)
      } else {
        console.log(`✅ 广告存在`)
        console.log(`   广告ID: ${data.id}`)
        console.log(`   广告名称: ${data.name || 'N/A'}`)
        console.log(`   状态 (status): ${data.status || 'N/A'}`)
        console.log(`   生效状态 (effective_status): ${data.effective_status || 'N/A'}`)
        console.log(`   配置状态 (configured_status): ${data.configured_status || 'N/A'}`)
        console.log(`   广告组ID: ${data.adset_id || 'N/A'}`)
        console.log(`   广告系列ID: ${data.campaign_id || 'N/A'}`)
        
        // 判断是否会影响 insights 返回
        const effectiveStatus = data.effective_status || data.status
        if (effectiveStatus === 'PAUSED' || effectiveStatus === 'ARCHIVED' || effectiveStatus === 'DELETED') {
          console.log(`\n⚠️  广告状态为 ${effectiveStatus}，这可能导致 insights 接口不返回该广告`)
        } else if (effectiveStatus === 'ACTIVE') {
          console.log(`\n✅ 广告状态为 ACTIVE，但 insights 接口没有返回`)
          console.log(`   可能原因：`)
          console.log(`   1. 今天没有投放活动（spend = 0, impressions = 0）`)
          console.log(`   2. Facebook API 的 insights 接口只返回"今天有数据"的广告`)
          console.log(`   3. 数据归因延迟，现在查询时还没有数据`)
        }
      }
    } catch (error) {
      console.log(`❌ 查询失败: ${error.message}`)
    }
    console.log()
    
    // 2. 查询该广告的 insights（单独查询）
    console.log('📋 第二步：单独查询该广告的 insights...')
    try {
      const url = `https://graph.facebook.com/v24.0/${adId}/insights`
      const params = {
        fields: 'ad_id,ad_name,spend,impressions,clicks',
        date_preset: 'today',
        access_token: accessToken
      }
      
      const data = await api.makeRequest(url, params, 'GET')
      
      if (data.error) {
        console.log(`❌ 查询失败: ${data.error.message}`)
        console.log(`   可能原因：`)
        console.log(`   1. 今天没有数据`)
        console.log(`   2. 广告已被暂停/删除`)
        console.log(`   3. Token 无权限`)
      } else {
        const insights = data.data || []
        if (insights.length === 0) {
          console.log(`⚠️  insights 返回空数组`)
          console.log(`   说明：Facebook API 认为今天没有数据`)
        } else {
          console.log(`✅ insights 返回 ${insights.length} 条记录`)
          insights.forEach((insight, i) => {
            console.log(`   记录 ${i + 1}:`)
            console.log(`     花费: $${insight.spend || 0}`)
            console.log(`     展示: ${insight.impressions || 0}`)
            console.log(`     点击: ${insight.clicks || 0}`)
          })
        }
      }
    } catch (error) {
      console.log(`❌ 查询失败: ${error.message}`)
    }
    console.log()
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkAdStatus()

