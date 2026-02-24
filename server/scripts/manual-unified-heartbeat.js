// 手动触发统一心跳同步脚本
// 使用方法：node server/scripts/manual-unified-heartbeat.js

import { manualUnifiedHeartbeat } from '../services/cronService.js'

console.log('')
console.log('='.repeat(50))
console.log('🔧 手动触发统一心跳同步')
console.log('='.repeat(50))
console.log('')

try {
  const result = await manualUnifiedHeartbeat()
  console.log('')
  console.log('='.repeat(50))
  console.log('✅ 执行完成')
  console.log('='.repeat(50))
  process.exit(0)
} catch (error) {
  console.error('')
  console.error('='.repeat(50))
  console.error('❌ 执行失败:', error.message)
  console.error('错误堆栈:', error.stack)
  console.error('='.repeat(50))
  process.exit(1)
}

