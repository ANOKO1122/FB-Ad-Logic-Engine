// 服务器启动入口 - 负责启动 Express 应用
// 注意：dotenv.config() 必须在第一行，确保环境变量在应用加载前就配置好
import dotenv from 'dotenv'
dotenv.config()
dotenv.config({ path: '.env.auth' })

// 配置全局代理环境变量（分别回填 lowercase，不覆盖已有值，不强制合并 HTTP/HTTPS）
if (process.env.HTTP_PROXY && !process.env.http_proxy) {
  process.env.http_proxy = process.env.HTTP_PROXY
}
if (process.env.HTTPS_PROXY && !process.env.https_proxy) {
  process.env.https_proxy = process.env.HTTPS_PROXY
}
import logger from './utils/logger.js'

if (process.env.http_proxy || process.env.https_proxy) {
  logger.info('已设置全局代理环境变量')
}

// 引入 Express 应用配置（不包含启动逻辑）
// 注意：需要先导入 index.js 以注册 API 路由
import './index.js'  // 导入以注册 API 路由
import app from './app.js'
import { startCronJob, stopCronJob } from './services/cronService.js'
import { getWriteQueueStats, processWriteQueue } from './services/ingestorService.js'
import { flushHistoryQueue } from './services/structureSyncService.js'

// 获取端口号（从环境变量或使用默认值）
const PORT = process.env.PORT || 3001
// 定时任务总闸：默认开启（未配置时为 true，保证云端默认行为不回归）
// 仅当显式配置为 false/0/no/off 时才关闭，避免因拼写差异导致误关
const ENABLE_CRON = !['0', 'false', 'no', 'off'].includes(String(process.env.ENABLE_CRON ?? 'true').trim().toLowerCase())

// 启动服务器（监听所有网卡，允许局域网访问）
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`服务器运行在 http://0.0.0.0:${PORT}`)
  logger.info(`API端点: http://0.0.0.0:${PORT}/api`)
  logger.info(`健康检查: http://0.0.0.0:${PORT}/api/health`)
  logger.info('局域网访问: http://<你的IP>:' + PORT)
  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    logger.warn('FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
  } else {
    logger.info('FACEBOOK_ACCESS_TOKEN 已配置')
    logger.info('Token前10位: ' + token.substring(0, 10) + '...')
  }
  logger.info('查看控制台/日志以获取详细的API调用信息')
  // 本地防抢跑：当 ENABLE_CRON=false 时跳过定时任务初始化，避免与云端重复动作
  if (ENABLE_CRON) {
    logger.info('cron enabled / init cron scheduler')
    startCronJob()
  } else {
    logger.warn('cron disabled / skip cron init (ENABLE_CRON=false)')
  }
})

// ============================================
// 优雅退出处理（AdsPolar 手段1）
// ============================================
// 【手段1：优雅退出】解决 95% 的问题
// 大多数"进程崩溃"其实是重启（比如发版更新代码，或者 PM2 自动重启）
// 我们可以告诉 Node.js："死之前，先把肚子里的数据吐干净"
//
// 【手段2：自愈性】数据的"自愈性"（Self-Healing）
// 如果是代码 Bug 导致进程直接崩溃（Crash），或者内存溢出（OOM），
// Graceful Shutdown 来不及执行怎么办？
// 答案：丢了就丢了，下一轮会自动补回来。
// - 10:15 的热数据采集下来了，但在写入前进程崩了
// - 10:30 的任务启动，会去拉取 today 的数据
// - FB 返回的是"截止 10:30 的累计花费"，写入后数据直接跳到最新状态
// - 中间丢失的 10:15 那一帧，对于业务规则（止损/扩量）来说，影响微乎其微

let isShuttingDown = false

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('正在关闭中，请勿重复触发')
    return
  }
  isShuttingDown = true
  logger.info('收到信号，开始优雅退出', { signal })
  try {
    logger.info('[1/4] 停止定时任务...')
    await stopCronJob()
    logger.info('定时任务已停止')

    logger.info('[2/4] 刷写 structure_ads_history 队列...')
    const historyFlushTimeoutMs = 10000
    const historyResult = await flushHistoryQueue(historyFlushTimeoutMs).catch((e) => {
      logger.warn('structure_ads_history flush 异常', { message: e.message })
      return { flushed: 0 }
    })
    logger.info('structure_ads_history 队列已刷写', { flushed: historyResult.flushed })

    const queueStats = getWriteQueueStats()
    logger.info('[3/4] 检查写入队列状态', {
      queueLength: queueStats.queueLength,
      isWriting: queueStats.isWriting,
      totalQueued: queueStats.stats.totalQueued,
      totalWritten: queueStats.stats.totalWritten,
      totalErrors: queueStats.stats.totalErrors,
    })
    if (queueStats.queueLength > 0) {
      logger.info('[4/4] 紧急写入剩余数据', { count: queueStats.queueLength })
      const timeout = 30000
      const startTime = Date.now()
      await Promise.race([
        processWriteQueue(true),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('写入超时')), timeout)
        ),
      ]).catch((error) => {
        if (error.message === '写入超时') {
          logger.warn('写入超时，剩余数据将在下一轮同步补回', {
            timeoutMs: timeout,
            remaining: getWriteQueueStats().queueLength,
          })
        } else {
          logger.error('紧急写入失败', { message: error.message })
        }
      })
      const elapsed = Date.now() - startTime
      const finalStats = getWriteQueueStats()
      logger.info('紧急写入完成', { elapsedMs: elapsed, remaining: finalStats.queueLength })
    } else {
      logger.info('[4/4] 写入队列为空，无需处理')
    }
    logger.info('数据清理完毕，再见')
    setTimeout(() => process.exit(0), 100)
  } catch (error) {
    logger.error('优雅退出失败', { message: error.message, stack: error.stack })
    setTimeout(() => process.exit(1), 100)
  }
}

// 监听 PM2 的重启/停止信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

// 监听未捕获的异常（集中记录到 logger，生产环境会同时写入 exceptions 文件）
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常（可能导致进程崩溃）', {
    message: error.message,
    stack: error.stack,
  })
  logger.info('进程可能即将退出，队列数据下一轮同步将自动补回')
  gracefulShutdown('uncaughtException').catch(() => process.exit(1))
})

// 监听未处理的 Promise 拒绝（集中记录到 logger，生产环境会同时写入 rejections 文件）
process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝', { reason: String(reason) })
})