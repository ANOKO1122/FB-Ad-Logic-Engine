// 验证步骤2：触发归档任务，测试归档查询
import('./server/services/cronService.js').then(async (m) => {
  console.log('🔍 开始验证：触发归档任务（测试归档查询）...\n')
  await m.manualArchive()
  console.log('\n✅ 归档任务完成！')
  console.log('📝 请检查后端日志，应该看到归档成功的日志')
  console.log('📝 可以在 MySQL 中查询 daily_stats 表确认是否有新数据\n')
  process.exit(0)
}).catch(err => {
  console.error('❌ 验证失败:', err)
  process.exit(1)
})
