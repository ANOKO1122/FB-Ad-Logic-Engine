/**
 * 诊断脚本：检查各账户的最新同步时间
 * 
 * 功能：
 * 1. 查询所有账户的最新同步时间
 * 2. 对比当前时间，找出哪些账户需要同步
 * 3. 显示最近同步的账户
 * 
 * 使用方法：
 * node test-check-sync-times.js
 */

import pool from './server/db/connection.js'
import dotenv from 'dotenv'

dotenv.config()

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('🔍 检查各账户的最新同步时间')
  console.log('='.repeat(60))
  console.log('')
  
  try {
    // 1. 查询所有账户的最新同步时间
    console.log('📊 步骤 1：查询所有账户的最新同步时间...')
    const [accounts] = await pool.query(`
      SELECT 
        am.fb_account_id as account_id,
        am.owner_id,
        am.timezone_name,
        am.is_active,
        MAX(s.synced_at) as last_sync_time,
        COUNT(DISTINCT s.ad_id) as ad_count,
        SUM(s.spend) as total_spend
      FROM account_mappings am
      LEFT JOIN ad_snapshots s ON am.fb_account_id = s.account_id
        AND DATE(s.synced_at) = CURDATE()
      WHERE am.is_active = 1
      GROUP BY am.fb_account_id, am.owner_id, am.timezone_name, am.is_active
      ORDER BY last_sync_time DESC
    `)
    
    console.log(`✅ 找到 ${accounts.length} 个活跃账户`)
    console.log('')
    
    if (accounts.length === 0) {
      console.log('⚠️  没有找到活跃账户')
      process.exit(0)
    }
    
    // 2. 显示各账户的同步时间
    console.log('📊 步骤 2：各账户最新同步时间:')
    console.log('='.repeat(60))
    console.log('')
    
    const now = new Date()
    let recentSyncCount = 0
    let oldSyncCount = 0
    let noSyncCount = 0
    
    accounts.forEach((account, index) => {
      const accountId = account.account_id
      const lastSyncTime = account.last_sync_time
      const adCount = parseInt(account.ad_count) || 0
      const totalSpend = parseFloat(account.total_spend) || 0
      
      if (!lastSyncTime) {
        noSyncCount++
        console.log(`${index + 1}. ${accountId}`)
        console.log(`   ⚠️  今天没有同步记录`)
        console.log(`   广告数: ${adCount}`)
        console.log('')
        return
      }
      
      const syncTime = new Date(lastSyncTime)
      const timeDiffMinutes = Math.floor((now - syncTime) / (1000 * 60))
      const timeDiffHours = Math.floor(timeDiffMinutes / 60)
      const timeDiffDays = Math.floor(timeDiffHours / 24)
      
      // 判断是否最近同步（30 分钟内）
      const isRecent = timeDiffMinutes <= 30
      
      if (isRecent) {
        recentSyncCount++
      } else if (timeDiffMinutes <= 180) {
        oldSyncCount++
      } else {
        oldSyncCount++
      }
      
      console.log(`${index + 1}. ${accountId}`)
      console.log(`   最新同步: ${lastSyncTime}`)
      
      if (timeDiffDays > 0) {
        console.log(`   时间差: ${timeDiffDays} 天 ${timeDiffHours % 24} 小时 ${timeDiffMinutes % 60} 分钟前`)
      } else if (timeDiffHours > 0) {
        console.log(`   时间差: ${timeDiffHours} 小时 ${timeDiffMinutes % 60} 分钟前`)
      } else {
        console.log(`   时间差: ${timeDiffMinutes} 分钟前`)
      }
      
      if (isRecent) {
        console.log(`   ✅ 最近同步（30 分钟内）`)
      } else if (timeDiffMinutes <= 180) {
        console.log(`   ⚠️  同步时间较旧（30-180 分钟）`)
      } else {
        console.log(`   ❌ 同步时间过旧（超过 180 分钟）`)
      }
      
      console.log(`   广告数: ${adCount}`)
      const spendValue = parseFloat(totalSpend) || 0
      console.log(`   总花费: ${spendValue.toFixed(2)}`)
      console.log('')
    })
    
    // 3. 汇总统计
    console.log('='.repeat(60))
    console.log('📊 汇总统计:')
    console.log('='.repeat(60))
    console.log(`   总账户数: ${accounts.length}`)
    console.log(`   ✅ 最近同步（30 分钟内）: ${recentSyncCount} 个`)
    console.log(`   ⚠️  同步时间较旧（30-180 分钟）: ${oldSyncCount} 个`)
    console.log(`   ❌ 今天没有同步: ${noSyncCount} 个`)
    console.log('')
    
    // 4. 找出最近同步的账户
    const recentAccounts = accounts.filter(account => {
      if (!account.last_sync_time) return false
      const syncTime = new Date(account.last_sync_time)
      const timeDiffMinutes = Math.floor((now - syncTime) / (1000 * 60))
      return timeDiffMinutes <= 30
    })
    
    if (recentAccounts.length > 0) {
      console.log('='.repeat(60))
      console.log('📊 最近同步的账户（30 分钟内）:')
      console.log('='.repeat(60))
      recentAccounts.forEach((account, index) => {
        const syncTime = new Date(account.last_sync_time)
        const timeDiffMinutes = Math.floor((now - syncTime) / (1000 * 60))
        console.log(`${index + 1}. ${account.account_id}`)
        console.log(`   同步时间: ${account.last_sync_time}`)
        console.log(`   时间差: ${timeDiffMinutes} 分钟前`)
        console.log(`   广告数: ${account.ad_count || 0}`)
        console.log('')
      })
    }
    
    // 5. 找出最旧的同步账户
    const oldAccounts = accounts
      .filter(account => account.last_sync_time)
      .sort((a, b) => new Date(a.last_sync_time) - new Date(b.last_sync_time))
      .slice(0, 5)
    
    if (oldAccounts.length > 0) {
      console.log('='.repeat(60))
      console.log('📊 同步时间最旧的账户（前 5 个）:')
      console.log('='.repeat(60))
      oldAccounts.forEach((account, index) => {
        const syncTime = new Date(account.last_sync_time)
        const timeDiffMinutes = Math.floor((now - syncTime) / (1000 * 60))
        console.log(`${index + 1}. ${account.account_id}`)
        console.log(`   同步时间: ${account.last_sync_time}`)
        console.log(`   时间差: ${timeDiffMinutes} 分钟前`)
        console.log(`   广告数: ${account.ad_count || 0}`)
        console.log('')
      })
    }
    
    // 6. 诊断结论
    console.log('='.repeat(60))
    console.log('📝 诊断结论:')
    console.log('='.repeat(60))
    
    if (recentAccounts.length === 0) {
      console.log('⚠️  没有账户在最近 30 分钟内同步')
      console.log('💡 建议:')
      console.log('   1. 检查定时任务是否正常运行')
      console.log('   2. 检查 cronService.js 中的定时任务配置')
      console.log('   3. 检查后端服务是否正常运行')
    } else if (recentAccounts.length < accounts.length) {
      console.log(`⚠️  只有 ${recentAccounts.length}/${accounts.length} 个账户在最近 30 分钟内同步`)
      console.log('💡 建议:')
      console.log('   1. 检查是否有账户同步失败')
      console.log('   2. 检查同步日志，查看失败原因')
      console.log('   3. 确认所有账户都有活跃广告')
    } else {
      console.log('✅ 所有账户都在最近 30 分钟内同步')
    }
    
    console.log('='.repeat(60))
    console.log('')
    
  } catch (error) {
    console.error('')
    console.error('='.repeat(60))
    console.error('❌ 诊断失败')
    console.error('='.repeat(60))
    console.error('')
    console.error('错误信息:', error.message)
    if (error.stack) {
      console.error('')
      console.error('错误堆栈:')
      console.error(error.stack.split('\n').slice(0, 10).join('\n'))
    }
    process.exit(1)
  } finally {
    // 关闭数据库连接
    try {
      await pool.end()
    } catch (err) {
      // 忽略关闭连接时的错误
    }
  }
}

// 执行主函数
main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

