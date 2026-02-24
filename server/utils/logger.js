/**
 * 统一应用日志（Winston）
 * - 开发：控制台彩色输出
 * - 生产：控制台 + 按天轮转文件（双写）。终端有实时输出，logs/ 保留 14 天便于事后排查
 * 路径使用相对路径 + 可配置 LOG_DIR，禁止硬编码绝对路径
 */

import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const isDev = process.env.NODE_ENV !== 'production'
const logDir = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs')
const logDirResolved = path.resolve(logDir)

// 生产模式启动时主动创建日志目录，并在控制台打印路径（便于确认 logs 位置）
if (!isDev) {
  try {
    fs.mkdirSync(logDirResolved, { recursive: true })
    console.warn('[Winston] 日志目录（同时写文件）:', logDirResolved)
  } catch (e) {
    console.error('[Winston] 创建日志目录失败:', logDirResolved, e.message)
  }
}

const jsonFormat = () =>
  winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  )

const consoleFormat = () =>
  winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
      return `${timestamp} ${level}: ${message}${metaStr}`
    })
  )

const dailyRotateOptions = (filename, level = null) => ({
  dirname: logDir,
  filename: filename.replace('.log', '-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  zippedArchive: true,
  format: jsonFormat(),
  ...(level ? { level } : {}),
})

const transports = []

// 开发：仅控制台；生产：控制台 + 文件（双写，终端实时看 + 文件保留 14 天）
transports.push(
  new winston.transports.Console({
    format: consoleFormat(),
  })
)
if (!isDev) {
  transports.push(
    new DailyRotateFile(dailyRotateOptions('combined.log')),
    new DailyRotateFile(dailyRotateOptions('error.log', 'error'))
  )
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  defaultMeta: { service: 'fb-ad-logic-engine' },
  transports,
  exitOnError: false,
})

// 生产环境下：未捕获异常与未处理拒绝写入单独文件（由 server.js 挂载 process 后生效）
if (!isDev) {
  const exceptionFile = new DailyRotateFile(dailyRotateOptions('exceptions.log'))
  const rejectionFile = new DailyRotateFile(dailyRotateOptions('rejections.log'))
  logger.exceptions.handle(exceptionFile)
  logger.rejections.handle(rejectionFile)
}

export default logger
