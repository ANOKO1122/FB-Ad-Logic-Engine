// 测试脚本：手动测试增强后的 RuleEngine
// 目的：验证 RuleEngine 的新功能（从数据库查询数据、AND/OR 逻辑、目标筛选）
// 注意：需要数据库中有真实数据（ad_snapshots 或 daily_stats）

import { RuleEngine, FacebookMarketingAPI } from './server/index.js'
import pool from './server/db/connection.js'

/**
 * 【测试说明】
 * 这个脚本会：
 * 1. 从数据库获取真实的账户ID和规则
 * 2. 测试新版本的 evaluateRule 方法（从数据库查询数据）
 * 3. 测试 AND/OR 逻辑运算符
 * 4. 测试目标筛选（target_level 和 target_ids）
 * 5. 显示匹配结果，便于验证
 */

async function testRuleEngine() {
  try {
    console.log('🔄 开始测试增强后的 RuleEngine...\n')
    
    // ============================================
    // 第一步：获取真实的账户ID
    // ============================================
    console.log('📋 第一步：从数据库获取账户信息...')
    
    // 支持通过命令行参数指定账户ID
    // 使用方法：node test-ruleEngine-manual.js act_927139705822379
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
    
    // ============================================
    // 第二步：获取该账户下的广告ID
    // ============================================
    console.log('📋 第二步：获取账户下的广告ID...')
    
    const [ads] = await pool.query(`
      SELECT s.ad_id
      FROM ad_snapshots s
      INNER JOIN (
        SELECT ad_id, MAX(synced_at) as max_synced_at
        FROM ad_snapshots
        WHERE account_id = ?
        GROUP BY ad_id
      ) t
      ON s.ad_id = t.ad_id AND s.synced_at = t.max_synced_at
      WHERE s.account_id = ?
      LIMIT 3
    `, [accountId, accountId])
    
    if (!ads || ads.length === 0) {
      console.error('❌ 该账户下没有广告数据，请先运行数据同步（test-sync-now.js）')
      process.exit(1)
    }
    
    const adIds = ads.map(ad => String(ad.ad_id))
    console.log(`✅ 找到 ${ads.length} 个广告: ${adIds.join(', ')}\n`)
    
    // ============================================
    // 第三步：创建 RuleEngine 实例
    // ============================================
    console.log('📋 第三步：创建 RuleEngine 实例...')
    
    // 创建模拟的 Facebook API 客户端（用于执行动作）
    // 注意：规则评估使用数据库查询，不需要真实的 Facebook API
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN || 'mock_token'
    const api = new FacebookMarketingAPI(accessToken)
    const ruleEngine = new RuleEngine(api)
    
    console.log('✅ RuleEngine 实例创建成功\n')
    
    // ============================================
    // 第四步：先查看实际数据，然后测试规则
    // ============================================
    console.log('📋 第四步：查看实际数据（today）...')
    
    // 先查询实际数据，看看值是多少
    const { queryRuleData } = await import('./server/services/ruleDataService.js')
    const actualData = await queryRuleData(accountId, adIds, 'today', timezoneName)
    
    if (actualData.length > 0) {
      console.log('📊 实际数据（today）:')
      actualData.forEach((ad, index) => {
        console.log(`\n   广告 ${index + 1}:`)
        console.log(`     ad_id: ${ad.ad_id}`)
        console.log(`     ad_name: ${ad.ad_name || '(无名称)'}`)
        console.log(`     spend: $${ad.spend}`)
        console.log(`     purchases: ${ad.purchases}`)
        console.log(`     cpc: ${ad.cpc != null ? '$' + ad.cpc.toFixed(4) : '(null)'}`)
        console.log(`     roas: ${ad.roas != null ? ad.roas.toFixed(4) : '(null)'}`)
        console.log(`     cpa: ${ad.cpa != null ? '$' + ad.cpa.toFixed(4) : '(null)'}`)
      })
    } else {
      console.log('⚠️  今日没有数据')
    }
    console.log()
    
    // ============================================
    // 第五步：测试规则1 - AND 逻辑（根据实际数据调整阈值）
    // ============================================
    console.log('📋 第五步：测试规则1 - AND 逻辑（根据实际数据调整阈值）...')
    
    // 根据实际数据动态调整阈值（如果数据存在）
    let spendThreshold = 50
    let purchasesThreshold = 2
    if (actualData.length > 0) {
      // 使用实际数据的最大值作为阈值（确保至少有一个匹配）
      const maxSpend = Math.max(...actualData.map(ad => ad.spend || 0))
      const minPurchases = Math.min(...actualData.map(ad => ad.purchases || 0))
      spendThreshold = Math.max(1, Math.floor(maxSpend * 0.8))  // 80% 的最大值
      purchasesThreshold = Math.max(1, minPurchases + 1)  // 最小值 + 1
      console.log(`   调整阈值：spend > $${spendThreshold}, purchases < ${purchasesThreshold}`)
    }
    
    const rule1 = {
      id: 'test_rule_1',
      ruleName: '测试规则1：止损规则（AND）',
      enabled: true,
      target_level: 'ad',
      target_ids: adIds,  // 使用真实的广告ID
      conditions: [
        { metric: 'spend', operator: 'gt', value: spendThreshold, time_window: 'today' },
        { metric: 'purchases', operator: 'lt', value: purchasesThreshold, time_window: 'today' }
      ],
      logic_operator: 'AND',  // AND 逻辑：所有条件都必须满足
      timezone_name: timezoneName,
      actions: [
        { type: 'pause_ad' }
      ]
    }
    
    try {
      // 调用新版本的 evaluateRule（传入 accountId，从数据库查询数据）
      const matchedAds1 = await ruleEngine.evaluateRule(rule1, accountId)
      
      console.log(`✅ 规则评估完成，匹配到 ${matchedAds1.length} 个广告`)
      if (matchedAds1.length > 0) {
        console.log('📊 匹配的广告:')
        matchedAds1.forEach((ad, index) => {
          console.log(`\n   广告 ${index + 1}:`)
          console.log(`     ad_id: ${ad.ad_id}`)
          console.log(`     ad_name: ${ad.ad_name || '(无名称)'}`)
          console.log(`     spend: $${ad.metrics.spend} (条件: > $${spendThreshold}) ✅`)
          console.log(`     purchases: ${ad.metrics.purchases} (条件: < ${purchasesThreshold}) ✅`)
          console.log(`     cpc: ${ad.metrics.cpc != null ? '$' + ad.metrics.cpc.toFixed(4) : '(null)'}`)
          console.log(`     roas: ${ad.metrics.roas != null ? ad.metrics.roas.toFixed(4) : '(null)'}`)
        })
      } else {
        console.log('⚠️  没有广告满足条件')
        // 显示为什么没有匹配
        if (actualData.length > 0) {
          console.log('   原因分析:')
          actualData.forEach((ad, index) => {
            const spendOk = ad.spend > spendThreshold
            const purchasesOk = ad.purchases < purchasesThreshold
            console.log(`     广告 ${index + 1} (${ad.ad_id}):`)
            console.log(`       spend: $${ad.spend} ${spendOk ? '✅' : '❌'} (需要 > $${spendThreshold})`)
            console.log(`       purchases: ${ad.purchases} ${purchasesOk ? '✅' : '❌'} (需要 < ${purchasesThreshold})`)
            console.log(`       结果: ${spendOk && purchasesOk ? '✅ 满足' : '❌ 不满足'} (AND 需要两个都满足)`)
          })
        }
      }
    } catch (error) {
      console.error(`❌ 规则评估失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 第六步：测试规则2 - OR 逻辑（根据实际数据调整阈值）
    // ============================================
    console.log('📋 第六步：测试规则2 - OR 逻辑（根据实际数据调整阈值）...')
    
    // 根据实际数据动态调整阈值
    let spendThreshold2 = 30
    let roasThreshold = 1.5
    if (actualData.length > 0) {
      const maxSpend = Math.max(...actualData.map(ad => ad.spend || 0))
      const minRoas = Math.min(...actualData.map(ad => ad.roas || 999).filter(r => r > 0))
      spendThreshold2 = Math.max(1, Math.floor(maxSpend * 0.5))  // 50% 的最大值
      roasThreshold = Math.max(0.1, minRoas * 1.2)  // 最小值的 1.2 倍
      console.log(`   调整阈值：spend > $${spendThreshold2} OR roas < ${roasThreshold.toFixed(2)}`)
    }
    
    const rule2 = {
      id: 'test_rule_2',
      ruleName: '测试规则2：扩量规则（OR）',
      enabled: true,
      target_level: 'ad',
      target_ids: adIds,
      conditions: [
        { metric: 'spend', operator: 'gt', value: spendThreshold2, time_window: 'today' },
        { metric: 'roas', operator: 'lt', value: roasThreshold, time_window: 'today' }
      ],
      logic_operator: 'OR',  // OR 逻辑：至少一个条件满足
      timezone_name: timezoneName,
      actions: [
        { type: 'increase_budget', value: 20 }  // 增加20%预算
      ]
    }
    
    try {
      const matchedAds2 = await ruleEngine.evaluateRule(rule2, accountId)
      
      console.log(`✅ 规则评估完成，匹配到 ${matchedAds2.length} 个广告`)
      if (matchedAds2.length > 0) {
        console.log('📊 匹配的广告:')
        matchedAds2.forEach((ad, index) => {
          const spendOk = ad.metrics.spend > spendThreshold2
          const roasOk = ad.metrics.roas != null && ad.metrics.roas < roasThreshold
          console.log(`\n   广告 ${index + 1}:`)
          console.log(`     ad_id: ${ad.ad_id}`)
          console.log(`     spend: $${ad.metrics.spend} ${spendOk ? '✅' : '❌'} (条件: > $${spendThreshold2})`)
          console.log(`     roas: ${ad.metrics.roas != null ? ad.metrics.roas.toFixed(4) : '(null)'} ${roasOk ? '✅' : '❌'} (条件: < ${roasThreshold.toFixed(2)})`)
          console.log(`     结果: ${spendOk || roasOk ? '✅ 满足' : '❌ 不满足'} (OR 只需要一个满足)`)
        })
      } else {
        console.log('⚠️  没有广告满足条件')
        // 显示为什么没有匹配
        if (actualData.length > 0) {
          console.log('   原因分析:')
          actualData.forEach((ad, index) => {
            const spendOk = ad.spend > spendThreshold2
            const roasOk = ad.roas != null && ad.roas < roasThreshold
            console.log(`     广告 ${index + 1} (${ad.ad_id}):`)
            console.log(`       spend: $${ad.spend} ${spendOk ? '✅' : '❌'} (需要 > $${spendThreshold2})`)
            console.log(`       roas: ${ad.roas != null ? ad.roas.toFixed(4) : '(null)'} ${roasOk ? '✅' : '❌'} (需要 < ${roasThreshold.toFixed(2)})`)
            console.log(`       结果: ${spendOk || roasOk ? '✅ 满足' : '❌ 不满足'} (OR 只需要一个满足)`)
          })
        }
      }
    } catch (error) {
      console.error(`❌ 规则评估失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 第七步：测试规则3 - 时间窗口（yesterday）
    // ============================================
    console.log('📋 第七步：测试规则3 - 时间窗口（yesterday）...')
    
    const rule3 = {
      id: 'test_rule_3',
      ruleName: '测试规则3：昨日数据查询',
      enabled: true,
      target_level: 'ad',
      target_ids: adIds.slice(0, 1),  // 只测试第一个广告
      conditions: [
        { metric: 'spend', operator: 'gt', value: 0, time_window: 'yesterday' }
      ],
      logic_operator: 'AND',
      timezone_name: timezoneName,
      actions: []
    }
    
    try {
      const matchedAds3 = await ruleEngine.evaluateRule(rule3, accountId)
      
      console.log(`✅ 规则评估完成，匹配到 ${matchedAds3.length} 个广告`)
      if (matchedAds3.length > 0) {
        console.log('📊 匹配的广告（昨日数据）:')
        matchedAds3.forEach((ad, index) => {
          console.log(`\n   广告 ${index + 1}:`)
          console.log(`     ad_id: ${ad.ad_id}`)
          console.log(`     spend: $${ad.metrics.spend}`)
        })
      } else {
        console.log('⚠️  没有广告满足条件（可能是昨日没有数据，或 daily_stats 未归档）')
      }
    } catch (error) {
      console.error(`❌ 规则评估失败: ${error.message}`)
      console.error(error.stack)
    }
    console.log()
    
    // ============================================
    // 测试完成
    // ============================================
    console.log('✅ 所有测试完成！')
    console.log('\n📝 验证要点:')
    console.log('   1. AND 逻辑：所有条件都必须满足')
    console.log('   2. OR 逻辑：至少一个条件满足')
    console.log('   3. 时间窗口：支持 today、yesterday、last_3_days 等')
    console.log('   4. 目标筛选：支持 target_level 和 target_ids')
    console.log('   5. 数据来源：从数据库查询（完全离线）')
    
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
testRuleEngine()

