// 测试 ruleDataService 的 custom_range 支持
// 目的：验证 custom_range 在 ruleDataService.js 中是否正常工作

import { queryRuleData, getAccountTimezone } from './server/services/ruleDataService.js'
import pool from './server/db/connection.js'

async function testCustomRange() {
  try {
    console.log('🔍 测试 ruleDataService 的 custom_range 支持...\n')
    
    const accountId = process.argv[2] || 'act_927139705822379'
    
    // 1. 获取账户信息
    console.log('📋 第一步：获取账户信息...')
    const [accounts] = await pool.query(`
      SELECT 
        fb_account_id as account_id, 
        owner_id, 
        COALESCE(timezone_name, 'UTC') as timezone_name
      FROM account_mappings 
      WHERE fb_account_id = ? AND is_active = 1
      LIMIT 1
    `, [accountId])
    
    if (!accounts || accounts.length === 0) {
      console.error(`❌ 账户 ${accountId} 不存在或未激活`)
      process.exit(1)
    }
    
    const account = accounts[0]
    const timezoneName = account.timezone_name || 'UTC'
    
    console.log(`✅ 找到账户: ${accountId}`)
    console.log(`   时区: ${timezoneName}\n`)
    
    // 2. 获取广告ID
    console.log('📋 第二步：获取广告ID...')
    const [ads] = await pool.query(`
      SELECT ad_id, ad_name
      FROM ad_snapshots
      WHERE account_id = ?
      ORDER BY synced_at DESC
      LIMIT 3
    `, [accountId])
    
    if (!ads || ads.length === 0) {
      console.error('❌ 该账户下没有广告数据')
      process.exit(1)
    }
    
    const adIds = ads.map(ad => String(ad.ad_id))
    console.log(`✅ 找到 ${ads.length} 个广告: ${adIds.join(', ')}\n`)
    
    // 3. 测试 custom_range（7天范围）
    console.log('📋 第三步：测试 custom_range（7天范围）...')
    try {
      const customRange = {
        since: '2026-01-14',
        until: '2026-01-20'
      }
      
      const result = await queryRuleData(accountId, adIds, 'custom_range', timezoneName, customRange)
      
      console.log(`✅ custom_range 查询成功，返回 ${result.length} 条记录`)
      if (result.length > 0) {
        console.log(`📊 第一条记录:`)
        console.log(`   ad_id: ${result[0].ad_id}`)
        console.log(`   spend: $${result[0].spend || 0}`)
        console.log(`   purchases: ${result[0].purchases || 0}`)
        console.log(`   roas: ${result[0].roas || 0}`)
        console.log(`   cpa: $${result[0].cpa || 0}`)
      }
    } catch (error) {
      console.error(`❌ custom_range 查询失败:`, error.message)
    }
    
    // 4. 测试 custom_range（无效格式）
    console.log('\n📋 第四步：测试 custom_range（无效格式，应该抛出错误）...')
    try {
      const invalidRange = {
        since: '2026/01/14',  // 错误格式
        until: '2026-01-20'
      }
      
      const result = await queryRuleData(accountId, adIds, 'custom_range', timezoneName, invalidRange)
      console.log(`❌ 应该抛出错误，但返回了结果: ${result.length} 条记录`)
    } catch (error) {
      console.log(`✅ 正确捕获错误: ${error.message}`)
    }
    
    // 5. 测试 custom_range（范围反转）
    console.log('\n📋 第五步：测试 custom_range（范围反转，应该抛出错误）...')
    try {
      const reversedRange = {
        since: '2026-01-20',  // 开始日期晚于结束日期
        until: '2026-01-14'
      }
      
      const result = await queryRuleData(accountId, adIds, 'custom_range', timezoneName, reversedRange)
      console.log(`❌ 应该抛出错误，但返回了结果: ${result.length} 条记录`)
    } catch (error) {
      console.log(`✅ 正确捕获错误: ${error.message}`)
    }
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

testCustomRange()

