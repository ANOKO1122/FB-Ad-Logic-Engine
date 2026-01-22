// test-timewindow-manual.js
import { calculateTimeWindow, getTimeWindowForQuery } from './server/utils/timeWindow.js'

// 测试 today 时间窗口
const { start, end } = calculateTimeWindow('today', 'Asia/Shanghai')
console.log('Today (Asia/Shanghai):')
console.log('  开始:', start.toISO())
console.log('  结束:', end.toISO())

// 测试 yesterday 时间窗口
const { start: yStart, end: yEnd } = calculateTimeWindow('yesterday', 'UTC')
console.log('\nYesterday (UTC):')
console.log('  开始:', yStart.toISO())
console.log('  结束:', yEnd.toISO())

// 测试 MySQL 查询条件
const query = getTimeWindowForQuery('last_3_days', 'Asia/Shanghai', 'synced_at')
console.log('\nLast 3 Days (MySQL 查询条件):')
console.log('  开始日期:', query.startDate)
console.log('  结束日期:', query.endDate)