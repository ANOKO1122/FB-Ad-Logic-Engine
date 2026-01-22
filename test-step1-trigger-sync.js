/**
 * 验证步骤 1：手动触发一次数据同步，验证时区是否正确更新
 * 
 * 这个脚本对应截图中的第一步验证步骤
 * 
 * 使用方法：
 * node test-step1-trigger-sync.js
 */

import { syncAccountTodayStats } from './server/services/ingestorService.js'
import pool from './server/db/connection.js'

// 测试账户ID（根据你的实际情况修改）
const TEST_ACCOUNT_ID = 'act_927139705822379'
const OWNER_ID = 1  // 如果不知道 owner_id，脚本会自动查询

async function main() {
  console.log('🚀 步骤 1：手动触发数据同步')
  console.log('='.repeat(60))
  console.log(`📋 账户ID: ${TEST_ACCOUNT_ID}`)
  
  try {
    // 如果不知道 owner_id，先从数据库查询
    let ownerId = OWNER_ID
    if (!ownerId) {
      console.log('📋 查询账户的 owner_id...')
      const [rows] = await pool.query(`
        SELECT owner_id 
        FROM account_mappings 
        WHERE fb_account_id = ?
      `, [TEST_ACCOUNT_ID])
      
      if (rows.length === 0) {
        throw new Error(`账户 ${TEST_ACCOUNT_ID} 不存在于 account_mappings 表中`)
      }
      
      ownerId = rows[0].owner_id
      console.log(`✅ 找到 owner_id: ${ownerId}`)
    }
    
    // 查询当前时区配置（用于对比）
    const [accountRows] = await pool.query(`
      SELECT timezone_name 
      FROM account_mappings 
      WHERE fb_account_id = ?
    `, [TEST_ACCOUNT_ID])
    
    const currentTimezone = accountRows[0]?.timezone_name || null
    console.log(`📋 当前数据库时区配置: ${currentTimezone || '(NULL)'}`)
    console.log(`📋 传入时区参数: null (将从 Facebook API 获取最新时区)`)
    
    console.log('\n' + '='.repeat(60))
    console.log('🔄 开始同步...')
    console.log('='.repeat(60) + '\n')
    
    // 执行同步（传入 null 表示从 API 获取时区）
    const result = await syncAccountTodayStats(TEST_ACCOUNT_ID, ownerId, null)
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 同步完成')
    console.log('='.repeat(60))
    console.log(`📋 同步结果:`)
    console.log(`   会话ID: ${result.sessionId}`)
    console.log(`   同步记录数: ${result.syncedCount}`)
    console.log(`   成功: ${result.success ? '是' : '否'}`)
    
    // 查询更新后的时区配置
    const [updatedRows] = await pool.query(`
      SELECT timezone_name 
      FROM account_mappings 
      WHERE fb_account_id = ?
    `, [TEST_ACCOUNT_ID])
    
    const updatedTimezone = updatedRows[0]?.timezone_name || null
    console.log(`\n📋 更新后数据库时区配置: ${updatedTimezone || '(NULL)'}`)
    
    if (currentTimezone !== updatedTimezone) {
      console.log(`\n✅ 时区已更新: ${currentTimezone || 'NULL'} → ${updatedTimezone || 'NULL'}`)
    } else if (updatedTimezone && updatedTimezone !== 'UTC') {
      console.log(`\n✅ 时区已正确配置: ${updatedTimezone}`)
    } else {
      console.log(`\n⚠️  时区未更新或仍为默认值`)
    }
    
    console.log('\n' + '='.repeat(60))
    console.log('📝 下一步：')
    console.log('   请执行步骤 2 和步骤 3 的 SQL 查询来验证时区更新')
    console.log('='.repeat(60))
    
  } catch (error) {
    console.error('\n❌ 同步失败:', error.message)
    if (error.stack) {
      console.error('   堆栈:', error.stack.split('\n').slice(0, 5).join('\n'))
    }
    process.exit(1)
  } finally {
    // 关闭数据库连接
    await pool.end()
  }
}

// 执行主函数
main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

