// Drizzle ORM 数据库连接配置
// 注意：这是新功能使用的 ORM，旧代码继续使用 server/db/connection.js
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import * as schema from './schema.js'
import logger from '../utils/logger.js'

dotenv.config()

// 创建 MySQL 连接（Drizzle 使用）
// 时区原则：存 UTC，算 账户时区，看 浏览器本地时区
const rawPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'fb_ad_brain',
  waitForConnections: true,
  connectionLimit: 25,
  queueLimit: 0,
  timezone: '+00:00'  // 客户端 JS Date 编码/解码按 UTC，与 session time_zone 一致
})

/**
 * 为数据库连接设置会话时区为 UTC
 * 保证 automation_logs.triggered_at 等 TIMESTAMP 写入时按 UTC 解释，与 rule_execution_summaries.evaluated_at 对齐
 */
async function setConnectionTimezone(conn) {
  try {
    await conn.execute("SET time_zone = '+00:00'")
  } catch (e) {
    logger.warn('Drizzle 设置会话时区失败', { message: e.message })
  }
}

const _getConnection = rawPool.getConnection.bind(rawPool)

/**
 * 获取已设置 UTC 时区的连接（用于长时间持有连接的场景）
 */
async function getUtcConnection() {
  const conn = await _getConnection()
  await setConnectionTimezone(conn)
  return conn
}

// 包装 execute：每次执行前 SET time_zone，杜绝偶发非 UTC session
const _execute = rawPool.execute.bind(rawPool)
rawPool.execute = async function (sql, params) {
  const conn = await getUtcConnection()
  try {
    return await conn.execute(sql, params)
  } finally {
    conn.release()
  }
}

// 包装 query：每次执行前 SET time_zone
const _query = rawPool.query.bind(rawPool)
rawPool.query = async function (sql, params) {
  const conn = await getUtcConnection()
  try {
    return await conn.query(sql, params)
  } finally {
    conn.release()
  }
}

// 包装 getConnection：返回前已 SET time_zone
rawPool.getConnection = async function () {
  return getUtcConnection()
}

const connection = rawPool

// 创建 Drizzle 实例
// drizzle() 函数接收连接池和 schema 配置
export const db = drizzle(connection, { schema, mode: 'default' })

// 导出连接池，用于关闭连接等操作
export { connection }

