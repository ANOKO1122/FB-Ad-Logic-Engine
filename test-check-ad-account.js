// 检查广告的账户归属
// 目的：验证广告是否真的属于指定账户

import pool from './server/db/connection.js'

async function checkAdAccount() {
  try {
    const accountId = process.argv[2] || 'act_927139705822379'
    const adId = process.argv[3] || '120240158513030388'
    
    console.log('🔍 检查广告账户归属...\n')
    console.log(`账户ID: ${accountId}`)
    console.log(`广告ID: ${adId}\n`)
    
    // 1. 从 ad_snapshots 表查询
    console.log('📋 第一步：从 ad_snapshots 表查询...')
    const [snapshots] = await pool.execute(
      `SELECT account_id, ad_id, ad_name, synced_at, spend, purchases
       FROM ad_snapshots
       WHERE ad_id = ?`,
      [adId]
    )
    
    if (snapshots.length === 0) {
      console.log('❌ 在 ad_snapshots 表中未找到该广告')
    } else {
      console.log(`✅ 找到 ${snapshots.length} 条记录:`)
      snapshots.forEach((row, i) => {
        console.log(`\n   记录 ${i + 1}:`)
        console.log(`     account_id: ${row.account_id}`)
        console.log(`     ad_id: ${row.ad_id}`)
        console.log(`     ad_name: ${row.ad_name}`)
        console.log(`     synced_at: ${row.synced_at}`)
        console.log(`     spend: $${row.spend}`)
        console.log(`     purchases: ${row.purchases}`)
        console.log(`     是否匹配账户: ${row.account_id === accountId ? '✅ 是' : '❌ 否'}`)
      })
    }
    console.log()
    
    // 2. 查询该账户下的所有广告
    console.log('📋 第二步：查询该账户下的所有广告...')
    const [allAds] = await pool.execute(
      `SELECT DISTINCT ad_id, ad_name, MAX(synced_at) as last_synced
       FROM ad_snapshots
       WHERE account_id = ?
       GROUP BY ad_id, ad_name
       ORDER BY last_synced DESC
       LIMIT 10`,
      [accountId]
    )
    
    console.log(`✅ 账户 ${accountId} 下有 ${allAds.length} 个广告:`)
    allAds.forEach((ad, i) => {
      const isTarget = ad.ad_id === adId
      console.log(`   ${i + 1}. ${ad.ad_id} - ${ad.ad_name} ${isTarget ? '← 目标广告' : ''}`)
    })
    console.log()
    
    // 3. 检查是否有其他账户也有这个广告ID
    console.log('📋 第三步：检查是否有其他账户也有这个广告ID...')
    const [otherAccounts] = await pool.execute(
      `SELECT DISTINCT account_id, COUNT(*) as count
       FROM ad_snapshots
       WHERE ad_id = ?
       GROUP BY account_id`,
      [adId]
    )
    
    if (otherAccounts.length === 0) {
      console.log('❌ 没有找到该广告的任何记录')
    } else if (otherAccounts.length === 1) {
      console.log(`✅ 该广告只属于一个账户: ${otherAccounts[0].account_id}`)
      console.log(`   是否匹配: ${otherAccounts[0].account_id === accountId ? '✅ 是' : '❌ 否'}`)
    } else {
      console.log(`⚠️  该广告属于多个账户:`)
      otherAccounts.forEach(acc => {
        console.log(`   - ${acc.account_id} (${acc.count} 条记录)`)
      })
    }
    console.log()
    
    await pool.end()
    process.exit(0)
  } catch (error) {
    console.error('❌ 检查失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

checkAdAccount()

