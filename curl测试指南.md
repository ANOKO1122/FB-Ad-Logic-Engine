# curl 测试指南：规则执行摘要查询接口

## 📋 前置准备

### 1. 获取 Token

**方法1：通过登录接口获取**

```bash
# 登录 admin
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"你的密码\"}"

# 从返回的 JSON 中复制 token 字段
```

**方法2：使用测试脚本**

运行 `test-curl-summaries.bat`（Windows）或 `test-curl-summaries.sh`（Linux/Mac），脚本会提示你输入 token。

---

## 🔧 基础 curl 命令格式

```bash
curl -X GET "http://localhost:3000/api/路径?参数=值" \
  -H "Authorization: Bearer 你的token" \
  -H "Content-Type: application/json"
```

**参数说明**：
- `-X GET`：HTTP 方法（GET/POST/PUT/DELETE）
- `-H`：HTTP 请求头
- `-d`：POST 请求的请求体（JSON）
- `-s`：静默模式（不显示进度条）
- `| jq '.'`：格式化 JSON 输出（需要安装 jq，可选）

---

## ✅ 测试步骤

### 步骤1：登录获取 admin token

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"你的密码\"}"
```

**返回示例**：
```json
{
  "success": true,
  "message": "登录成功",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { ... }
}
```

**复制 `token` 字段的值**，后续测试会用到。

---

### 步骤2：查询摘要列表（基础）

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

**预期返回**：
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "run_id": "1769595550135-3i330iys2",
      "rule_id": 138,
      "rule_name": "test",
      "account_id": "act_xxx",
      "status": "skipped",
      "skip_reason": "account_mismatch",
      "evaluated_at": "2026-01-29 02:18:43",
      ...
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 20,
    "totalPages": 2
  }
}
```

---

### 步骤3：按条件筛选

#### 3.1 按账户筛选

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?account_id=act_1113604493975536&page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

#### 3.2 按状态筛选

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?status=skipped&page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

#### 3.3 按跳过原因筛选

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?skip_reason=account_mismatch&page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

#### 3.4 按时间范围筛选

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?start_date=2026-01-28&end_date=2026-01-29&page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

#### 3.5 组合筛选

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?status=skipped&skip_reason=no_permission&page=1&limit=10" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

---

### 步骤4：查询统计

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries/stats" \
  -H "Authorization: Bearer 你的admin_token" \
  -H "Content-Type: application/json"
```

**预期返回**：
```json
{
  "success": true,
  "data": {
    "total": {
      "total": 20,
      "total_matched": 0,
      "total_executed": 0,
      "total_failed": 0,
      "avg_duration_ms": 123.45
    },
    "by_status": [
      { "status": "skipped", "count": 15 },
      { "status": "no_match", "count": 5 }
    ],
    "by_skip_reason": [
      { "skip_reason": "account_mismatch", "count": 10 },
      { "skip_reason": "no_permission", "count": 5 }
    ]
  }
}
```

---

### 步骤5：验证权限（非 admin 应返回 403）

#### 5.1 先获取 staff token（test2）

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"test2\",\"password\":\"你的密码\"}"
```

#### 5.2 用 staff token 访问摘要接口

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?page=1&limit=10" \
  -H "Authorization: Bearer 你的staff_token" \
  -H "Content-Type: application/json"
```

**预期返回**（403 权限错误）：
```json
{
  "success": false,
  "error": "仅管理员可查看规则执行摘要"
}
```

---

## 🎯 快速测试（Windows）

### 方法1：使用测试脚本（推荐）

```bash
# 运行测试脚本
test-curl-summaries.bat

# 按提示输入 admin token 和 staff token
```

### 方法2：手动执行命令

**1. 登录获取 token**：
```bash
curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"你的密码\"}"
```

**2. 复制返回的 token，替换下面的 `你的admin_token`**：
```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?page=1&limit=5" -H "Authorization: Bearer 你的admin_token"
```

---

## 💡 提示

### Windows 下的注意事项

1. **引号处理**：Windows CMD 中，URL 参数里的 `&` 需要用 `^` 转义，或者用双引号包裹整个 URL
2. **JSON 格式**：POST 请求的 JSON 需要用双引号，Windows CMD 中需要转义：
   ```bash
   curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"123456\"}"
   ```
3. **多行命令**：Windows CMD 中用 `^` 换行，PowerShell 中用反引号 `` ` ``

### 格式化输出（可选）

如果安装了 `jq`（JSON 格式化工具），可以在命令后加 `| jq '.'`：

```bash
curl -X GET "http://localhost:3000/api/rule-execution-summaries?page=1&limit=5" \
  -H "Authorization: Bearer 你的admin_token" \
  | jq '.'
```

**安装 jq（Windows）**：
- 下载：https://github.com/jqlang/jq/releases
- 或使用 Chocolatey：`choco install jq`

---

## ✅ 验证清单

- [ ] Admin 可以查询摘要列表
- [ ] Admin 可以按条件筛选（账户、状态、跳过原因、时间范围）
- [ ] Admin 可以查询统计
- [ ] 非 admin（staff）访问返回 403
- [ ] 返回的时间字段是 UTC（前端会转成北京时区显示）

---

## 🔍 排障

**问题1：返回 401 Unauthorized**
- 检查 token 是否正确
- 检查 Authorization header 格式：`Bearer <token>`（注意 Bearer 后面有空格）

**问题2：返回 403 Forbidden**
- 确认使用的是 admin token（不是 staff token）
- 检查用户角色是否为 'admin'

**问题3：返回空数组**
- 检查是否有摘要数据（查询数据库确认）
- 检查筛选条件是否太严格

**问题4：Windows 下命令执行失败**
- 使用双引号包裹整个 URL
- 检查 JSON 中的引号是否正确转义
- 尝试在 PowerShell 中执行（而不是 CMD）
