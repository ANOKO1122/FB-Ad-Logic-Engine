import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import logger from '../utils/logger.js'

dotenv.config()

// 创建原始连接池
// connectionLimit: 多人并发使用场景下，10 可能不够，增加到 25
// 计算依据：10-15 人同时使用，每人可能同时发 1-2 个请求
const rawPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'fb_ad_brain',
  waitForConnections: true,
  connectionLimit: 25,  // 从 10 增加到 25，支持多人并发
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
})

/**
 * 为数据库连接设置会话时区为 UTC
 * 时区处理原则：
 * - 存储：统一使用 UTC（+00:00）
 * - 规则判断：后端转成广告账户时区
 * - 日志显示：前端转成浏览器本地时区
 * 
 * @param {Object} connection - mysql2 连接对象
 * @returns {Promise<void>}
 */
async function setConnectionTimezone(connection) {
  try {
    // 设置会话时区为 UTC
    await connection.execute("SET time_zone = '+00:00'")
  } catch (error) {
    // 如果设置失败，记录警告但不阻断连接（优雅降级）
    logger.warn('设置数据库会话时区失败', { message: error.message })
  }
}

/**
 * 包装的 pool.execute 方法
 * 在每次执行 SQL 前，先设置会话时区为 UTC
 */
const originalExecute = rawPool.execute.bind(rawPool)
rawPool.execute = async function(sql, params) {
  const connection = await rawPool.getConnection()
  try {
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
  const connection = await rawPool.getConnection()
  try {
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
 */
const originalGetConnection = rawPool.getConnection.bind(rawPool)
rawPool.getConnection = async function() {
  const connection = await originalGetConnection()
  await setConnectionTimezone(connection)
  return connection
}

// 启动时测试连接并验证时区设置
rawPool.getConnection()
  .then(async conn => {
    logger.info('数据库连接成功')
    try {
      const [rows] = await conn.execute("SELECT @@session.time_zone as session_tz")
      const sessionTz = rows[0]?.session_tz
      if (sessionTz === '+00:00' || sessionTz === 'UTC') {
        logger.info('数据库会话时区已设置为 UTC')
      } else {
        logger.warn('数据库会话时区与预期不符', { sessionTz, expected: 'UTC' })
      }
    } catch (err) {
      logger.warn('验证会话时区失败', { message: err.message })
    }
    conn.release()
  })
  .catch(err => {
    logger.error('数据库连接失败', { message: err.message })
  })

// 导出包装后的连接池
export default rawPool



