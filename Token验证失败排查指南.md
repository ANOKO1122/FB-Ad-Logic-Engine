# Token 验证失败排查指南

## 🔍 问题分析

你遇到 `TOKEN_EXPIRED` 错误，可能的原因有：

1. **后端服务没有重启**（最可能）
2. **Token 验证失败**（JWT_SECRET 不匹配、token 格式错误等）
3. **Authorization header 格式错误**

---

## ✅ 排查步骤

### 步骤1：确认后端服务已重启

**重要**：修改代码后，必须重启后端服务才能生效！

**检查方法**：
1. 查看后端服务的终端/控制台
2. 确认服务是否在运行
3. 如果服务正在运行，**停止它**（按 `Ctrl+C`）
4. **重新启动服务**：
   ```bash
   npm start
   # 或
   node server/server.js
   ```

**验证重启成功**：
- 查看控制台是否有启动日志
- 确认服务监听在 `http://localhost:3000`

---

### 步骤2：检查后端日志

**在发送请求时，查看后端控制台的输出**：

如果看到类似这样的日志：
```
❌ Token 验证失败: {
  hasToken: true,
  tokenLength: 150,
  tokenPrefix: 'eyJhbGciOiJIUzI1NiIs',
  decoded: null
}
```

这说明：
- Token 已经读取到了（`hasToken: true`）
- 但验证失败（`decoded: null`）

**可能原因**：
- JWT_SECRET 不匹配
- Token 格式错误
- Token 确实过期了

---

### 步骤3：验证 Token 是否真的过期

**你的 token payload**：
```json
{
  "userId": 25,
  "iat": 1769588962,  // 签发时间
  "exp": 1770193762   // 过期时间
}
```

**检查方法**：
1. 打开浏览器控制台（F12）
2. 运行以下代码：
   ```javascript
   const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg5NjIsImV4cCI6MTc3MDE5Mzc2Mn0.OG_2WDiODIOJ3PV6HwfuDhPqpf9Ly-8pI01Wu2j2zaI"
   const payload = JSON.parse(atob(token.split('.')[1]))
   console.log('签发时间:', new Date(payload.iat * 1000))
   console.log('过期时间:', new Date(payload.exp * 1000))
   console.log('当前时间:', new Date())
   console.log('是否过期:', new Date() > new Date(payload.exp * 1000))
   ```

**如果显示"已过期"**：
- Token 确实过期了，需要重新登录获取新 token

**如果显示"未过期"**：
- 问题可能是 JWT_SECRET 不匹配或其他原因

---

### 步骤4：检查 Authorization Header 格式

**正确的格式**：
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg5NjIsImV4cCI6MTc3MDE5Mzc2Mn0.OG_2WDiODIOJ3PV6HwfuDhPqpf9Ly-8pI01Wu2j2zaI
```

**检查点**：
- ✅ 前面有 `Bearer `（Bearer + 空格）
- ✅ token 是完整的（没有截断）
- ✅ 没有多余的空格或换行

**在 Thunder Client 中检查**：
1. 点击 **Headers** 标签
2. 找到 `Authorization` 这一行
3. 确认 Value 是：`Bearer 你的完整token`
4. 如果 Value 中有换行，删除换行

---

### 步骤5：测试 Token 是否有效

**创建一个简单的测试请求**：

1. 在 Thunder Client 中创建新请求
2. Method: `GET`
3. URL: `http://localhost:3000/api/auth/me`
4. Headers: `Authorization: Bearer 你的token`
5. 点击 Send

**预期结果**：
- 如果返回 200 和用户信息：Token 有效，问题可能在 Summary 接口
- 如果返回 401：Token 无效，需要重新登录

---

## 🔧 解决方案

### 方案1：重启后端服务（最可能解决问题）

1. **停止当前服务**（在运行服务的终端按 `Ctrl+C`）
2. **重新启动**：
   ```bash
   npm start
   ```
3. **等待服务启动完成**
4. **重新测试 Summary 接口**

---

### 方案2：重新登录获取新 Token

如果 token 确实过期了：

1. **重新发送登录请求**：
   - Method: `POST`
   - URL: `http://localhost:3000/api/auth/login`
   - Body: `{"username": "test2", "password": "你的密码"}`
2. **复制新的 token**
3. **更新 Summary 请求的 Authorization header**

---

### 方案3：检查 JWT_SECRET

如果重启后还是不行，可能是 JWT_SECRET 不匹配：

1. **检查 `.env` 文件**（如果有）：
   ```env
   JWT_SECRET=fb_ad_brain_secret_key_2024
   ```

2. **确认登录和验证使用相同的 JWT_SECRET**：
   - 登录接口：`server/routes/auth.js` 使用 `signToken()`
   - 验证中间件：`server/middleware/authJwt.js` 使用 `verifyToken()`
   - 两者都使用 `JWT_SECRET`（默认值：`fb_ad_brain_secret_key_2024`）

---

## 📋 完整检查清单

完成以下检查：

- [ ] 后端服务已重启（修改代码后必须重启）
- [ ] Authorization header 格式正确（`Bearer 完整token`）
- [ ] Token 没有过期（检查 exp 时间戳）
- [ ] 后端日志显示 token 已读取（`hasToken: true`）
- [ ] JWT_SECRET 匹配（登录和验证使用相同的 secret）

---

## 🐛 如果还是不行

**请提供以下信息**：

1. **后端控制台的完整错误日志**（特别是 `❌ Token 验证失败` 的日志）
2. **Thunder Client 的请求详情**：
   - Method
   - URL
   - Headers（特别是 Authorization 的值）
3. **Token 的 payload**（解码后的内容）
4. **后端服务是否已重启**

这样我可以更准确地帮你定位问题。
