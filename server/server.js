// 服务器启动入口 - 负责启动 Express 应用
// 注意：dotenv.config() 必须在第一行，确保环境变量在应用加载前就配置好
import dotenv from 'dotenv'
dotenv.config()

// 配置全局代理环境变量（让Node.js自动使用）
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  // 设置Node.js标准代理环境变量
  process.env.http_proxy = proxyUrl
  process.env.https_proxy = proxyUrl
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  console.log('🌐 已设置全局代理环境变量')
}

// 引入 Express 应用配置（不包含启动逻辑）
// 注意：需要先导入 index.js 以注册 API 路由
import './index.js'  // 导入以注册 API 路由
import app from './app.js'
import { startCronJob } from './services/cronService.js'

// 获取端口号（从环境变量或使用默认值）
const PORT = process.env.PORT || 3001

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
  console.log(`📡 API端点: http://localhost:${PORT}/api`)
  console.log(`🏥 健康检查: http://localhost:${PORT}/api/health`)
  console.log('')
  
  const token = process.env.FACEBOOK_ACCESS_TOKEN
  if (!token) {
    console.warn('⚠️  警告: FACEBOOK_ACCESS_TOKEN 未配置，请在 .env 文件中设置')
  } else {
    console.log('✅ FACEBOOK_ACCESS_TOKEN 已配置')
    console.log('🔑 Token前10位:', token.substring(0, 10) + '...')
    console.log('')
  }
  
  console.log('💡 提示: 查看控制台日志以获取详细的API调用信息')
  console.log('')
  
  // 启动定时任务（每 15 分钟自动执行规则）
  startCronJob()
})

