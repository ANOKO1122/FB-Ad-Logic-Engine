// 测试脚本：手动测试规则数据查询服务
// 目的：验证 ruleDataService.js 的真实数据查询功能
// 注意：需要数据库中有真实数据（ad_snapshots 或 daily_stats）

import { getAccountTimezone, queryRuleData } from './server/services/ruleDataService.js'
import pool from './server/db/connection.js'

/**
 * 【测试说明】
 * 这个脚本会：
 * 1. 从数据库获取真实的账户ID和广告ID
 * 2. 测试 getAccountTimezone 函数
 * 3. 测试 queryRuleData 函数（today、yesterday、last_3_days）
 * 4. 显示查询结果，便于验证
 */

async function testRuleDataService() {
  try {
    console.log('🔄 开始测试规则数据查询服务...\n')
    
    // ============================================
    // 第一步：获取真实的账户ID和广告ID
    // ============================================
    console.log('📋 第一步：从数据库获取账户和广告信息...')
    
    // 1.1 获取账户（优先使用指定的账户ID，如果没有则使用第一个活跃账户）
    // 可以通过命令行参数指定：node test-ruleDataService-manual.js act_927139705822379
    const specifiedAccountId = process.argv[2] || null
    
    let accounts
    if (specifiedAccountId) {
      // 使用指定的账户ID
      [accounts] = await pool.query(`
        SELECT 
          fb_account_id as account_id, 
          owner_id, 
          COALESCE(timezone_name, 'UTC') as timezone_name
        FROM account_mappings 
        WHERE fb_account_id = ? AND is_active = 1
        LIMIT 1
      `, [specifiedAccountId])
      
      if (!accounts || accounts.length === 0) {
        console.error(`❌ 指定的账户 ${specifiedAccountId} 不存在或未激活`)
        process.exit(1)
      }
      console.log(`📌 使用指定的账户: ${specifiedAccountId}`)
    } else {
      // 获取第一个活跃账户
      [accounts] = await pool.query(`
        SELECT 
          fb_account_id as account_id, 
          owner_id, 
          COALESCE(timezone_name, 'UTC') as timezone_name
        FROM account_mappings 
        WHERE is_active = 1
        LIMIT 1
      `)
    }
    
    if (!accounts || accounts.length === 0) {
      console.error('❌ 没有找到活跃账户，请先在 account_mappings 表中添加账户')
      process.exit(1)
    }
    
    const account = accounts[0]
    const accountId = String(account.account_id)
    const timezoneName = account.timezone_name || 'UTC'
    
    console.log(`✅ 找到账户: ${accountId}`)
    console.log(`   负责人ID: ${account.owner_id}`)
    console.log(`   时区: ${timezoneName}\n`)
    
    // 1.2 获取该账户下的广告ID（从 ad_snapshots 表）
    // 注意：不使用 DISTINCT，因为 ad_id 应该是唯一的
    // 如果同一个 ad_id 有多条记录，取最新的（按 synced_at DESC）
    const [allAds] = await pool.query(`
      SELECT ad_id, ad_name, synced_at
      FROM ad_snapshots
      WHERE account_id = ?
      ORDER BY synced_at DESC
      LIMIT 10
    `, [accountId])
    
    // 在 JavaScript 中去重（保留每个 ad_id 的第一条记录，即最新的）
    const adMap = new Map()
    for (const ad of allAds) {
      if (!adMap.has(ad.ad_id)) {
        adMap.set(ad.ad_id, ad)
      }
    }
    const ads = Array.from(adMap.values()).slice(0, 3)  // 取前3个
    
    if (!ads || ads.length === 0) {
      console.error('❌ 该账户下没有广告数据，请先运行数据同步（test-sync-now.js）')
      process.exit(1)
    }
    
    const adIds = ads.map(ad => String(ad.ad_id))
    console.log(`✅ 找到 ${ads.length} 个广告:`)
    ads.forEach((ad, index) => {
      console.log(`   ${index + 1}. ${ad.ad_id} - ${ad.ad_name || '(无名称)'}`)
    })
    console.log()
    
    // ============================================
    // 第二步：测试 getAccountTimezone 函数
    // ============================================
    console.log('📋 第二步：测试 getAccountTimezone 函数...')
    
    const queriedTimezone = await getAccountTimezone(accountId)
    console.log(`✅ 查询到的时区: ${queriedTimezone}`)
    
    if (queriedTimezone === timezoneName) {
      console.log(`✅ 时区匹配正确！\n`)
    } else {
      console.log(`⚠️  时区不匹配（数据库: ${timezoneName}, 查询: ${queriedTimezone}）\n`)
    }
    
    // ============================================
    // 第三步：测试 queryRuleData 函数 - today
    // ============================================
    console.log('📋 第三步：测试 queryRuleData 函数 - today（今日数据）...')
    
    try {
      const todayData = await queryRuleData(accountId, adIds[0], 'today', timezoneName)
      
      if (todayData && todayData.length > 0) {
        console.log(`✅ 查询成功，返回 ${todayData.length} 条记录`)
        console.log('📊 第一条记录数据:')
        const first = todayData[0]
        console.log(`   ad_id: ${first.ad_id}`)
        console.log(`   ad_name: ${first.ad_name || '(无名称)'}`)
        console.log(`   spend: $${first.spend}`)
        console.log(`   purchases: ${first.purchases}`)
        console.log(`   cpc: ${first.cpc != null ? '$' + first.cpc.toFixed(4) : '(null)'}`)
        console.log(`   roas: ${first.roas != null ? first.roas.toFixed(4) : '(null)'}`)
        console.log(`   cpa: ${first.cpa != null ? '$' + first.cpa.toFixed(4) : '(null)'}`)
        console.log(`   link_clicks: ${first.link_clicks}`)
        console.log(`   purchase_value: $${first.purchase_value}`)
      } else {
        console.log('⚠️  查询成功，但没有数据（可能是今日还没有快照）')
      }
    } catch (error) {
      console.error(`❌ 查询失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 第四步：测试 queryRuleData 函数 - yesterday
    // ============================================
    console.log('📋 第四步：测试 queryRuleData 函数 - yesterday（昨日数据）...')
    
    try {
      const yesterdayData = await queryRuleData(accountId, adIds[0], 'yesterday', timezoneName)
      
      if (yesterdayData && yesterdayData.length > 0) {
        console.log(`✅ 查询成功，返回 ${yesterdayData.length} 条记录`)
        console.log('📊 第一条记录数据:')
        const first = yesterdayData[0]
        console.log(`   ad_id: ${first.ad_id}`)
        console.log(`   spend: $${first.spend}`)
        console.log(`   purchases: ${first.purchases}`)
        console.log(`   cpc: ${first.cpc != null ? '$' + first.cpc.toFixed(4) : '(null)'}`)
        console.log(`   roas: ${first.roas != null ? first.roas.toFixed(4) : '(null)'}`)
      } else {
        console.log('⚠️  查询成功，但没有数据（可能是昨日还没有数据，或 daily_stats 未归档）')
        console.log('   提示：如果当前时间在 06:00 前，会降级查询 ad_snapshots 的昨日最后快照')
      }
    } catch (error) {
      console.error(`❌ 查询失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 第五步：测试 queryRuleData 函数 - last_3_days（多天聚合）
    // ============================================
    console.log('📋 第五步：测试 queryRuleData 函数 - last_3_days（过去3天，需要聚合）...')
    
    try {
      const last3DaysData = await queryRuleData(accountId, adIds[0], 'last_3_days', timezoneName)
      
      if (last3DaysData && last3DaysData.length > 0) {
        console.log(`✅ 查询成功，返回 ${last3DaysData.length} 条记录（已聚合）`)
        console.log('📊 聚合后的数据:')
        const first = last3DaysData[0]
        console.log(`   ad_id: ${first.ad_id}`)
        console.log(`   spend: $${first.spend}（3天总和）`)
        console.log(`   purchases: ${first.purchases}（3天总和）`)
        console.log(`   cpc: ${first.cpc != null ? '$' + first.cpc.toFixed(4) : '(null)'}（动态重算）`)
        console.log(`   roas: ${first.roas != null ? first.roas.toFixed(4) : '(null)'}（动态重算）`)
        console.log(`   cpa: ${first.cpa != null ? '$' + first.cpa.toFixed(4) : '(null)'}（动态重算）`)
        console.log(`   link_clicks: ${first.link_clicks}（3天总和）`)
        console.log(`   purchase_value: $${first.purchase_value}（3天总和）`)
      } else {
        console.log('⚠️  查询成功，但没有数据（可能是过去3天没有数据）')
      }
    } catch (error) {
      console.error(`❌ 查询失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 第六步：测试多个广告ID查询
    // ============================================
    console.log('📋 第六步：测试多个广告ID查询（today）...')
    
    try {
      const multiAdData = await queryRuleData(accountId, adIds.slice(0, 2), 'today', timezoneName)
      
      if (multiAdData && multiAdData.length > 0) {
        console.log(`✅ 查询成功，返回 ${multiAdData.length} 条记录`)
        console.log('📊 所有广告数据:')
        multiAdData.forEach((ad, index) => {
          console.log(`\n   广告 ${index + 1}:`)
          console.log(`     ad_id: ${ad.ad_id}`)
          console.log(`     spend: $${ad.spend}`)
          console.log(`     purchases: ${ad.purchases}`)
        })
      } else {
        console.log('⚠️  查询成功，但没有数据')
      }
    } catch (error) {
      console.error(`❌ 查询失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 测试完成
    // ============================================
    console.log('✅ 所有测试完成！')
    console.log('\n📝 验证要点:')
    console.log('   1. getAccountTimezone 是否正确返回时区？')
    console.log('   2. today 查询是否返回数据？')
    console.log('   3. yesterday 查询是否正常（可能降级）？')
    console.log('   4. last_3_days 查询是否正确聚合？')
    console.log('   5. 多个广告ID查询是否正常？')
    
    // 关闭数据库连接
    await pool.end()
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// 执行测试
testRuleDataService()

