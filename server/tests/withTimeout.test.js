import { describe, it, expect } from 'vitest'
import { TimeoutError, isTimeoutError, withTimeout } from '../utils/withTimeout.js'

describe('withTimeout', () => {
  it('任务在超时前完成时，应返回原始结果', async () => {
    const result = await withTimeout(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'ok'
    }, 100, '测试任务')

    expect(result).toBe('ok')
  })

  it('任务超过阈值时，应抛出可识别的超时错误', async () => {
    await expect(
      withTimeout(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'late'
      }, 10, '超时任务')
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TASK_TIMEOUT',
      label: '超时任务'
    })
  })

  it('超时时应触发 onTimeout 回调，便于上层中断底层任务', async () => {
    let timeoutHookCalled = false

    await expect(
      withTimeout(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }, 10, '带钩子任务', {
        onTimeout: () => {
          timeoutHookCalled = true
        }
      })
    ).rejects.toMatchObject({
      code: 'TASK_TIMEOUT'
    })

    expect(timeoutHookCalled).toBe(true)
  })

  it('isTimeoutError 应能识别超时错误', () => {
    const error = new TimeoutError('测试', 1000, '识别任务')
    expect(isTimeoutError(error)).toBe(true)
    expect(isTimeoutError(new Error('普通错误'))).toBe(false)
  })
})
