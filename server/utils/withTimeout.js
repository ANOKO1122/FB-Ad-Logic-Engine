/**
 * 超时错误：用于区分“业务失败”和“任务长时间无返回”两种不同问题。
 * 这样上层收口时就能明确知道：这次失败不是接口报错，而是这条异步链路卡住了。
 */
export class TimeoutError extends Error {
  constructor(message, timeoutMs, label) {
    super(message)
    this.name = 'TimeoutError'
    this.code = 'TASK_TIMEOUT'
    this.timeoutMs = timeoutMs
    this.label = label
  }
}

/**
 * 给任意异步任务套一层“超时保险丝”。
 *
 * 底层原理可以把它理解成“两个人赛跑”：
 * - 一个是真正的业务任务
 * - 一个是定时器
 * 谁先结束，就把结果先返回给上层
 *
 * 这里不会强行中断底层任务本身，因为现有很多调用链并不支持 AbortController。
 * 但它至少能保证上层不会无限等待，从而让 Promise.allSettled 有机会正常收口。
 *
 * @template T
 * @param {() => Promise<T> | T} taskFactory - 返回任务结果的函数，而不是已开始执行的 Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} [label='task'] - 日志和错误里使用的任务标签
 * @param {{ onTimeout?: (error: TimeoutError) => void }} [options] - 超时钩子，可用于 abort 底层任务
 * @returns {Promise<T>}
 */
export async function withTimeout(taskFactory, timeoutMs, label = 'task', options = {}) {
  if (typeof taskFactory !== 'function') {
    throw new TypeError('withTimeout 要求传入函数形式的 taskFactory')
  }

  const safeTimeoutMs = Number(timeoutMs)
  if (!Number.isFinite(safeTimeoutMs) || safeTimeoutMs <= 0) {
    return await Promise.resolve().then(taskFactory)
  }

  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new TimeoutError(`${label} 执行超时（>${safeTimeoutMs}ms）`, safeTimeoutMs, label)
      try {
        // 中文注释：这里先通知上层“开始撤场”，再把超时错误抛给外层。
        // 这样 withTimeout 不只是报表层超时，还能驱动底层任务尽快中断。
        options?.onTimeout?.(timeoutError)
      } catch {
        // onTimeout 是 best-effort，不能反过来覆盖真正的超时错误
      }
      reject(timeoutError)
    }, safeTimeoutMs)
  })

  try {
    return await Promise.race([
      Promise.resolve().then(taskFactory),
      timeoutPromise
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * 便于上层在不依赖 instanceof 的情况下识别超时错误。
 * 这样即使错误跨模块传递，也能稳定按 code/name 判断。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTimeoutError(error) {
  return error?.code === 'TASK_TIMEOUT' || error?.name === 'TimeoutError'
}
