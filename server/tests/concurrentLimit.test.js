/**
 * TASKS §1.3 并发+限流验证
 * 验证 p-limit(6) 在 36 任务场景下：
 * - 整体耗时明显优于串行（至少 2x 加速）
 * - 同一时刻并发数不超过 6
 */
import { describe, it, expect } from 'vitest'
import pLimit from 'p-limit'

const CONCURRENT_LIMIT = 6
const TASK_COUNT = 36
const TASK_DURATION_MS = 50

describe('并发+限流（TASKS §1.3）', () => {
  it('36 任务并发度 6 时，耗时明显优于串行且最大并发不超过 6', async () => {
    let activeCount = 0
    let maxActiveCount = 0

    const mockTask = async () => {
      activeCount++
      maxActiveCount = Math.max(maxActiveCount, activeCount)
      await new Promise(r => setTimeout(r, TASK_DURATION_MS))
      activeCount--
    }

    const runSerial = async () => {
      activeCount = 0
      maxActiveCount = 0
      const start = Date.now()
      for (let i = 0; i < TASK_COUNT; i++) await mockTask()
      return Date.now() - start
    }

    const runConcurrent = async () => {
      activeCount = 0
      maxActiveCount = 0
      const limiter = pLimit(CONCURRENT_LIMIT)
      const start = Date.now()
      await Promise.all(
        Array.from({ length: TASK_COUNT }, () => limiter(mockTask))
      )
      return Date.now() - start
    }

    const serialTime = await runSerial()
    const concurrentTime = await runConcurrent()
    const speedup = serialTime / concurrentTime

    expect(speedup).toBeGreaterThanOrEqual(2)
    expect(maxActiveCount).toBeLessThanOrEqual(CONCURRENT_LIMIT)
  })
})
