// 手动触发「每小时结构全量轮转」，用于验证轮转逻辑（如 collation 修复后）
// 使用：node server/scripts/manual-hourly-structure-rotation.js
// 说明：与 manual-unified-heartbeat.js 不同——心跳是 15 分钟同步+规则+伪增量，本脚本只跑轮转（默认 6 账户全量 structure_ads）

import 'dotenv/config'
import { runHourlyStructureFullRotation } from '../services/structureSyncService.js'
import { FacebookMarketingAPI } from '../index.js'

console.log('')
console.log('='.repeat(50))
console.log('🔧 手动触发结构全量轮转（5 * * * * 等价）')
console.log('='.repeat(50))
console.log('')

const token = process.env.FACEBOOK_ACCESS_TOKEN
if (!token) {
  console.error('❌ 缺少 FACEBOOK_ACCESS_TOKEN')
  process.exit(1)
}

try {
  const api = new FacebookMarketingAPI(token)
  const result = await runHourlyStructureFullRotation(api)

  if (result.skipped) {
    console.log('[结构轮转] 本小时跳过:', result.reason)
  } else {
    console.log('[结构轮转] 本小时完成:', result.synced, '个账户')
  }
  console.log('')
  console.log('='.repeat(50))
  console.log('✅ 执行完成')
  console.log('='.repeat(50))
  process.exit(0)
} catch (err) {
  console.error('')
  console.error('[结构轮转] 失败:', err.message)
  console.error(err.stack)
  process.exit(1)
}
