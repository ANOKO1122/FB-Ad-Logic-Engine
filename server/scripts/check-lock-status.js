/**
 * 检查统一心跳锁状态（诊断脚本）
 * 
 * 使用方法：
 * node server/scripts/check-lock-status.js
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

const HEARTBEAT_LOCK_NAME = 'fb_ad_brain:unified_heartbeat'

async function checkLockStatus() {
  let connection = null
  
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'fb_ad',
      password: process.env.DB_PASS || '123456',
      database: process.env.DB_NAME || 'fb_ad_brain'
    })
    
    console.log('🔍 检查统一心跳锁状态...\n')
    
    // 检查锁是否空闲
    const [freeStatus] = await connection.query(
      `SELECT IS_FREE_LOCK(?) AS is_free`,
      [HEARTBEAT_LOCK_NAME]
    )
    
    // 检查锁是否被占用
    const [usedStatus] = await connection.query(
      `SELECT IS_USED_LOCK(?) AS is_used`,
      [HEARTBEAT_LOCK_NAME]
    )
    
    // 尝试获取锁（不等待，立即返回）
    const [acquireStatus] = await connection.query(
      `SELECT GET_LOCK(?, 0) AS acquired`,
      [HEARTBEAT_LOCK_NAME]
    )
    
    const isFree = freeStatus[0]?.is_free === 1
    const isUsed = usedStatus[0]?.is_used === 1
    const acquired = acquireStatus[0]?.acquired === 1
    
    console.log('📊 锁状态诊断:')
    console.log(`   - 锁名称: ${HEARTBEAT_LOCK_NAME}`)
    console.log(`   - 是否空闲: ${isFree ? '✅ 是' : '❌ 否'}`)
    console.log(`   - 是否被占用: ${isUsed ? '✅ 是' : '❌ 否'}`)
    console.log(`   - 能否获取: ${acquired ? '✅ 能' : '❌ 不能'}`)
    
    if (acquired) {
      // 如果能获取，立即释放
      await connection.query(`SELECT RELEASE_LOCK(?)`, [HEARTBEAT_LOCK_NAME])
      console.log('   - 已释放测试锁')
    }
    
    console.log('\n💡 诊断结果:')
    if (isFree && !isUsed) {
      console.log('✅ 锁状态正常，可以正常使用')
    } else if (isUsed && !acquired) {
      console.log('⚠️  锁被占用，可能的原因:')
      console.log('   1. 有其他后端进程正在运行')
      console.log('   2. 之前的进程异常退出，锁未释放')
      console.log('   3. 数据库连接异常，锁未释放')
      console.log('\n🔧 解决方案:')
      console.log('   执行: node server/scripts/force-release-heartbeat-lock.js')
    } else {
      console.log('⚠️  锁状态异常，建议检查数据库连接')
    }
    
  } catch (error) {
    console.error('❌ 检查锁状态失败:', error.message)
    throw error
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

checkLockStatus()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('❌ 脚本执行失败:', error)
    process.exit(1)
  })
