/**
 * 强制释放统一心跳锁（紧急修复脚本）
 * 
 * 使用场景：
 * - 进程异常退出导致锁未释放
 * - 确认没有其他进程在使用锁时，手动释放
 * 
 * 使用方法：
 * node server/scripts/force-release-heartbeat-lock.js
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

const HEARTBEAT_LOCK_NAME = 'fb_ad_brain:unified_heartbeat'

async function forceReleaseLock() {
  let connection = null
  
  try {
    // 创建数据库连接
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'fb_ad',
      password: process.env.DB_PASS || '123456',
      database: process.env.DB_NAME || 'fb_ad_brain'
    })
    
    console.log('🔍 检查锁状态...')
    
    // 检查锁是否被占用
    const [lockStatus] = await connection.query(
      `SELECT IS_FREE_LOCK(?) AS is_free, IS_USED_LOCK(?) AS is_used`,
      [HEARTBEAT_LOCK_NAME, HEARTBEAT_LOCK_NAME]
    )
    
    const isFree = lockStatus[0]?.is_free === 1
    const isUsed = lockStatus[0]?.is_used === 1
    
    console.log(`📊 锁状态:`)
    console.log(`   - 锁名称: ${HEARTBEAT_LOCK_NAME}`)
    console.log(`   - 是否空闲: ${isFree ? '✅ 是' : '❌ 否'}`)
    console.log(`   - 是否被占用: ${isUsed ? '✅ 是' : '❌ 否'}`)
    
    if (isFree) {
      console.log('✅ 锁已经是空闲状态，无需释放')
      return
    }
    
    if (!isUsed) {
      console.log('⚠️  锁状态异常，尝试强制释放...')
    }
    
    // 尝试释放锁
    console.log('🔓 尝试释放锁...')
    const [releaseResult] = await connection.query(
      `SELECT RELEASE_LOCK(?) AS released`,
      [HEARTBEAT_LOCK_NAME]
    )
    
    const released = releaseResult[0]?.released === 1
    
    if (released) {
      console.log('✅ 锁已成功释放')
    } else {
      console.log('❌ 锁释放失败（可能锁不属于当前连接）')
      console.log('💡 提示：如果锁被其他连接占用，需要等待该连接释放或重启 MySQL')
    }
    
    // 再次检查锁状态
    const [finalStatus] = await connection.query(
      `SELECT IS_FREE_LOCK(?) AS is_free`,
      [HEARTBEAT_LOCK_NAME]
    )
    
    const finalIsFree = finalStatus[0]?.is_free === 1
    
    if (finalIsFree) {
      console.log('✅ 最终状态：锁已释放')
    } else {
      console.log('⚠️  最终状态：锁仍被占用')
      console.log('💡 建议：')
      console.log('   1. 检查是否有其他后端进程在运行')
      console.log('   2. 检查是否有定时任务在运行')
      console.log('   3. 如果确认没有进程在使用，可以重启 MySQL 服务')
    }
    
  } catch (error) {
    console.error('❌ 释放锁失败:', error.message)
    throw error
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

// 执行
forceReleaseLock()
  .then(() => {
    console.log('✅ 脚本执行完成')
    process.exit(0)
  })
  .catch(error => {
    console.error('❌ 脚本执行失败:', error)
    process.exit(1)
  })
