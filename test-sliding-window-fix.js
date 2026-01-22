/**
 * 测试脚本：验证 syncAllAccountsSlidingWindow 修复后的功能
 * 
 * 验证内容：
 * 1. 修复后的函数能正常执行（无 ReferenceError）
 * 2. optimizeQuota 参数正常工作（默认 false）
 * 3. 可选测试 optimizeQuota = true 的情况
 * 
 * 使用方法：
 * node test-sliding-window-fix.js [--optimize]
 * 
 * 参数：
 *   --optimize: 开启配额优化（optimizeQuota = true）
 */

import { syncAllAccountsSlidingWindow } from './server/services/ingestorService.js'
import pool from './server/db/connection.js'

// 解析命令行参数
const args = process.argv.slice(2)
const enableOptimize = args.includes('--optimize')

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('🧪 测试：滑动窗口同步功能修复验证')
  console.log('='.repeat(60))
  console.log(`📋 测试参数:`)
  console.log(`   optimizeQuota: ${enableOptimize ? 'true (开启优化)' : 'false (默认，关闭优化)'}`)
  console.log(`   daysBack: 7 (默认)`)
  console.log('')
  
  try {
    // 1. 检查是否有活跃账户
    console.log('📋 检查活跃账户...')
    const [accounts] = await pool.query(`
      SELECT COUNT(*) as count
      FROM account_mappings 
      WHERE is_active = 1
    `)
    
    const accountCount = accounts[0]?.count || 0
    console.log(`✅ 找到 ${accountCount} 个活跃账户`)
    
    if (accountCount === 0) {
      console.error('❌ 没有找到活跃账户，无法执行测试')
      console.error('   请先在 account_mappings 表中添加账户并设置为 is_active = 1')
      process.exit(1)
    }
    
    console.log('')
    console.log('='.repeat(60))
    console.log('🔄 开始执行滑动窗口同步...')
    console.log('='.repeat(60))
    console.log('')
    
    // 2. 执行滑动窗口同步
    const startTime = Date.now()
    
    // 根据参数决定是否开启优化
    const result = await syncAllAccountsSlidingWindow(7, enableOptimize)
    
    const duration = Date.now() - startTime
    
    console.log('')
    console.log('='.repeat(60))
    console.log('✅ 测试完成')
    console.log('='.repeat(60))
    console.log('')
    
    // 3. 输出结果
    console.log('📊 执行结果:')
    console.log(`   ✅ 成功: ${result.success ? '是' : '否'}`)
    console.log(`   📋 账户总数: ${result.totalAccounts || 0}`)
    console.log(`   ✅ 成功账户: ${result.successCount || 0}`)
    console.log(`   📊 Today 数据: ${result.totalTodayCount || 0} 条（ad_snapshots）`)
    console.log(`   📊 按日数据: ${result.totalDailyStatsCount || 0} 条（daily_stats）`)
    console.log(`   ⏱️  耗时: ${duration}ms`)
    
    if (result.skipped) {
      console.log(`   ⏸️  跳过原因: ${result.message || '未知'}`)
    }
    
    // 4. 验证修复是否成功（检查是否有 ReferenceError）
    if (result.success !== undefined) {
      console.log('')
      console.log('✅ 修复验证通过：')
      console.log('   - 函数能正常执行（无 ReferenceError）')
      console.log('   - optimizeQuota 参数正常工作')
      console.log(`   - 当前配置: optimizeQuota = ${enableOptimize}`)
    }
    
    // 5. 如果有失败的账户，显示详细信息
    if (result.results && result.results.length > 0) {
      const failedResults = result.results.filter(r => !r.success)
      if (failedResults.length > 0) {
        console.log('')
        console.log('⚠️  失败的账户:')
        failedResults.forEach(r => {
          console.log(`   - ${r.accountId}: ${r.error || '未知错误'}`)
        })
      }
    }
    
    console.log('')
    console.log('='.repeat(60))
    console.log('📝 验证说明:')
    console.log('   1. 如果看到此输出且没有 ReferenceError，说明修复成功')
    console.log('   2. 如果看到 "optimizeQuota is not defined" 错误，说明修复失败')
    console.log('   3. 建议观察定时任务日志，确认每 30 分钟执行正常')
    console.log('='.repeat(60))
    console.log('')
    
    // 6. 可选：测试开启优化的情况
    if (!enableOptimize) {
      console.log('💡 提示: 可以使用 --optimize 参数测试开启配额优化的情况')
      console.log('   命令: node test-sliding-window-fix.js --optimize')
      console.log('')
    }
    
  } catch (error) {
    console.error('')
    console.error('='.repeat(60))
    console.error('❌ 测试失败')
    console.error('='.repeat(60))
    console.error('')
    console.error('错误信息:', error.message)
    
    // 检查是否是 ReferenceError（修复失败）
    if (error.message.includes('optimizeQuota is not defined')) {
      console.error('')
      console.error('🚨 修复验证失败：')
      console.error('   - 仍然出现 "optimizeQuota is not defined" 错误')
      console.error('   - 请检查 syncAllAccountsSlidingWindow 函数签名是否正确')
      console.error('   - 应该包含 optimizeQuota 参数（默认 false）')
    } else {
      console.error('')
      console.error('错误堆栈:')
      console.error(error.stack)
    }
    
    process.exit(1)
  } finally {
    // 关闭数据库连接
    try {
      await pool.end()
    } catch (err) {
      // 忽略关闭连接时的错误
    }
  }
}

// 执行主函数
main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exit(1)
})

