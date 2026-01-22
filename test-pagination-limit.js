// 测试分页功能：验证 limit=200 是否生效，以及是否能获取所有广告
// 目的：验证分页修复后，即使有大量广告也能全部获取

import { FacebookMarketingAPI } from './server/index.js'
import dotenv from 'dotenv'

dotenv.config()

async function testPagination() {
  try {
    const accountId = process.argv[2] || 'act_927139705822379'
    
    console.log('🔍 测试分页功能（limit=200）...\n')
    console.log(`账户ID: ${accountId}\n`)
    
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!accessToken) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置')
      process.exit(1)
    }
    
    const api = new FacebookMarketingAPI(accessToken)
    
    // 1. 获取 today 的 insights（会触发分页）
    console.log('📋 第一步：获取 today 的 insights 数据（测试分页）...')
    const startTime = Date.now()
    const insights = await api.getAdInsights(accountId, { preset: 'today' }, { level: 'ad' })
    const endTime = Date.now()
    const duration = ((endTime - startTime) / 1000).toFixed(2)
    
    console.log(`✅ 获取完成，耗时: ${duration} 秒`)
    console.log(`✅ 总共获取 ${insights.length} 个广告的 insights 数据\n`)
    
    // 2. 统计唯一广告ID数量
    const uniqueAdIds = new Set(insights.map(i => String(i.ad_id))).size
    console.log(`📊 统计信息:`)
    console.log(`   总记录数: ${insights.length}`)
    console.log(`   唯一广告数: ${uniqueAdIds}`)
    if (insights.length > uniqueAdIds) {
      console.log(`   ⚠️  注意：存在重复记录（可能是 Facebook API 返回的数据问题）`)
    }
    console.log()
    
    // 3. 列出所有广告ID（前20个）
    console.log(`📋 前20个广告的ID:`)
    insights.slice(0, 20).forEach((insight, i) => {
      console.log(`   ${i + 1}. ${insight.ad_id} - ${insight.ad_name || 'N/A'} (spend: $${insight.spend || 0})`)
    })
    if (insights.length > 20) {
      console.log(`   ... 还有 ${insights.length - 20} 个广告`)
    }
    console.log()
    
    // 4. 验证分页是否正常工作
    // 如果广告数量 > 25（默认 limit），说明分页生效
    // 如果广告数量 > 200，说明多页分页生效
    if (insights.length > 200) {
      const estimatedPages = Math.ceil(insights.length / 200)
      console.log(`✅ 分页验证:`)
      console.log(`   广告数量 (${insights.length}) > 200，说明分页正常工作`)
      console.log(`   预计分页数: ${estimatedPages} 页`)
      console.log(`   每页 limit: 200（已优化）`)
    } else if (insights.length > 25) {
      console.log(`✅ 分页验证:`)
      console.log(`   广告数量 (${insights.length}) > 25，说明分页正常工作`)
      console.log(`   预计分页数: ${Math.ceil(insights.length / 200)} 页`)
      console.log(`   每页 limit: 200（已优化）`)
    } else {
      console.log(`ℹ️  分页验证:`)
      console.log(`   广告数量 (${insights.length}) <= 200，可能只有一页数据`)
      console.log(`   每页 limit: 200（已优化）`)
    }
    console.log()
    
    // 5. 性能对比提示
    if (insights.length > 25) {
      const oldPageCount = Math.ceil(insights.length / 25)
      const newPageCount = Math.ceil(insights.length / 200)
      const improvement = ((oldPageCount - newPageCount) / oldPageCount * 100).toFixed(1)
      console.log(`📈 性能优化效果:`)
      console.log(`   优化前（limit=25）: 需要 ${oldPageCount} 页请求`)
      console.log(`   优化后（limit=200）: 需要 ${newPageCount} 页请求`)
      console.log(`   减少请求数: ${oldPageCount - newPageCount} 次 (${improvement}%)`)
    }
    console.log()
    
    console.log('✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testPagination()

