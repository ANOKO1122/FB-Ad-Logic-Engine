// 定时任务测试脚本
// 用于验证定时任务功能是否正常工作
// 使用方法：node test-cron-tasks.js [task_name]
// 
// 可选任务：
// - sync-today: 测试同步 Today 数据
// - archive: 测试冷数据落盘
// - all: 测试所有任务

import dotenv from 'dotenv'
dotenv.config()

import { 
  syncAllAccountsTodayStats,
  archiveAllAccountsDailyStats
} from './server/services/ingestorService.js'

const taskName = process.argv[2] || 'all'

console.log('')
console.log('='.repeat(50))
console.log('🧪 定时任务测试脚本')
console.log('='.repeat(50))
console.log('')

async function testSyncToday() {
  console.log('📋 测试任务：同步 Today 数据（热数据）')
  console.log('⏰ 开始时间:', new Date().toLocaleString('zh-CN'))
  console.log('')
  
  try {
    const result = await syncAllAccountsTodayStats()
    console.log('')
    console.log('✅ 测试通过')
    console.log(`📊 结果: 共 ${result.totalAccounts} 个账户，同步 ${result.totalSyncedCount} 条记录`)
    return { success: true, result }
  } catch (error) {
    console.error('')
    console.error('❌ 测试失败')
    console.error('错误信息:', error.message)
    console.error('错误堆栈:', error.stack)
    return { success: false, error: error.message }
  }
}

async function testArchive() {
  console.log('📋 测试任务：冷数据落盘')
  console.log('⏰ 开始时间:', new Date().toLocaleString('zh-CN'))
  console.log('')
  
  try {
    // 使用强制模式（forceAll=true），绕过时区窗口和跳过检查，确保立即补齐缺失数据
    const result = await archiveAllAccountsDailyStats(null, true)
    console.log('')
    console.log('✅ 测试通过')
    console.log(`📊 结果: 共 ${result.totalAccounts} 个账户，归档 ${result.totalArchivedCount} 条记录`)
    return { success: true, result }
  } catch (error) {
    console.error('')
    console.error('❌ 测试失败')
    console.error('错误信息:', error.message)
    console.error('错误堆栈:', error.stack)
    return { success: false, error: error.message }
  }
}

async function testAll() {
  console.log('📋 测试所有定时任务')
  console.log('')
  
  const results = {
    syncToday: null,
    archive: null
  }
  
  // 测试同步 Today 数据
  console.log('1️⃣ 测试同步 Today 数据...')
  results.syncToday = await testSyncToday()
  console.log('')
  console.log('='.repeat(50))
  console.log('')
  
  // 等待 2 秒
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // 测试冷数据落盘
  console.log('2️⃣ 测试冷数据落盘...')
  results.archive = await testArchive()
  console.log('')
  console.log('='.repeat(50))
  console.log('')
  
  // 汇总结果
  console.log('📊 测试结果汇总:')
  console.log(`  同步 Today 数据: ${results.syncToday.success ? '✅ 通过' : '❌ 失败'}`)
  console.log(`  冷数据落盘: ${results.archive.success ? '✅ 通过' : '❌ 失败'}`)
  console.log('')
  
  const allPassed = results.syncToday.success && results.archive.success
  if (allPassed) {
    console.log('✅ 所有测试通过！')
  } else {
    console.log('❌ 部分测试失败，请检查错误信息')
    process.exit(1)
  }
}

// 执行测试
async function main() {
  try {
    switch (taskName) {
      case 'sync-today':
        await testSyncToday()
        break
      case 'archive':
        await testArchive()
        break
      case 'all':
      default:
        await testAll()
        break
    }
  } catch (error) {
    console.error('❌ 测试脚本执行失败:', error.message)
    console.error('错误堆栈:', error.stack)
    process.exit(1)
  }
}

main()

