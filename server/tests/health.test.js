// 健康检查接口测试
// 这是我们的第一个测试用例，用于验证架构分离是否成功
import request from 'supertest'
import app from '../app.js'

// describe：测试套件，用于组织相关的测试用例
describe('GET /api/health', () => {
  // it：单个测试用例
  it('应该返回 200 状态码', async () => {
    // request(app)：使用 Supertest 测试 Express 应用
    // 注意：这里直接使用 app 对象，不需要启动真实服务器！
    const res = await request(app).get('/api/health')
    
    // expect：断言，验证结果是否符合预期
    expect(res.status).toBe(200)
  })

  it('应该返回正确的响应体结构', async () => {
    const res = await request(app).get('/api/health')
    
    // 验证响应体包含必要的字段
    expect(res.body).toHaveProperty('status', 'ok')
    expect(res.body).toHaveProperty('message', '服务器运行正常')
    expect(res.body).toHaveProperty('timestamp')
    expect(res.body).toHaveProperty('token_configured')
    expect(res.body).toHaveProperty('token_length')
  })

  it('timestamp 应该是有效的 ISO 日期字符串', async () => {
    const res = await request(app).get('/api/health')
    
    // 验证 timestamp 是有效的日期
    const timestamp = new Date(res.body.timestamp)
    expect(timestamp.toString()).not.toBe('Invalid Date')
  })
})


