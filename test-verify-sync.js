// 验证步骤1：触发同步任务，观察清洗日志
import('./server/services/cronService.js').then(async (m) => {
  console.log('🔍 开始验证：触发同步任务（观察清洗日志）...\n')
  await m.manualUnifiedHeartbeat()
  console.log('\n✅ 同步任务完成！')
  console.log('📝 请检查后端日志，应该看到类似以下内容：')
  console.log('   🧹 [队列写入器] 数据清洗: X → Y (过滤 Z 条 spend=0 且 impressions=0 的僵尸数据)')
  console.log('   或者没有清洗日志（说明没有僵尸数据，这也是正常的）\n')
  process.exit(0)
}).catch(err => {
  console.error('❌ 验证失败:', err)
  process.exit(1)
})
