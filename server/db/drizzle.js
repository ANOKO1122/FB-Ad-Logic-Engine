// Drizzle ORM 数据库连接配置（统一使用 connection.js 中的连接池）
// 目标：整个应用只有一份 MySQL 连接池配置（Single Source of Truth），
// 由 server/db/connection.js 负责创建和设置会话时区为 UTC，Drizzle 直接复用该连接池。

import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema.js'
import pool from './connection.js'

// 使用统一的连接池创建 Drizzle 实例
export const db = drizzle(pool, { schema, mode: 'default' })

// 如有需要，其他模块也可以通过此导出访问底层连接池
export const connection = pool
