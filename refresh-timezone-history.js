/**
 * 历史时区刷新工具（一次性任务）
 * 
 * 功能：统一刷新 daily_stats 表中账户的历史时区，修复时区不一致问题
 * 
 * 使用方法：
 * node refresh-timezone-history.js [accountId]
 * 
 * 如果不提供 accountId，将刷新所有活跃账户的历史时区
 */

import pool from './server/db/connection.js'
import { refreshAccountTimezoneHistory } from './server/services/ingestorService.js'

const TARGET_ACCOUNT_ID = process.argv[2] || null  // 从命令行参数获取账户ID

async function main() {
  console.log('🔄 开始历史时区刷新任务')
  console.log('='.repeat(60))
  
  try {
    if (TARGET_ACCOUNT_ID) {
      // 刷新指定账户
      console.log(`📋 刷新账户: ${TARGET_ACCOUNT_ID}`)
      const result = await refreshAccountTimezoneHistory(TARGET_ACCOUNT_ID)
      console.log(`\n✅ 刷新完成:`)
      console.log(`   - 更新记录数: ${result.updatedCount}`)
    } else {
      // 刷新所有活跃账户
      console.log('📋 刷新所有活跃账户的历史时区...')
      
      const [accounts] = await pool.query(`
        SELECT fb_account_id as account_id, COALESCE(timezone_name, 'UTC') as timezone_name
        FROM account_mappings
        WHERE is_active = 1
        ORDER BY fb_account_id
      `)
      
      if (accounts.length === 0) {
        console.log('⚠️  没有找到活跃账户')
        return
      }
      
      console.log(`📋 找到 ${accounts.length} 个活跃账户\n`)
      
      let totalUpdated = 0
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i]
        const accountId = account.account_id
        const timezoneName = account.timezone_name
        
        try {
          console.log(`[${i + 1}/${accounts.length}] 刷新账户 ${accountId}...`)
          const result = await refreshAccountTimezoneHistory(accountId, timezoneName)
          totalUpdated += result.updatedCount || 0
          
          if (result.updatedCount > 0) {
            console.log(`   ✅ 更新 ${result.updatedCount} 条记录`)
          } else {
            console.log(`   ⏸️  无需更新（时区已一致）`)
          }
        } catch (error) {
          console.error(`   ❌ 刷新失败:`, error.message)
        }
        
        // 账户之间休眠
        if (i < accounts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      
      console.log(`\n✅ 所有账户刷新完成`)
      console.log(`📊 统计:`)
      console.log(`   - 账户总数: ${accounts.length}`)
      console.log(`   - 总更新记录数: ${totalUpdated}`)
    }
    
  } catch (error) {
    console.error('\n❌ 刷新失败:', error.message)
    if (error.stack) {
      console.error('   堆栈:', error.stack.split('\n').slice(0, 5).join('\n'))
    }
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

