# Thunder Client 测试指南

## 📦 安装 Thunder Client

1. 在 VS Code 中，点击左侧扩展图标（或按 `Ctrl+Shift+X`）
2. 搜索 "Thunder Client"
3. 点击安装（作者：Ranga Vadhineni）

---

## 🔧 设置 Thunder Client

### 1. 打开 Thunder Client

- 点击 VS Code 左侧边栏的 **Thunder Client** 图标（⚡ 闪电图标）
- 或者按快捷键 `Ctrl+Shift+T`

### 2. 创建环境变量（推荐）

**步骤**：
1. 在 Thunder Client 界面，点击右上角的 **"Env"** 标签
2. 点击 **"New Environment"** 创建新环境
3. 命名为 "FB-Ad-Logic-Engine"
4. 添加以下变量：

```
baseUrl: http://localhost:3000
adminToken: YOUR_ADMIN_TOKEN_HERE
staffToken: YOUR_STAFF_TOKEN_HERE
staffToken2: YOUR_STAFF_TOKEN_2_HERE
```

**注意**：需要先获取 token（见下方"获取 Token"部分）

---

## 🔑 获取 Token（如果还没有）

### 方法1：通过登录接口获取

**请求**：
```
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "username": "test2",
  "password": "your_password"
}
```

**响应**：
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 25,
    "username": "test2",
    "role": "staff",
    "owner_id": 5
  }
}
```

**复制返回的 `token` 值，替换到环境变量中**

---

## 📋 测试用例

### 测试1：权限验证（summary 接口 - 非 admin）

**目标**：验证非 admin 用户只能看到自己 owner_id 的统计

**步骤**：
1. 在 Thunder Client 中，点击 **"New Request"**
2. 设置请求：
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs/stats/summary`
   - **Headers**:
     ```
     Authorization: Bearer {{staffToken}}
     ```
3. 点击 **"Send"**

**预期结果**：
- 返回的 `today.success_count` 应该等于 161（owner_id=5 的日志数）
- `today.fail_count` 和 `today.skipped_count` 应该为 0（因为只统计 success）

**验证 SQL**：
```sql
-- 用户 test2 (user_id=25, owner_id=5) 应该看到的统计
SELECT 
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
  SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
FROM automation_logs
WHERE owner_id = 5  -- test2 的 owner_id
  AND status = 'success'  -- 只统计 success
  AND DATE(triggered_at) = CURDATE();
```

---

### 测试2：权限验证（列表接口 - 非 admin）

**目标**：验证非 admin 用户只能看到自己 owner_id 的日志列表

**步骤**：
1. 创建新请求
2. 设置：
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs?page=1&limit=10`
   - **Headers**:
     ```
     Authorization: Bearer {{staffToken}}
     ```
3. 点击 **"Send"**

**预期结果**：
- 返回的日志列表中，所有记录的 `owner_id` 都等于 5
- 所有记录的 `status` 都等于 `'success'`
- 总数应该不超过 161 条

---

### 测试3：权限验证（详情接口 - 非 admin）

**目标**：验证非 admin 用户只能查看自己 owner_id 的日志详情

**步骤**：
1. **测试3.1：访问自己的日志（应该成功）**
   - 先查询一条 owner_id=5 的日志 ID：
     ```sql
     SELECT id FROM automation_logs WHERE owner_id = 5 LIMIT 1;
     ```
   - 假设返回的 ID 是 1234
   - 创建请求：
     - **Method**: `GET`
     - **URL**: `{{baseUrl}}/api/automation-logs/1234`
     - **Headers**:
       ```
       Authorization: Bearer {{staffToken}}
       ```
   - **预期**：返回 200，正常显示详情

2. **测试3.2：访问其他 owner_id 的日志（应该失败）**
   - 查询一条 owner_id=0 的日志 ID：
     ```sql
     SELECT id FROM automation_logs WHERE owner_id = 0 LIMIT 1;
     ```
   - 假设返回的 ID 是 3688
   - 创建请求：
     - **Method**: `GET`
     - **URL**: `{{baseUrl}}/api/automation-logs/3688`
     - **Headers**:
       ```
       Authorization: Bearer {{staffToken}}
       ```
   - **预期**：返回 404，错误信息 "日志不存在或无权访问"

---

### 测试4：展示层过滤验证（列表接口 - 非 admin）

**目标**：验证非 admin 用户默认只看 success，且 `include_all_status` 参数不生效

**步骤**：
1. **测试4.1：不传参数**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs`
   - **Headers**: `Authorization: Bearer {{staffToken}}`
   - **预期**：只返回 `status=success` 的日志

2. **测试4.2：传 include_all_status=true（应该不生效）**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=true`
   - **Headers**: `Authorization: Bearer {{staffToken}}`
   - **预期**：仍然只返回 `status=success` 的日志（参数不生效）

3. **测试4.3：传 include_all_status=True（测试大小写）**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=True`
   - **Headers**: `Authorization: Bearer {{staffToken}}`
   - **预期**：仍然只返回 `status=success` 的日志（参数不生效，且大小写已修复）

---

