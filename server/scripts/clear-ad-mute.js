/**
 * 清除指定广告的 Smart Mute（挂起），使规则可再次对该广告执行动作。
 *
 * 使用：node server/scripts/clear-ad-mute.js <ad_id> [ad_id2 ...]
 * 示例：node server/scripts/clear-ad-mute.js 120236941795230501
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

async function clearAdMute(adIds) {
  if (!adIds.length) {
    console.log('用法: node server/scripts/clear-ad-mute.js <ad_id> [ad_id2 ...]')
    console.log('示例: node server/scripts/clear-ad-mute.js 120236941795230501')
    process.exit(1)
  }

  let connection = null
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'fb_ad',
      password: process.env.DB_PASS || '123456',
      database: process.env.DB_NAME || 'fb_ad_brain'
    })

    const placeholders = adIds.map(() => '?').join(', ')
    const [result] = await connection.execute(
      `UPDATE ad_snapshots SET mute_until = NULL, mute_reason = NULL WHERE ad_id IN (${placeholders})`,
      adIds
    )

    const affected = result.affectedRows || 0
    console.log(`✅ 已清除 ${affected} 条记录的 mute 状态，广告 ID：${adIds.join(', ')}`)
    if (affected === 0) {
      console.log('   （可能该 ad_id 在 ad_snapshots 中无记录或本来就没有 mute）')
    }
  } catch (err) {
    console.error('❌ 执行失败:', err.message)
    process.exit(1)
  } finally {
    if (connection) await connection.end()
  }
}

const adIds = process.argv.slice(2).map((s) => s.trim()).filter(Boolean)
clearAdMute(adIds)
