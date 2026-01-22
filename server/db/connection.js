import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

// 创建原始连接池
const rawPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'fb_ad_brain',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
})

/**
 * 为数据库连接设置会话时区为 UTC
 * 为什么需要这个函数？
 * - MySQL 的 TIMESTAMP 类型会根据会话时区进行转换
 * - 如果会话时区与服务器时区不一致，会导致时间比较错位
 * - 统一设置为 UTC 可以确保所有时间比较都基于同一时区，避免错位
 * 
 * @param {Object} connection - mysql2 连接对象
 * @returns {Promise<void>}
 */
async function setConnectionTimezone(connection) {
  try {
    // 设置会话时区为 UTC（+00:00）
    // 这确保所有 TIMESTAMP/DATETIME 字段的比较都基于 UTC，不受服务器时区影响
    await connection.execute("SET time_zone = '+00:00'")
  } catch (error) {
    // 如果设置失败，记录警告但不阻断连接（优雅降级）
    console.warn('⚠️  设置数据库会话时区失败:', error.message)
  }
}

/**
 * 包装的 pool.execute 方法
 * 在每次执行 SQL 前，先设置会话时区为 UTC
 * 为什么需要包装？
 * - pool.execute 内部会自动获取和释放连接
 * - 我们需要在每次执行前设置时区，但无法直接拦截内部连接
 * - 解决方案：先获取连接，设置时区，然后执行 SQL，最后释放连接
 * 
 * 注意：这会改变连接池的行为，但确保每次执行前都设置时区
 */
const originalExecute = rawPool.execute.bind(rawPool)
rawPool.execute = async function(sql, params) {
  // 获取连接（手动管理，确保时区设置）
  const connection = await rawPool.getConnection()
  try {
    // 设置会话时区为 UTC（每次执行前都设置，确保时区正确）
    await setConnectionTimezone(connection)
    // 执行 SQL（使用连接的 execute 方法）
    return await connection.execute(sql, params)
  } finally {
    // 释放连接（必须释放，避免连接泄漏）
    connection.release()
  }
}

/**
 * 包装的 pool.query 方法
 * 在每次执行 SQL 前，先设置会话时区为 UTC
 */
const originalQuery = rawPool.query.bind(rawPool)
rawPool.query = async function(sql, params) {
  // 获取连接（手动管理，确保时区设置）
  const connection = await rawPool.getConnection()
  try {
    // 设置会话时区为 UTC（每次执行前都设置，确保时区正确）
    await setConnectionTimezone(connection)
    // 执行 SQL（使用连接的 query 方法）
    return await connection.query(sql, params)
  } finally {
    // 释放连接（必须释放，避免连接泄漏）
    connection.release()
  }
}

/**
 * 包装的 pool.getConnection 方法
 * 在每次获取连接后，立即设置时区为 UTC
 * 为什么需要包装？
 * - 有些代码可能直接使用 getConnection，需要确保时区设置
 */
const originalGetConnection = rawPool.getConnection.bind(rawPool)
rawPool.getConnection = async function() {
  const connection = await originalGetConnection()
  // 每次获取连接后，立即设置时区为 UTC
  await setConnectionTimezone(connection)
  return connection
}

// 启动时测试连接并验证时区设置（不阻断启动，只打印日志）
rawPool.getConnection()
  .then(async conn => {
    console.log('✅ 数据库连接成功')
    // 验证会话时区是否设置为 UTC
    try {
      const [rows] = await conn.execute("SELECT @@session.time_zone as session_tz")
      const sessionTz = rows[0]?.session_tz
      if (sessionTz === '+00:00' || sessionTz === '+00:00:00') {
        console.log('✅ 数据库会话时区已设置为 UTC')
      } else {
        console.warn(`⚠️  数据库会话时区为 ${sessionTz}，预期为 +00:00`)
      }
    } catch (err) {
      console.warn('⚠️  验证会话时区失败:', err.message)
    }
    conn.release()
  })
  .catch(err => {
    console.error('❌ 数据库连接失败:', err.message)
  })

// 导出包装后的连接池
export default rawPool



