// Vitest 测试框架配置
// 注意：Vitest 原生支持 ESM，无需特殊配置
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 测试环境：Node.js（不是浏览器环境）
  test: {
    // 测试文件匹配规则：只测试 server/tests 目录下的 .test.js 文件
    include: ['**/server/tests/**/*.test.js'],
    
    // 测试环境：Node.js
    environment: 'node',
    
    // 全局设置：可以在测试文件中直接使用 describe, it, expect 等，无需导入
    globals: true,
    
    // 覆盖率配置
    coverage: {
      // 覆盖率收集范围：收集 server 目录下所有 .js 文件的覆盖率
      include: ['server/**/*.js'],
      // 排除测试文件本身和服务器启动文件
      exclude: [
        'server/tests/**',      // 排除测试文件
        'server/server.js'       // 排除服务器启动文件（不需要测试启动逻辑）
      ],
      // 覆盖率报告输出目录
      reportsDirectory: './coverage',
      // 覆盖率提供者（使用 v8，性能更好）
      provider: 'v8'
    },
    
    // 详细输出：显示每个测试用例的结果
    reporter: ['verbose'],
    
    // 测试超时时间（毫秒）
    testTimeout: 10000
  }
})


