/**
 * 手动触发规则执行测试脚本
 * 用途：测试阶段2的规则执行摘要功能
 * 
 * 使用方法：
 *   node test-manual-execute.js
 */

import { manualExecute } from './server/services/cronService.js'

async function test() {
  try {
    console.log('='.repeat(50))
    console.log('🚀 开始手动触发规则执行...')
    console.log('='.repeat(50))
    console.log('')
    
    const startTime = Date.now()
    const result = await manualExecute(false)  // false = 不强制，遵守冷却期
    
    const duration = Date.now() - startTime
    
    console.log('')
    console.log('='.repeat(50))
    console.log('✅ 执行完成')
    console.log('='.repeat(50))
    console.log(`⏱️  总耗时: ${duration}ms`)
    console.log('📊 执行结果:', JSON.stringify(result, null, 2))
    console.log('')
    console.log('💡 提示：现在可以查询 rule_execution_summaries 表验证摘要是否写入')
    console.log('')
    
  } catch (error) {
    console.error('')
    console.error('='.repeat(50))
    console.error('❌ 执行失败')
    console.error('='.repeat(50))
    console.error('错误信息:', error.message)
    console.error('错误堆栈:', error.stack)
    console.error('')
    process.exit(1)
  }
  
  process.exit(0)
}

test()
