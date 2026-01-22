// 测试自定义时间范围（custom_range）
// 目的：验证 custom_range 的输入验证和 warnings 生成

import { calculateTimeWindow, validateCustomRange } from './server/utils/timeWindow.js'
import { DateTime } from 'luxon'

console.log('🔍 测试自定义时间范围（custom_range）...\n')

// ============================================
// 测试1：正常情况
// ============================================
console.log('📋 测试1：正常情况（7天范围）')
console.log('='.repeat(60))
try {
  const { start, end, warnings } = calculateTimeWindow(
    'custom_range',
    'Asia/Shanghai',
    { since: '2026-01-14', until: '2026-01-20' }
  )
  
  const daysDiff = Math.ceil(end.diff(start, 'days').days)
  
  console.log(`✅ 成功计算时间窗口:`)
  console.log(`   开始时间: ${start.toFormat('yyyy-MM-dd HH:mm:ss')} (${start.toISO()})`)
  console.log(`   结束时间: ${end.toFormat('yyyy-MM-dd HH:mm:ss')} (${end.toISO()})`)
  console.log(`   天数跨度: ${daysDiff} 天`)
  console.log(`   Warnings: ${warnings ? warnings.join(', ') : '无'}`)
} catch (error) {
  console.error(`❌ 测试失败:`, error.message)
}

// ============================================
// 测试2：无效日期格式
// ============================================
console.log('\n📋 测试2：无效日期格式')
console.log('='.repeat(60))
try {
  const { start, end, warnings } = calculateTimeWindow(
    'custom_range',
    'Asia/Shanghai',
    { since: '2026/01/14', until: '2026-01-20' }  // 错误格式
  )
  console.log(`❌ 应该抛出错误，但返回了结果`)
} catch (error) {
  console.log(`✅ 正确捕获错误: ${error.message}`)
}

// ============================================
// 测试3：范围反转（since > until）
// ============================================
console.log('\n📋 测试3：范围反转（since > until）')
console.log('='.repeat(60))
try {
  const { start, end, warnings } = calculateTimeWindow(
    'custom_range',
    'Asia/Shanghai',
    { since: '2026-01-20', until: '2026-01-14' }  // 反转
  )
  console.log(`❌ 应该抛出错误，但返回了结果`)
} catch (error) {
  console.log(`✅ 正确捕获错误: ${error.message}`)
}

// ============================================
// 测试4：跨度超过 365 天（应该返回 warnings）
// ============================================
console.log('\n📋 测试4：跨度超过 365 天（应该返回 warnings）')
console.log('='.repeat(60))
try {
  const { start, end, warnings } = calculateTimeWindow(
    'custom_range',
    'Asia/Shanghai',
    { since: '2025-01-01', until: '2026-12-31' }  // 超过 365 天
  )
  
  const daysDiff = Math.ceil(end.diff(start, 'days').days)
  
  console.log(`✅ 成功计算时间窗口（但应该有警告）:`)
  console.log(`   开始时间: ${start.toFormat('yyyy-MM-dd HH:mm:ss')}`)
  console.log(`   结束时间: ${end.toFormat('yyyy-MM-dd HH:mm:ss')}`)
  console.log(`   天数跨度: ${daysDiff} 天`)
  console.log(`   Warnings: ${warnings ? warnings.join(', ') : '无'}`)
  
  if (warnings && warnings.some(w => w.includes('EXCEEDS_MAX_RANGE'))) {
    console.log(`   ✅ 正确生成了 EXCEEDS_MAX_RANGE 警告`)
  } else {
    console.log(`   ⚠️  应该生成 EXCEEDS_MAX_RANGE 警告，但没有`)
  }
} catch (error) {
  console.error(`❌ 测试失败:`, error.message)
}

// ============================================
// 测试5：无效时区
// ============================================
console.log('\n📋 测试5：无效时区')
console.log('='.repeat(60))
try {
  const { start, end, warnings } = calculateTimeWindow(
    'custom_range',
    'Invalid/Timezone',  // 无效时区
    { since: '2026-01-14', until: '2026-01-20' }
  )
  console.log(`❌ 应该抛出错误，但返回了结果`)
} catch (error) {
  console.log(`✅ 正确捕获错误: ${error.message}`)
}

// ============================================
// 测试6：不同时区的边界测试
// ============================================
console.log('\n📋 测试6：不同时区的边界测试')
console.log('='.repeat(60))
const testTimezones = ['UTC', 'Asia/Shanghai', 'America/New_York']

for (const tz of testTimezones) {
  try {
    const { start, end } = calculateTimeWindow(
      'custom_range',
      tz,
      { since: '2026-01-14', until: '2026-01-20' }
    )
    
    console.log(`✅ ${tz}:`)
    console.log(`   开始: ${start.toFormat('yyyy-MM-dd HH:mm:ss')} (${start.toISO()})`)
    console.log(`   结束: ${end.toFormat('yyyy-MM-dd HH:mm:ss')} (${end.toISO()})`)
  } catch (error) {
    console.error(`❌ ${tz} 测试失败:`, error.message)
  }
}

// ============================================
// 测试7：直接测试 validateCustomRange 函数
// ============================================
console.log('\n📋 测试7：直接测试 validateCustomRange 函数')
console.log('='.repeat(60))

const testCases = [
  { since: '2026-01-14', until: '2026-01-20', tz: 'Asia/Shanghai', desc: '正常情况' },
  { since: '2026/01/14', until: '2026-01-20', tz: 'Asia/Shanghai', desc: '无效格式 since' },
  { since: '2026-01-20', until: '2026-01-14', tz: 'Asia/Shanghai', desc: '范围反转' },
  { since: '2025-01-01', until: '2026-12-31', tz: 'Asia/Shanghai', desc: '超过365天' },
  { since: '2026-01-14', until: '2026-01-20', tz: 'Invalid/TZ', desc: '无效时区' }
]

for (const testCase of testCases) {
  const result = validateCustomRange(testCase.since, testCase.until, testCase.tz)
  console.log(`\n📌 ${testCase.desc}:`)
  console.log(`   输入: since=${testCase.since}, until=${testCase.until}, tz=${testCase.tz}`)
  console.log(`   验证结果: ${result.isValid ? '✅ 有效' : '❌ 无效'}`)
  console.log(`   Warnings: ${result.warnings.length > 0 ? result.warnings.join(', ') : '无'}`)
}

console.log('\n' + '='.repeat(60))
console.log('✅ 测试完成！')
console.log('\n💡 验证要点:')
console.log('   1. 正常情况应该成功计算时间窗口')
console.log('   2. 无效日期格式应该抛出错误')
console.log('   3. 范围反转应该抛出错误')
console.log('   4. 跨度超过 365 天应该返回 warnings（不抛错）')
console.log('   5. 无效时区应该抛出错误')
console.log('   6. 不同时区应该正确计算本地时间边界')

