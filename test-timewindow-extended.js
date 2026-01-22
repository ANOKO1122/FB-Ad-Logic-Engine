// 测试扩展时间窗口：last_7_days 和 last_30_days
// 目的：验证 timeWindow.js 中新增的时间窗口是否正常工作

import { calculateTimeWindow, getTimeWindowForQuery } from './server/utils/timeWindow.js'
import { DateTime } from 'luxon'

console.log('🔍 测试扩展时间窗口（last_7_days 和 last_30_days）...\n')

// 测试时区列表
const testTimezones = ['UTC', 'Asia/Shanghai', 'America/New_York']

// 测试时间窗口列表
const testWindows = ['last_7_days', 'last_30_days']

for (const timezone of testTimezones) {
  console.log(`\n📋 测试时区: ${timezone}`)
  console.log('='.repeat(60))
  
  for (const timeWindow of testWindows) {
    try {
      // 1. 计算时间窗口
      const { start, end } = calculateTimeWindow(timeWindow, timezone)
      
      // 2. 转换为查询格式
      const query = getTimeWindowForQuery(timeWindow, timezone)
      
      // 3. 计算天数差
      const daysDiff = Math.ceil(end.diff(start, 'days').days)
      
      console.log(`\n✅ ${timeWindow}:`)
      console.log(`   开始时间 (本地): ${start.toFormat('yyyy-MM-dd HH:mm:ss')} (${start.toISO()})`)
      console.log(`   结束时间 (本地): ${end.toFormat('yyyy-MM-dd HH:mm:ss')} (${end.toISO()})`)
      console.log(`   天数跨度: ${daysDiff} 天`)
      console.log(`   查询格式 (startDate): ${query.startDate}`)
      console.log(`   查询格式 (endDate): ${query.endDate}`)
      
      // 4. 验证天数是否正确
      const expectedDays = timeWindow === 'last_7_days' ? 7 : 30
      if (daysDiff === expectedDays) {
        console.log(`   ✅ 天数验证通过（${expectedDays} 天）`)
      } else {
        console.log(`   ❌ 天数验证失败（期望 ${expectedDays} 天，实际 ${daysDiff} 天）`)
      }
      
    } catch (error) {
      console.error(`   ❌ ${timeWindow} 测试失败:`, error.message)
    }
  }
}

console.log('\n' + '='.repeat(60))
console.log('✅ 测试完成！')
console.log('\n💡 验证要点:')
console.log('   1. last_7_days 应该返回 7 天的数据')
console.log('   2. last_30_days 应该返回 30 天的数据')
console.log('   3. 不同时区的开始时间应该正确（基于时区的 00:00:00）')
console.log('   4. 结束时间应该是当前时区的 23:59:59.999')

