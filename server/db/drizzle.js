// Drizzle ORM 数据库连接配置
// 注意：这是新功能使用的 ORM，旧代码继续使用 server/db/connection.js
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import * as schema from './schema.js'

dotenv.config()

// 创建 MySQL 连接（Drizzle 使用）
// 注意：createConnection() 返回 Promise，需要 await
// 但为了兼容性，我们使用连接池的方式（与旧代码保持一致）
const connection = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'fb_ad_brain',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
})

// 创建 Drizzle 实例
// drizzle() 函数接收连接池和 schema 配置
export const db = drizzle(connection, { schema, mode: 'default' })

// 导出连接池，用于关闭连接等操作
export { connection }

