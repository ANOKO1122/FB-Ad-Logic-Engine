// 验证数据库会话时区设置
// 通过 Node.js 连接池查询，确认时区设置是否正确

import pool from './server/db/connection.js'

async function verifyTimezone() {
  try {
    console.log('🔍 开始验证数据库会话时区...\n')
    
    // 方法1：使用 pool.execute（包装后的方法）
    console.log('📋 方法1：使用 pool.execute 查询...')
    const [rows1] = await pool.execute("SELECT @@session.time_zone as session_tz, @@global.time_zone as global_tz")
    console.log('结果:', rows1[0])
    console.log(`会话时区: ${rows1[0].session_tz}`)
    console.log(`全局时区: ${rows1[0].global_tz}\n`)
    
    // 方法2：使用 pool.getConnection（包装后的方法）
    console.log('📋 方法2：使用 pool.getConnection 查询...')
    const conn = await pool.getConnection()
    try {
      const [rows2] = await conn.execute("SELECT @@session.time_zone as session_tz")
      console.log('结果:', rows2[0])
      console.log(`会话时区: ${rows2[0].session_tz}\n`)
    } finally {
      conn.release()
    }
    
    // 方法3：多次查询，验证每次都能正确设置
    console.log('📋 方法3：连续查询3次，验证时区设置的一致性...')
    for (let i = 1; i <= 3; i++) {
      const [rows] = await pool.execute("SELECT @@session.time_zone as session_tz")
      console.log(`第 ${i} 次查询: ${rows[0].session_tz}`)
    }
    
    console.log('\n✅ 验证完成')
    console.log('\n💡 说明：')
    console.log('- 如果 session_tz 显示为 +00:00 或 +00:00:00，说明时区设置成功')
    console.log('- 如果 session_tz 显示为 SYSTEM，说明时区设置失败')
    console.log('- MySQL 命令行查询的是独立会话，不受 Node.js 连接池影响')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    process.exit(1)
  }
}

verifyTimezone()

