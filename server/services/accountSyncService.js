// 账户同步服务 - 从 Facebook API 同步账户列表到数据库
// 解决问题：避免每次页面刷新都调用 FB API 导致限流

import pool from '../db/connection.js'
import { FacebookMarketingAPI } from '../index.js'

/**
 * 从 Facebook API 同步账户列表到 account_mappings 表
 * 
 * 同步策略：
 * 1. 从 FB 获取当前用户可见的所有账户
 * 2. 更新已存在账户的名称
 * 3. 新账户自动入库（owner_id 设为 null，需要管理员手动分配）
 * 
 * @returns {Promise<Object>} 同步结果 { success, totalAccounts, newAccounts, updatedAccounts }
 */
export async function syncAccountsFromFacebook() {
  const startTime = Date.now()
  console.log('')
  console.log('='.repeat(50))
  console.log('🔄 开始同步 Facebook 账户列表到数据库')
  console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
  
  try {
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置，跳过同步')
      return { success: false, error: 'Token 未配置' }
    }
    
    // 1. 从 Facebook API 获取所有账户
    const api = new FacebookMarketingAPI(token)
    const fbAccounts = await api.getAdAccounts()
    
    console.log(`📊 从 Facebook 获取到 ${fbAccounts.length} 个账户`)
    
    let newCount = 0
    let updatedCount = 0
    
    // 2. 遍历账户，同步到数据库
    for (const acc of fbAccounts) {
      const accountId = acc.id || acc.account_id
      const accountName = acc.name || ''
      
      // 检查账户是否已存在
      const [existing] = await pool.execute(
        'SELECT id, fb_account_name FROM account_mappings WHERE fb_account_id = ?',
        [accountId]
      )
      
      if (existing.length === 0) {
        // 新账户：仅记录日志，不自动插入
        // 原因：owner_id 不允许为空，新账户需要管理员在"账户设置"页面手动添加并分配负责人
        console.log(`  ⚠️  发现新账户（未入库）: ${accountName} (${accountId})`)
        console.log(`     请在「账户设置」页面手动添加此账户并分配负责人`)
        newCount++
      } else if (existing[0].fb_account_name !== accountName) {
        // 已存在但名称变化：更新名称
        await pool.execute(
          'UPDATE account_mappings SET fb_account_name = ? WHERE fb_account_id = ?',
          [accountName, accountId]
        )
        console.log(`  🔄 更新账户名称: ${existing[0].fb_account_name} → ${accountName}`)
        updatedCount++
      }
    }
    
    const duration = Date.now() - startTime
    console.log(`✅ 账户同步完成 (耗时: ${duration}ms)`)
    console.log(`   FB 账户总数: ${fbAccounts.length}`)
    console.log(`   发现新账户: ${newCount} 个（需在「账户设置」手动添加）`)
    console.log(`   更新名称: ${updatedCount} 个`)
    console.log('='.repeat(50))
    console.log('')
    
    return {
      success: true,
      totalAccounts: fbAccounts.length,
      newAccounts: newCount,  // 发现的新账户数（需手动添加）
      updatedAccounts: updatedCount
    }
  } catch (error) {
    const duration = Date.now() - startTime
    console.error(`❌ 账户同步失败 (耗时: ${duration}ms):`, error.message)
    console.log('='.repeat(50))
    console.log('')
    
    return { success: false, error: error.message }
  }
}

/**
 * 从数据库获取账户列表（不调用 FB API）
 * 
 * 权限隔离：
 * - admin 用户：返回所有账户
 * - 普通用户：只返回自己负责的账户
 * 
 * @param {Object} user - 当前用户对象 { role, owner_id }
 * @returns {Promise<Array>} 账户列表 [{ id, name }]
 */
export async function getAccountsFromDatabase(user) {
  let sql
  let params = []
  
  if (user.role === 'admin') {
    // 管理员：获取所有活跃账户
    sql = `
      SELECT fb_account_id AS id, fb_account_name AS name, owner_id, timezone_name
      FROM account_mappings 
      WHERE is_active = 1
      ORDER BY fb_account_name
    `
  } else if (user.owner_id) {
    // 普通用户：只获取自己负责的账户
    sql = `
      SELECT fb_account_id AS id, fb_account_name AS name, owner_id, timezone_name
      FROM account_mappings 
      WHERE owner_id = ? AND is_active = 1
      ORDER BY fb_account_name
    `
    params = [user.owner_id]
  } else {
    // 没有 owner_id 的用户：返回空列表
    return []
  }
  
  const [rows] = await pool.execute(sql, params)
  return rows
}

