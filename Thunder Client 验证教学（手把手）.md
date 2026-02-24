# Thunder Client 验证教学（手把手）

## 🎯 第一步：获取 Token（登录）

### 步骤1.1：创建登录请求

1. 在 Thunder Client 界面，点击左上角的 **"New Request"** 按钮（或按 `Ctrl+N`）
2. 你会看到一个新的请求窗口

### 步骤1.2：设置登录请求

**在请求窗口中设置以下内容**：

1. **Method（方法）**：
   - 点击下拉菜单，选择 **`POST`**

2. **URL（地址）**：
   - 在 URL 输入框中输入：
     ```
     http://localhost:3000/api/auth/login
     ```

3. **Headers（请求头）**：
   - 点击 **"Headers"** 标签
   - 点击 **"Add Header"** 或直接输入
   - Key: `Content-Type`
   - Value: `application/json`

4. **Body（请求体）**：
   - 点击 **"Body"** 标签
   - 选择 **"JSON"** 选项（不是 Text）
   - 在输入框中输入：
     ```json
     {
       "username": "test2",
       "password": "你的密码"
     }
     ```
   - **注意**：把 `"你的密码"` 替换成 test2 用户的实际密码

### 步骤1.3：发送请求获取 Token

1. 点击右上角的 **"Send"** 按钮（或按 `Ctrl+Enter`）
2. 等待响应（几秒钟）
3. 在下方 **"Response"** 区域，你会看到返回的 JSON 数据
4. **重要**：找到返回数据中的 `"token"` 字段，复制整个 token 值（很长的一串字符）

**示例响应**：
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MjUsInVzZXJuYW1lIjoidGVzdDIiLCJyb2xlIjoic3RhZmYiLCJpYXQiOjE3MDY0ODk2MDAsImV4cCI6MTcwNjU3NjAwMH0.xxxxx",
  "user": {
    "id": 25,
    "username": "test2",
    "role": "staff",
    "owner_id": 5
  }
}
```

**复制这个 token 值，后面要用！**

---

## 🎯 第二步：设置环境变量（可选但推荐）

### 步骤2.1：创建环境

1. 在 Thunder Client 界面，点击右上角的 **"Env"** 标签
2. 点击 **"New Environment"** 按钮
3. 输入环境名称：`FB-Ad-Logic-Engine`
4. 点击 **"Create"**

### 步骤2.2：添加变量

在环境变量列表中，添加以下变量：

1. **baseUrl**：
   - Key: `baseUrl`
   - Value: `http://localhost:3000`

2. **staffToken**：
   - Key: `staffToken`
   - Value: `粘贴你刚才复制的 token`

3. **adminToken**（如果需要测试 admin）：
   - Key: `adminToken`
   - Value: `admin 用户的 token`（如果暂时没有，可以稍后添加）

4. 点击 **"Save"** 保存

**设置完成后，在请求中可以使用 `{{baseUrl}}` 和 `{{staffToken}}` 来引用这些变量**

---

## 🎯 第三步：测试 Summary 接口（权限验证）

### 步骤3.1：创建新请求

1. 点击 **"New Request"** 创建新请求
2. 给请求命名：`Summary接口-非admin`

### 步骤3.2：设置请求

1. **Method**: `GET`
2. **URL**: 
   - 如果设置了环境变量：`{{baseUrl}}/api/automation-logs/stats/summary`
   - 如果没有设置：`http://localhost:3000/api/automation-logs/stats/summary`

3. **Headers**:
   - 点击 **"Headers"** 标签
   - 添加：
     - Key: `Authorization`
     - Value: `Bearer 你的token`（把"你的token"替换成步骤1.3复制的token）
     - **或者**如果设置了环境变量：`Bearer {{staffToken}}`

### 步骤3.3：发送并验证

1. 点击 **"Send"** 发送请求
2. 查看响应结果

**预期结果**：
```json
{
  "success": true,
  "today": {
    "total": 161,        // 应该是 owner_id=5 的日志总数
    "success_count": 161, // 应该等于 total（因为只统计 success）
    "fail_count": 0,     // 应该是 0
    "skipped_count": 0,  // 应该是 0
    "simulation_count": 0
  },
  "week": [...]
}
```

**验证点**：
- ✅ `success_count` 应该等于 161（owner_id=5 的日志数）
- ✅ `fail_count` 和 `skipped_count` 应该为 0（因为只统计 success）

---

## 🎯 第四步：测试列表接口（权限+过滤验证）

### 步骤4.1：测试1 - 无参数（默认只看 success）

1. 创建新请求：`列表接口-非admin-无参数`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs?page=1&limit=10`
4. **Headers**: `Authorization: Bearer {{staffToken}}` 或 `Bearer 你的token`
5. 点击 **"Send"**

**预期结果**：
```json
{
  "success": true,
  "logs": [
    {
      "id": 1234,
      "owner_id": 5,      // ✅ 所有日志的 owner_id 都应该是 5
      "status": "success", // ✅ 所有日志的 status 都应该是 "success"
      ...
    },
    ...
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 161,         // ✅ 总数应该不超过 161
    "totalPages": 17
  }
}
```

**验证点**：
- ✅ 所有日志的 `owner_id` = 5
- ✅ 所有日志的 `status` = 'success'
- ✅ 总数应该 ≤ 161

---

### 步骤4.2：测试2 - include_all_status=true（应该不生效）

1. 创建新请求：`列表接口-非admin-include_all_status=true`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=true`
4. **Headers**: `Authorization: Bearer {{staffToken}}`
5. 点击 **"Send"**

