# API 测试指南 - 时区修复验证

## 📋 测试目标

验证 `/api/rule-data` 端点在时区修复后的正确性：
1. ✅ 不再返回空数组（阶段A修复）
2. ✅ 包含历史数据和今天数据（阶段B合并查询）
3. ✅ 正确返回 warnings（TIMEZONE_MISMATCH、HISTORY_EMPTY）
4. ✅ meta 字段包含完整的时区和时间范围信息

---

## 🚀 第一步：启动服务器

```bash
# 在项目根目录执行
npm run dev:server
```

**预期输出**：
```
🚀 服务器运行在 http://localhost:3001
✅ 数据库连接成功
✅ 数据库会话时区已设置为 UTC
```

---

## 🔐 第二步：获取认证 Token

### 方法1：使用 Thunder Client（推荐）

1. **打开 Thunder Client**（VS Code 扩展）

2. **创建登录请求**：
   - **Method**: `POST`
   - **URL**: `http://localhost:3001/api/auth/login`
   - **Headers**: 
     ```
     Content-Type: application/json
     ```
   - **Body** (JSON):
     ```json
     {
       "username": "你的用户名",
       "password": "你的密码"
     }
     ```

3. **发送请求**，查看响应中的 `Cookie` 头：
   - 响应头中会包含 `Set-Cookie: token=xxx; HttpOnly`
   - **复制整个 Cookie 值**（包括 `token=` 前缀）

4. **在后续请求中使用 Cookie**：
   - 在 Thunder Client 的请求中添加 **Headers**：
     ```
     Cookie: token=你复制的完整token值
     ```

### 方法2：使用 curl（命令行）

```bash
# 1. 登录获取 token
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"你的用户名","password":"你的密码"}' \
  -c cookies.txt

# 2. 后续请求使用 cookies.txt
curl -b cookies.txt http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=last_7_days
```

---

## 🧪 第三步：测试 API 端点

### 测试用例 1：last_7_days（验证合并查询）

**请求配置**：
- **Method**: `GET`
- **URL**: `http://localhost:3001/api/rule-data`
- **Query Parameters**:
  ```
  account_id=act_927139705822379
  time_window=last_7_days
  ```
- **Headers**:
  ```
  Cookie: token=你的token值
  ```

**预期响应**：
```json
{
  "data": [
    {
      "ad_id": "test_ad_123456",
      "ad_name": "测试广告",
      "spend": 35.8,
      "purchases": 8,
      "roas": 5.027932960893855,
      "cpa": 4.475,
      ...
    },
    ...
  ],
  "meta": {
    "account_timezone": "UTC",
    "display_timezone": "UTC",
    "data_timezone_used": "UTC",
    "range": {
      "start": {
        "local": "2026-01-14 00:00:00",
        "utc": "2026-01-14 00:00:00",
        "iso": "2026-01-14T00:00:00.000Z"
      },
      "end": {
        "local": "2026-01-20 23:59:59",
        "utc": "2026-01-20 23:59:59",
        "iso": "2026-01-20T23:59:59.999Z"
      },
      "days": 7
    },
    "warnings": [
      {
        "code": "TIMEZONE_MISMATCH",
        "message": "历史数据时区（Asia/Shanghai）与查询时区（UTC）不匹配，已使用数据时区（Asia/Shanghai）查询历史数据"
      }
    ]
  }
}
```

**验证要点**：
- ✅ `data` 数组不为空（至少包含今天的数据）
- ✅ `meta.warnings` 包含 `TIMEZONE_MISMATCH`（如果有时区不匹配）
- ✅ `meta.range.days` 等于 7
- ✅ `meta.range.start` 和 `meta.range.end` 包含 local 和 UTC 双视图

---

### 测试用例 2：today（验证单天查询）

**请求配置**：
- **Method**: `GET`
- **URL**: `http://localhost:3001/api/rule-data`
- **Query Parameters**:
  ```
  account_id=act_927139705822379
  time_window=today
  ```

**预期响应**：
```json
{
  "data": [
    {
      "ad_id": "120240156453030388",
      "ad_name": "QgtK-260116020",
      "spend": 1.22,
      "purchases": 0,
      ...
    },
    ...
  ],
  "meta": {
    "account_timezone": "UTC",
    "display_timezone": "UTC",
    "data_timezone_used": "UTC",
    "range": {
      "start": {
        "local": "2026-01-20 00:00:00",
        "utc": "2026-01-20 00:00:00",
        "iso": "2026-01-20T00:00:00.000Z"
      },
      "end": {
        "local": "2026-01-20 23:59:59",
        "utc": "2026-01-20 23:59:59",
        "iso": "2026-01-20T23:59:59.999Z"
      },
      "days": 1
    },
    "warnings": []
  }
}
```

**验证要点**：
- ✅ `data` 数组不为空
- ✅ `meta.range.days` 等于 1
- ✅ `meta.warnings` 为空（today 查询不应该有 warnings）

---

### 测试用例 3：last_30_days（验证多天查询）

**请求配置**：
- **Method**: `GET`
- **URL**: `http://localhost:3001/api/rule-data`
- **Query Parameters**:
  ```
  account_id=act_927139705822379
  time_window=last_30_days
  ```

**预期响应**：
```json
{
  "data": [...],
  "meta": {
    "account_timezone": "UTC",
    "display_timezone": "UTC",
    "data_timezone_used": "UTC",
    "range": {
      "start": {
        "local": "2025-12-22 00:00:00",
        "utc": "2025-12-22 00:00:00",
        "iso": "2025-12-22T00:00:00.000Z"
      },
      "end": {
        "local": "2026-01-20 23:59:59",
        "utc": "2026-01-20 23:59:59",
        "iso": "2026-01-20T23:59:59.999Z"
      },
      "days": 30
    },
    "warnings": [
      {
        "code": "TIMEZONE_MISMATCH",
        "message": "..."
      }
    ]
  }
}
```

