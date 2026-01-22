// 验证数据聚合逻辑
// 目的：检查历史数据和今天数据是否正确聚合（同一广告应该合并为 1 条记录）

import { queryRuleData } from './server/services/ruleDataService.js'
import pool from './server/db/connection.js'

async function verifyAggregation() {
  try {
    console.log('🔍 验证数据聚合逻辑...\n')
    
    const accountId = 'act_927139705822379'
    
    // 1. 查询 last_7_days 数据
    console.log('📋 查询 last_7_days 数据...')
    console.log('='.repeat(60))
    
    const result = await queryRuleData(accountId, null, 'last_7_days', null, null)
    const data = result.data || result
    const warnings = result.warnings || []
    
    console.log(`✅ 查询成功，返回 ${Array.isArray(data) ? data.length : 0} 条记录`)
    
    // 2. 检查是否有重复的 ad_id（同一广告应该聚合为 1 条记录）
    const adIdSet = new Set()
    const duplicateAdIds = []
    
    if (Array.isArray(data)) {
      for (const record of data) {
        if (adIdSet.has(record.ad_id)) {
          duplicateAdIds.push(record.ad_id)
        } else {
          adIdSet.add(record.ad_id)
        }
      }
    }
    
    if (duplicateAdIds.length > 0) {
      console.log(`❌ 发现重复的 ad_id（聚合失败）: ${duplicateAdIds.join(', ')}`)
    } else {
      console.log(`✅ 没有重复的 ad_id，聚合正确`)
    }
    
    // 3. 检查 test_ad_123456（历史数据中的测试广告）
    console.log('\n📋 检查 test_ad_123456（历史数据中的测试广告）...')
    console.log('='.repeat(60))
    
    const testAd = data.find(r => r.ad_id === 'test_ad_123456')
    if (testAd) {
      console.log(`✅ 找到 test_ad_123456:`)
      console.log(`   spend: $${testAd.spend}`)
      console.log(`   purchases: ${testAd.purchases}`)
      console.log(`   roas: ${testAd.roas}`)
      console.log(`   cpa: $${testAd.cpa}`)
      
      // 检查今天数据中是否也有这个广告
      const [todayRows] = await pool.execute(`
        SELECT COUNT(*) as count
        FROM ad_snapshots
        WHERE account_id = ?
          AND ad_id = 'test_ad_123456'
          AND DATE(synced_at) = CURDATE()
      `, [accountId])
      
      if (todayRows[0].count > 0) {
        console.log(`   ⚠️  今天数据中也有这个广告（${todayRows[0].count} 条），应该聚合在一起`)
        
        // 检查历史数据
        const [historyRows] = await pool.execute(`
          SELECT spend, purchases, purchase_value
          FROM daily_stats
          WHERE account_id = ?
            AND ad_id = 'test_ad_123456'
        `, [accountId])
        
        if (historyRows.length > 0) {
          console.log(`   📊 历史数据: spend=$${historyRows[0].spend}, purchases=${historyRows[0].purchases}`)
          
          // 检查今天数据
          const [todayDataRows] = await pool.execute(`
            SELECT spend, purchases, purchase_value
            FROM ad_snapshots
            WHERE account_id = ?
              AND ad_id = 'test_ad_123456'
              AND DATE(synced_at) = CURDATE()
            ORDER BY synced_at DESC
            LIMIT 1
          `, [accountId])
          
          if (todayDataRows.length > 0) {
            console.log(`   📊 今天数据: spend=$${todayDataRows[0].spend}, purchases=${todayDataRows[0].purchases}`)
            
            // 计算期望的聚合值
            const expectedSpend = parseFloat(historyRows[0].spend || 0) + parseFloat(todayDataRows[0].spend || 0)
            const expectedPurchases = parseInt(historyRows[0].purchases || 0) + parseInt(todayDataRows[0].purchases || 0)
            
            console.log(`   📊 期望聚合值: spend=$${expectedSpend}, purchases=${expectedPurchases}`)
            console.log(`   📊 实际聚合值: spend=$${testAd.spend}, purchases=${testAd.purchases}`)
            
            if (Math.abs(testAd.spend - expectedSpend) < 0.01 && testAd.purchases === expectedPurchases) {
              console.log(`   ✅ 聚合值正确！`)
            } else {
              console.log(`   ❌ 聚合值不匹配！`)
            }
          }
        }
      } else {
        console.log(`   ✅ 今天数据中没有这个广告，只返回历史数据（正常）`)
      }
    } else {
      console.log(`   ⚠️  没有找到 test_ad_123456（可能被过滤了）`)
    }
    
    // 4. 显示所有广告的 ad_id
    console.log('\n📋 所有广告的 ad_id:')
    console.log('='.repeat(60))
    if (Array.isArray(data)) {
      data.forEach((record, index) => {
        console.log(`   ${index + 1}. ${record.ad_id} - ${record.ad_name || 'N/A'}`)
      })
    }
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 验证完成！')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

verifyAggregation()

