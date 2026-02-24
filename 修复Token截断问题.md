# 修复 Token 截断问题

## 🔧 问题原因

你的 token 在 Thunder Client 中被截断了，只显示了前面一小部分，导致服务器无法识别。

## ✅ 解决步骤

### 方法1：直接替换整个 Authorization header 值

1. 在 Thunder Client 中，找到 **Headers** 标签
2. 找到 `Authorization` 这一行
3. **删除现有的值**（`eyJhbGciOiJlUzI1NilsInR5cCl6lk`）
4. **完整粘贴你的 token**：
   ```
   Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg0ODMsImV4cCI6MTc3MDE5MzI4M30.ZaM8pcqot9YcqLb7hjAchsXW9P83j60Yn7fWU37aTX4
   ```
   **注意**：前面要有 `Bearer `（Bearer + 空格）

### 方法2：使用环境变量（推荐）

1. 在 Thunder Client 中，点击右上角的 **"Env"** 标签
2. 创建或编辑环境变量：
   - Key: `staffToken`
   - Value: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg0ODMsImV4cCI6MTc3MDE5MzI4M30.ZaM8pcqot9YcqLb7hjAchsXW9P83j60Yn7fWU37aTX4`
   - **注意**：只填 token 值，不要加 `Bearer`
3. 保存环境变量
4. 在请求的 Headers 中，设置：
   - Key: `Authorization`
   - Value: `Bearer {{staffToken}}`

## 📋 完整操作步骤

### 步骤1：删除旧的 Authorization header

1. 在 Thunder Client 的 Headers 标签中
2. 找到 `Authorization` 这一行
3. 点击右侧的 **删除按钮**（垃圾桶图标）或清空 Value 字段

### 步骤2：添加新的 Authorization header

1. 点击 **"Add Header"** 或直接在 Authorization 行输入
2. Key: `Authorization`
3. Value: 
   ```
   Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg0ODMsImV4cCI6MTc3MDE5MzI4M30.ZaM8pcqot9YcqLb7hjAchsXW9P83j60Yn7fWU37aTX4
   ```
   **重要**：
   - 前面必须有 `Bearer `（Bearer + 空格）
   - 后面是完整的 token（不要有任何截断）
   - 确保没有多余的空格或换行

### 步骤3：验证 token 格式

完整的 Authorization header 应该是：
```
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg0ODMsImV4cCI6MTc3MDE5MzI4M30.ZaM8pcqot9YcqLb7hjAchsXW9P83j60Yn7fWU37aTX4
```

**检查点**：
- ✅ 以 `Bearer ` 开头（注意有空格）
- ✅ token 是完整的（很长的一串，包含两个点 `.`）
- ✅ 没有换行或截断

### 步骤4：发送请求

1. 点击 **"Send"** 按钮
2. 应该返回 200 状态码，而不是 401

## 🔍 如何确认 token 是否完整

JWT token 的格式是：`header.payload.signature`

你的 token 应该包含：
- 第一部分（header）：`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`
- 第二部分（payload）：`eyJ1c2VySWQiOjI1LCJpYXQiOjE3Njk1ODg0ODMsImV4cCI6MTc3MDE5MzI4M30`
- 第三部分（signature）：`ZaM8pcqot9YcqLb7hjAchsXW9P83j60Yn7fWU37aTX4`

**如果 token 被截断，你会看到类似**：
- `eyJhbGciOiJlUzI1NilsInR5cCl6lk`（只有前面一小部分，没有两个点分隔符）

## 💡 防止 token 截断的技巧

1. **复制时注意**：确保复制完整的 token（从 `eyJ` 开始到最后一个字符）
2. **粘贴时注意**：粘贴后检查是否完整
3. **使用环境变量**：把 token 存到环境变量中，避免每次都要复制粘贴
4. **检查长度**：完整的 JWT token 通常很长（100+ 字符），如果太短可能被截断了

## ✅ 修复后的预期结果

修复后，再次发送请求应该返回：

```json
{
  "success": true,
  "today": {
    "total": 161,
    "success_count": 161,
    "fail_count": 0,
    "skipped_count": 0,
    "simulation_count": 0
  },
  "week": [...]
}
```

而不是：
```json
{
  "error": "登录已过期,请重新登录",
  "code": "TOKEN_EXPIRED"
}
```
