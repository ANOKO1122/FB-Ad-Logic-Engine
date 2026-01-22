/**
 * 手动触发冷数据归档（用于验证完整性检查）
 * 
 * 功能：
 * 1. 使用强制模式（forceAll=true）绕过时区窗口
 * 2. 触发完整性检查，补齐缺失数据
 * 3. 显示详细的执行结果和跳过原因统计
 * 
 * 使用方法：
 * node test-manual-archive.js
 */

import dotenv from 'dotenv'
dotenv.config()

import { manualArchive } from './server/services/cronService.js'

console.log('')
console.log('='.repeat(60))
console.log('🔧 手动触发冷数据归档（强制模式）')
console.log('='.repeat(60))
console.log('')
console.log('⏰ 开始时间:', new Date().toLocaleString('zh-CN'))
console.log('')

async function main() {
  try {
    const result = await manualArchive()
    
    console.log('')
    console.log('='.repeat(60))
    console.log('✅ 手动归档完成')
    console.log('='.repeat(60))
    console.log('📊 执行结果:')
    console.log(`   - 检查账户: ${result.totalAccounts} 个`)
    console.log(`   - 归档账户: ${result.archivedAccounts} 个`)
    console.log(`   - 跳过账户: ${result.skippedAccounts} 个`)
    console.log(`   - 归档记录: ${result.totalArchivedCount} 条`)
    console.log('')
    console.log('💡 提示:')
    console.log('   1. 如果看到"已归档但不完整，继续补齐"，说明完整性检查正常工作')
    console.log('   2. 如果看到"已归档且完整，跳过"，说明数据已经完整')
    console.log('   3. 可以运行诊断脚本验证结果:')
    console.log('      node test-check-archive-status.js <account_id> <date>')
    console.log('')
    
    return result
  } catch (error) {
    console.error('')
    console.error('='.repeat(60))
    console.error('❌ 手动归档失败')
    console.error('='.repeat(60))
    console.error('')
    console.error('错误信息:', error.message)
    if (error.stack) {
      console.error('')
      console.error('错误堆栈:')
      console.error(error.stack.split('\n').slice(0, 10).join('\n'))
    }
    process.exit(1)
  }
}

main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

