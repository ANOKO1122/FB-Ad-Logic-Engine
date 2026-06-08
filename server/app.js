// Express 应用配置 - 不包含服务器启动逻辑
// 注意：dotenv.config() 不在这里，在 server.js 中
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { requireAuth, requireActive } from './middleware/authJwt.js'
import authRoutes from './routes/auth.js'
import adminRoutes from './routes/admin.js'
import rulesRoutes from './routes/rules.js'
// [临时禁用] 定时任务模块有语法错误待修复
// import scheduledTasksRoutes from './routes/scheduledTasks.js'
import systemRoutes from './routes/system.js'

// 导入 Facebook API 客户端类和规则引擎类（暂时从 index.js 导入，后续可以移到单独文件）
// 注意：这里需要导入 index.js 中定义的类和函数
// 为了快速解决问题，我们先从 index.js 导入，但需要确保 index.js 导出这些类

const app = express()

// 中间件
app.use(cors({ origin: true, credentials: true }))
// JSON 解析中间件（增强错误处理）
app.use(express.json({
  strict: true,  // 只接受数组和对象
  limit: '10mb'  // 限制请求体大小
}))
// JSON 解析错误处理中间件（必须在 express.json() 之后）
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ JSON 解析错误:', err.message)
    return res.status(400).json({
      error: '请求体格式错误，请检查 JSON 格式',
      code: 'INVALID_JSON',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    })
  }
  next(err)
})
app.use(cookieParser())

// 路由（认证/管理员/规则/系统）
app.use('/api', authRoutes)          // /api/me, /api/owners, /api/auth/*
app.use('/api/admin', adminRoutes)   // /api/admin/*
app.use('/api', rulesRoutes)         // /api/rules/* (规则管理，使用 Drizzle ORM)
// [临时禁用] 定时任务路由
// app.use('/api/scheduled-tasks', scheduledTasksRoutes) // /api/scheduled-tasks/*
app.use('/api', systemRoutes)        // /api/automation-logs/*, /api/system/*

// 健康检查路由（测试需要）
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '服务器运行正常',
    timestamp: new Date().toISOString(),
    token_configured: !!process.env.FACEBOOK_ACCESS_TOKEN,
    token_length: process.env.FACEBOOK_ACCESS_TOKEN ? process.env.FACEBOOK_ACCESS_TOKEN.length : 0
  })
})

// 注意：其他 API 路由（/api/accounts, /api/ads 等）暂时保留在 index.js 中
// 后续可以逐步迁移到 app.js 或单独的路由文件

export default app

