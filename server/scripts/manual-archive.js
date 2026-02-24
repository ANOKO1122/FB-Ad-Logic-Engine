// 手动触发冷数据归档（强制模式，所有账户的「昨日」）
// 用途：测试归档逻辑、补齐缺失、验证 cpc/roas 兜底
// 使用方法（项目根目录）：node server/scripts/manual-archive.js

import { manualArchive } from '../services/cronService.js'

console.log('')
console.log('='.repeat(50))
console.log('🔧 手动触发冷数据归档（强制模式）')
console.log('   将对所有活跃账户执行「昨日」归档，忽略时区窗口')
console.log('='.repeat(50))
console.log('')

try {
  const result = await manualArchive()
  console.log('')
  console.log('='.repeat(50))
  console.log('✅ 归档完成')
  console.log('   总账户:', result.totalAccounts)
  console.log('   本次归档账户:', result.archivedAccounts)
  console.log('   归档记录数:', result.totalArchivedCount || 0)
  console.log('='.repeat(50))
  process.exit(0)
} catch (error) {
  console.error('')
  console.error('='.repeat(50))
  console.error('❌ 归档失败:', error.message)
  console.error('错误堆栈:', error.stack)
  console.error('='.repeat(50))
  process.exit(1)
}