**预期结果**：
- ✅ 仍然只返回 `status=success` 的日志（参数不生效）
- ✅ 结果应该和测试4.1完全一样

---

### 步骤4.3：测试3 - include_all_status=True（大小写测试）

1. 创建新请求：`列表接口-非admin-include_all_status=True`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=True`
4. **Headers**: `Authorization: Bearer {{staffToken}}`
5. 点击 **"Send"**

**预期结果**：
- ✅ 仍然只返回 `status=success` 的日志（大小写已修复，但仍不生效，因为非 admin）

---

## 🎯 第五步：测试详情接口（权限验证）

### 步骤5.1：先查询一条自己的日志 ID

在 MySQL 中执行：
```sql
SELECT id FROM automation_logs WHERE owner_id = 5 LIMIT 1;
```

假设返回的 ID 是 `1234`（替换成实际值）

### 步骤5.2：测试访问自己的日志（应该成功）

1. 创建新请求：`详情接口-非admin-自己的日志`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs/1234`（替换成实际的 ID）
4. **Headers**: `Authorization: Bearer {{staffToken}}`
5. 点击 **"Send"**

**预期结果**：
```json
{
  "success": true,
  "log": {
    "id": 1234,
    "owner_id": 5,      // ✅ 应该是 5
    "status": "success", // ✅ 应该是 success
    ...
  }
}
```

**验证点**：
- ✅ 返回 200 状态码
- ✅ 正常显示日志详情
- ✅ `owner_id` = 5

---

### 步骤5.3：测试访问他人的日志（应该失败）

1. 创建新请求：`详情接口-非admin-他人的日志(应该404)`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs/3688`（这是 owner_id=0 的日志）
4. **Headers**: `Authorization: Bearer {{staffToken}}`
5. 点击 **"Send"**

**预期结果**：
```json
{
  "error": "日志不存在或无权访问",
  "code": "NOT_FOUND"
}
```

**验证点**：
- ✅ 返回 404 状态码
- ✅ 错误信息："日志不存在或无权访问"

---

## 🎯 第六步：测试 Admin 用户（可选）

如果你有 admin 用户的 token，可以测试：

### 步骤6.1：Admin - include_all_status=true（应该生效）

1. 创建新请求：`列表接口-admin-include_all_status=true`
2. **Method**: `GET`
3. **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=true`
4. **Headers**: `Authorization: Bearer {{adminToken}}`（admin 的 token）
5. 点击 **"Send"**

**预期结果**：
- ✅ 返回所有状态的日志（success/fail/skipped，如果有的话）

---

## 📊 验证结果记录

完成测试后，记录结果：

| 测试项 | 预期结果 | 实际结果 | 是否通过 |
|--------|---------|---------|---------|
| Summary接口 | success_count=161, fail_count=0 | | |
| 列表接口-无参数 | 只返回 owner_id=5 的 success | | |
| 列表接口-include_all_status=true | 仍只返回 success | | |
| 列表接口-include_all_status=True | 仍只返回 success | | |
| 详情接口-自己的日志 | 正常返回 | | |
| 详情接口-他人的日志 | 404 错误 | | |

---

## 💡 Thunder Client 使用技巧

### 1. 保存请求

- 点击请求右侧的 **"Save"** 按钮
- 可以给请求命名，方便下次使用

### 2. 查看历史

- 点击左侧的 **"History"** 可以查看历史请求
- 可以快速重新发送之前的请求

### 3. 复制请求

- 右键点击请求，选择 **"Duplicate"** 可以复制请求
- 方便创建相似的测试用例

### 4. 查看响应详情

- 在 Response 区域可以查看：
  - Status Code（状态码）
  - Headers（响应头）
  - Body（响应体）
  - Time（响应时间）

---

## 🐛 常见问题

### 问题1：401 Unauthorized

**原因**：Token 无效或过期

**解决**：
1. 重新执行步骤1（登录获取新 token）
2. 更新请求中的 token

### 问题2：连接失败

**原因**：后端服务未启动

**解决**：
1. 检查后端服务是否运行在 `http://localhost:3000`
2. 检查防火墙设置

### 问题3：找不到日志

**原因**：日志 ID 不存在或无权访问

**解决**：
1. 先用 SQL 查询确认日志 ID 和 owner_id
2. 确保使用正确的 token（对应正确的 owner_id）

---

## ✅ 完成验证

完成所有测试后，确认：
- [ ] Summary 接口：非 admin 只统计 owner_id=5 的 success
- [ ] 列表接口：非 admin 只返回 owner_id=5 的 success
- [ ] include_all_status 参数：非 admin 传参不生效
- [ ] 详情接口：非 admin 可以访问自己的日志，无法访问他人的日志
- [ ] 详情接口：非 admin 无法访问 fail/skipped 日志（如果存在）

如果所有测试都通过，阶段1验证完成！🎉
