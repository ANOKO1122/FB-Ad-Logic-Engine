// 一次性同步所有账户的时区信息脚本
// 使用方法：node server/scripts/sync-all-timezones.js
// 
// 【AdsPolar策略】时区是静态数据，应该缓存在数据库中
// 这个脚本用于初始化或更新所有账户的时区信息
// 后续同步任务将优先使用数据库中的时区，避免每次查询API

import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'
import pLimit from 'p-limit'

// 受控并发配置
const CONCURRENT_LIMIT = 8
const timezoneSyncLimiter = pLimit(CONCURRENT_LIMIT)

console.log('')
console.log('='.repeat(50))
console.log('🌍 同步所有账户的时区信息')
console.log('='.repeat(50))
console.log('')

try {
  // 1. 获取所有活跃账户
  const [accounts] = await pool.query(`
    SELECT DISTINCT fb_account_id as account_id, owner_id, COALESCE(timezone_name, 'UTC') as timezone_name
    FROM account_mappings 
    WHERE is_active = 1
    ORDER BY fb_account_id
  `)
  
  if (!accounts || accounts.length === 0) {
    console.log('⚠️  没有找到活跃账户，跳过同步')
    process.exit(0)
  }
  
  console.log(`📋 找到 ${accounts.length} 个活跃账户`)
  console.log(`🚀 使用受控并发模式（并发度 = ${CONCURRENT_LIMIT}）`)
  console.log('')
  
  // 2. 创建 Facebook API 客户端实例
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
  }
  const facebookApi = new FacebookMarketingAPI(accessToken)
  
  // 3. 并发同步所有账户的时区
  const syncTasks = accounts.map((account, index) => 
    timezoneSyncLimiter(async () => {
      const accountId = String(account.account_id || '')
      const ownerId = account.owner_id || account.ownerId
      const currentTimezone = account.timezone_name || 'UTC'
      
      if (!accountId || !ownerId) {
        console.warn(`⚠️  跳过无效账户: account_id=${accountId}, owner_id=${ownerId}`)
        return { accountId, success: false, error: '无效账户' }
      }
      
      try {
        console.log(`[${index + 1}/${accounts.length}] 同步账户 ${accountId} 的时区...`)
        console.log(`   当前时区: ${currentTimezone}`)
        
        // 从 Facebook API 获取时区
        const apiTimezone = await facebookApi.getAccountTimezone(accountId)
        
        if (!apiTimezone || apiTimezone === 'UTC') {
          console.warn(`   ⚠️  API返回时区为UTC或失败，保持当前时区: ${currentTimezone}`)
          return { accountId, success: false, error: 'API返回UTC或失败', timezone: currentTimezone }
        }
        
        // 如果时区不一致，更新数据库
        if (currentTimezone !== apiTimezone) {
          console.log(`   📝 时区不一致：${currentTimezone} → ${apiTimezone}，更新数据库...`)
          try {
            await pool.execute(
              `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?`,
              [apiTimezone, accountId]
            )
            console.log(`   ✅ 已更新时区: ${apiTimezone}`)
            return { accountId, success: true, timezone: apiTimezone, updated: true }
          } catch (updateError) {
            console.error(`   ❌ 更新时区失败: ${updateError.message}`)
            return { accountId, success: false, error: updateError.message, timezone: currentTimezone }
          }
        } else {
          console.log(`   ✅ 时区一致，无需更新: ${apiTimezone}`)
          return { accountId, success: true, timezone: apiTimezone, updated: false }
        }
      } catch (error) {
        console.error(`   ❌ 同步账户 ${accountId} 时区失败: ${error.message}`)
        // 如果API查询失败，不更新数据库，保持原有时区
        return { accountId, success: false, error: error.message, timezone: currentTimezone }
      }
    })
  )
  
  // 4. 等待所有任务完成
  const results = await Promise.all(syncTasks)
  
  // 5. 统计结果
  const successCount = results.filter(r => r.success).length
  const updatedCount = results.filter(r => r.success && r.updated).length
  const failedCount = results.filter(r => !r.success).length
  
  console.log('')
  console.log('='.repeat(50))
  console.log(`✅ 时区同步完成`)
  console.log(`📊 统计:`)
  console.log(`   - 账户总数: ${accounts.length}`)
  console.log(`   - 同步成功: ${successCount} 个`)
  console.log(`   - 更新时区: ${updatedCount} 个`)
  console.log(`   - 同步失败: ${failedCount} 个`)
  
  if (failedCount > 0) {
    console.log('')
    console.log('⚠️  失败的账户详情:')
    results.filter(r => !r.success).forEach(r => {
      console.log(`   - ${r.accountId}: ${r.error || '未知错误'}`)
    })
  }
  
  console.log('='.repeat(50))
  console.log('')
  
  process.exit(0)
} catch (error) {
  console.error('')
  console.error('='.repeat(50))
  console.error('❌ 执行失败:', error.message)
  console.error('错误堆栈:', error.stack)
  console.error('='.repeat(50))
  process.exit(1)
}

