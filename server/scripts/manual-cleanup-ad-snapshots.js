// 手动触发热表清理（删除 ad_snapshots 超过 2 天的快照）
// 用途：测试清理逻辑、手动释放空间
// 使用方法（项目根目录）：node server/scripts/manual-cleanup-ad-snapshots.js

import { manualCleanupAdSnapshots } from '../services/cronService.js'

console.log('')
console.log('='.repeat(50))
console.log('🔧 手动触发热表清理（ad_snapshots）')
console.log('   将删除 synced_at < NOW() - 2 DAY 的历史快照')
console.log('='.repeat(50))
console.log('')

try {
  const result = await manualCleanupAdSnapshots()
  console.log('')
  console.log('='.repeat(50))
  console.log('✅ 清理完成')
  console.log('   删除记录数:', result.deleted)
  console.log('='.repeat(50))
  process.exit(0)
} catch (error) {
  console.error('')
  console.error('='.repeat(50))
  console.error('❌ 清理失败:', error.message)
  console.error('错误堆栈:', error.stack)
  console.error('='.repeat(50))
  process.exit(1)
}
