/**
 * TASKS §1.3 并发+限流验证脚本
 * 模拟 36 账户场景，验证 p-limit(6) 下：
 * - 整体耗时明显优于串行（至少 2x 加速）
 * - 同一时刻并发数不超过 6
 * 使用方法：node server/scripts/verify-concurrent-limit.js
 */
import pLimit from 'p-limit'

const CONCURRENT_LIMIT = 6
const TASK_COUNT = 36
const TASK_DURATION_MS = 80

let activeCount = 0
let maxActiveCount = 0

async function mockAccountSync(index) {
  activeCount++
  maxActiveCount = Math.max(maxActiveCount, activeCount)
  await new Promise(r => setTimeout(r, TASK_DURATION_MS))
  activeCount--
  return { index, ok: true }
}

async function runConcurrent() {
  activeCount = 0
  maxActiveCount = 0
  const limiter = pLimit(CONCURRENT_LIMIT)
  const start = Date.now()
  const tasks = Array.from({ length: TASK_COUNT }, (_, i) =>
    limiter(() => mockAccountSync(i))
  )
  await Promise.all(tasks)
  return Date.now() - start
}

async function runSerial() {
  activeCount = 0
  maxActiveCount = 0
  const start = Date.now()
  for (let i = 0; i < TASK_COUNT; i++) {
    await mockAccountSync(i)
  }
  return Date.now() - start
}

async function main() {
  console.log('')
  console.log('='.repeat(50))
  console.log('TASKS §1.3 并发+限流验证')
  console.log(`   模拟 ${TASK_COUNT} 账户，每任务 ${TASK_DURATION_MS}ms，并发度 ${CONCURRENT_LIMIT}`)
  console.log('='.repeat(50))

  const serialTime = await runSerial()
  const concurrentTime = await runConcurrent()

  const speedup = serialTime / concurrentTime
  const expectedMinSpeedup = 2

  console.log('')
  console.log('结果:')
  console.log(`   串行耗时: ${serialTime}ms`)
  console.log(`   并发耗时: ${concurrentTime}ms`)
  console.log(`   加速比: ${speedup.toFixed(2)}x`)
  console.log(`   最大并发数: ${maxActiveCount}`)
  console.log('')

  let ok = true
  if (speedup < expectedMinSpeedup) {
    console.error(`❌ 加速比 ${speedup.toFixed(2)}x < ${expectedMinSpeedup}x，并发优势不足`)
    ok = false
  } else {
    console.log(`✅ 加速比 ${speedup.toFixed(2)}x >= ${expectedMinSpeedup}x`)
  }
  if (maxActiveCount > CONCURRENT_LIMIT) {
    console.error(`❌ 最大并发数 ${maxActiveCount} > ${CONCURRENT_LIMIT}，限流未生效`)
    ok = false
  } else {
    console.log(`✅ 最大并发数 ${maxActiveCount} <= ${CONCURRENT_LIMIT}`)
  }
  console.log('='.repeat(50))
  console.log('')
  process.exit(ok ? 0 : 1)
}

main().catch(err => {
  console.error('验证失败:', err)
  process.exit(1)
})