**验证要点**：
- ✅ `data` 数组不为空
- ✅ `meta.range.days` 等于 30
- ✅ 包含历史数据和今天数据（合并查询）

---

### 测试用例 4：custom_range（验证自定义时间范围）

**请求配置**：
- **Method**: `GET`
- **URL**: `http://localhost:3001/api/rule-data`
- **Query Parameters**:
  ```
  account_id=act_927139705822379
  time_window=custom_range
  custom_range={"since":"2026-01-14","until":"2026-01-20"}
  ```
  **注意**：`custom_range` 需要 URL 编码，或者直接在 Thunder Client 中使用 JSON 格式

**预期响应**：
```json
{
  "data": [...],
  "meta": {
    "account_timezone": "UTC",
    "display_timezone": "UTC",
    "data_timezone_used": "UTC",
    "range": {
      "start": {
        "local": "2026-01-14 00:00:00",
        "utc": "2026-01-14 00:00:00",
        "iso": "2026-01-14T00:00:00.000Z"
      },
      "end": {
        "local": "2026-01-20 23:59:59",
        "utc": "2026-01-20 23:59:59",
        "iso": "2026-01-20T23:59:59.999Z"
      },
      "days": 7
    },
    "warnings": []
  }
}
```

**验证要点**：
- ✅ `data` 数组不为空
- ✅ `meta.range.days` 等于 7（2026-01-14 到 2026-01-20）
- ✅ 自定义时间范围正确计算

---

### 测试用例 5：指定广告ID（验证过滤功能）

**请求配置**：
- **Method**: `GET`
- **URL**: `http://localhost:3001/api/rule-data`
- **Query Parameters**:
  ```
  account_id=act_927139705822379
  time_window=last_7_days
  ad_ids=120240156453030388,120240158685270388
  ```

**预期响应**：
```json
{
  "data": [
    {
      "ad_id": "120240156453030388",
      ...
    },
    {
      "ad_id": "120240158685270388",
      ...
    }
  ],
  "meta": {...}
}
```

**验证要点**：
- ✅ `data` 数组只包含指定的广告ID
- ✅ 数据正确聚合（如果同一广告有多天数据）

---

## 📊 测试检查清单

### 基础功能
- [ ] 服务器能正常启动
- [ ] 登录能获取 token
- [ ] API 请求能正常返回（不返回 401/403）

### 数据返回
- [ ] `last_7_days` 返回数据不为空
- [ ] `today` 返回数据不为空
- [ ] `last_30_days` 返回数据不为空
- [ ] `custom_range` 返回数据不为空

### Warnings 验证
- [ ] `TIMEZONE_MISMATCH` warning 正确显示（如果有时区不匹配）
- [ ] `HISTORY_EMPTY` warning 不再错误显示（如果有历史数据）
- [ ] `today` 查询不应该有 warnings

### Meta 字段验证
- [ ] `meta.account_timezone` 正确
- [ ] `meta.display_timezone` 正确
- [ ] `meta.data_timezone_used` 正确
- [ ] `meta.range.start` 和 `meta.range.end` 包含 local、utc、iso
- [ ] `meta.range.days` 正确计算

### 数据聚合验证
- [ ] 同一广告的多天数据正确聚合（避免重复）
- [ ] 历史数据和今天数据正确合并
- [ ] 聚合后的指标（roas、cpa、cpc）正确计算

---

## 🐛 常见问题排查

### 问题1：401 Unauthorized
**原因**：Token 无效或过期
**解决**：重新登录获取新的 token

### 问题2：500 Internal Server Error
**原因**：服务器错误
**解决**：查看服务器日志，检查数据库连接和时区设置

### 问题3：返回空数组
**原因**：可能没有数据或时区不匹配
**解决**：
- 检查数据库中是否有数据
- 检查时区配置是否正确
- 查看 `meta.warnings` 是否有提示

### 问题4：custom_range 参数解析失败
**原因**：JSON 格式错误或 URL 编码问题
**解决**：
- 确保 JSON 格式正确：`{"since":"2026-01-14","until":"2026-01-20"}`
- 在 Thunder Client 中直接使用 JSON 格式，不需要 URL 编码

---

## 💡 测试技巧

1. **使用 Thunder Client 的 Collection 功能**：
   - 创建一个 Collection，保存所有测试用例
   - 可以批量运行测试

2. **查看响应时间**：
   - 正常响应时间应该在 1-3 秒内
   - 如果超过 5 秒，可能是数据库查询慢或网络问题

3. **对比验证**：
   - 对比修复前后的响应结果
   - 确认不再返回空数组
   - 确认 warnings 正确显示

---

## ✅ 测试完成标准

所有测试用例通过，且满足：
1. ✅ 不再返回空数组（阶段A修复）
2. ✅ 包含历史数据和今天数据（阶段B合并查询）
3. ✅ Warnings 正确显示（TIMEZONE_MISMATCH、HISTORY_EMPTY）
4. ✅ Meta 字段完整且正确

---

## 📝 测试记录模板

```
测试时间：2026-01-20 XX:XX
测试人员：你的名字
测试环境：本地开发环境

测试用例1：last_7_days
- 状态：✅ 通过 / ❌ 失败
- 返回记录数：12
- Warnings：1 条（TIMEZONE_MISMATCH）
- 备注：...

测试用例2：today
- 状态：✅ 通过 / ❌ 失败
- 返回记录数：11
- Warnings：0 条
- 备注：...

...
```

---

**开始测试吧！** 🚀