### 测试5：展示层过滤验证（列表接口 - admin）

**目标**：验证 admin 用户可以通过参数查看全部状态

**步骤**：
1. **测试5.1：不传参数**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs`
   - **Headers**: `Authorization: Bearer {{adminToken}}`
   - **预期**：只返回 `status=success` 的日志（默认行为）

2. **测试5.2：传 include_all_status=true**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=true`
   - **Headers**: `Authorization: Bearer {{adminToken}}`
   - **预期**：返回所有状态的日志（success/fail/skipped）

3. **测试5.3：传 include_all_status=true&status=fail**
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs?include_all_status=true&status=fail`
   - **Headers**: `Authorization: Bearer {{adminToken}}`
   - **预期**：只返回 `status=fail` 的日志（如果有的话）

---

### 测试6：详情接口默认限制 status=success（非 admin）

**目标**：验证非 admin 用户即使知道 fail/skipped 的日志 ID，也无法访问

**步骤**：
1. 查询一条 owner_id=5 的日志（如果有 fail/skipped 的话）：
   ```sql
   SELECT id, status FROM automation_logs WHERE owner_id = 5 AND status != 'success' LIMIT 1;
   ```
2. 如果没有 fail/skipped，可以手动创建一条测试数据（可选）：
   ```sql
   INSERT INTO automation_logs (account_id, ad_id, owner_id, action_type, status, triggered_at)
   VALUES ('act_test', 'ad_test', 5, 'PAUSE', 'fail', NOW());
   SELECT LAST_INSERT_ID();  -- 记录这个 ID
   ```
3. 使用非 admin token 访问这条 fail 日志：
   - **Method**: `GET`
   - **URL**: `{{baseUrl}}/api/automation-logs/{fail_log_id}`
   - **Headers**: `Authorization: Bearer {{staffToken}}`
   - **预期**：返回 404（因为非 admin 默认只看 success）

---

## 📊 验证结果记录表

| 测试项 | 测试用例 | 预期结果 | 实际结果 | 是否通过 |
|--------|---------|---------|---------|---------|
| 权限-1 | summary 接口（非 admin） | 只统计 owner_id=5 的 success | | |
| 权限-2 | list 接口（非 admin） | 只返回 owner_id=5 的 success | | |
| 权限-3 | detail 接口（非 admin-自己的） | 正常返回 | | |
| 权限-4 | detail 接口（非 admin-他人的） | 404 错误 | | |
| 展示-1 | 非 admin，无参数 | 只返回 success | | |
| 展示-2 | 非 admin，include_all_status=true | 仍只返回 success | | |
| 展示-3 | 非 admin，include_all_status=True | 仍只返回 success | | |
| 展示-4 | admin，无参数 | 只返回 success | | |
| 展示-5 | admin，include_all_status=true | 返回全部状态 | | |
| 展示-6 | admin，include_all_status=true&status=fail | 只返回 fail | | |
| 详情-1 | 非 admin 访问 fail 日志 | 404 错误 | | |

---

## 💡 Thunder Client 使用技巧

### 1. 保存请求到集合

- 点击请求右侧的 **"Save"** 按钮
- 可以创建集合（Collection）来组织测试用例

### 2. 使用环境变量

- 在请求 URL 中使用 `{{baseUrl}}` 会自动替换为环境变量值
- 在 Headers 中使用 `{{adminToken}}` 会自动替换为 token

### 3. 查看响应

- 点击 **"Send"** 后，下方会显示响应内容
- 可以查看状态码、响应头、响应体

### 4. 导出/导入

- 可以导出请求集合为 JSON，方便备份和分享
- 可以导入 Postman 的集合（部分兼容）

---

## 🐛 常见问题

### 问题1：401 Unauthorized

**原因**：Token 无效或过期

**解决**：
1. 重新登录获取新 token
2. 更新环境变量中的 token 值

### 问题2：404 Not Found

**原因**：
- URL 路径错误
- 日志 ID 不存在或无权访问

**解决**：
1. 检查 URL 是否正确
2. 检查日志 ID 是否存在
3. 检查权限（非 admin 只能访问自己 owner_id 的日志）

### 问题3：500 Internal Server Error

**原因**：服务器内部错误

**解决**：
1. 查看后端日志
2. 检查数据库连接
3. 检查 SQL 查询是否正确

---

## 📝 快速测试脚本

如果你想快速测试所有接口，可以创建一个请求集合：

1. 在 Thunder Client 中，点击 **"Collections"**
2. 创建新集合 "阶段1验证"
3. 将上述所有测试用例添加到集合中
4. 可以批量运行（如果有批量运行功能）

---

## ✅ 验证完成后的检查清单

- [ ] 所有权限测试通过（非 admin 只能看到自己 owner_id 的日志）
- [ ] 所有展示层过滤测试通过（非 admin 默认只看 success）
- [ ] include_all_status 参数只对 admin 生效
- [ ] 详情接口非 admin 无法访问 fail/skipped 日志
- [ ] summary 接口非 admin 只统计 success
- [ ] 大小写兼容性测试通过（True/TRUE/true）
