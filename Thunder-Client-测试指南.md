# Thunder Client 测试指南 - `/api/rule-data` 接口

## 📋 前置步骤：获取认证 Token

### 步骤 1：登录获取 Token

**请求配置：**
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

**响应示例：**
```json
{
  "success": true,
  "message": "登录成功",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin",
    "status": "active",
    "owner_id": 1,
    "owner_name": "负责人名称"
  }
}
```

**重要：** 复制响应中的 `token` 值，后续请求需要使用。

---

## 🧪 测试 `/api/rule-data` 接口

### 基础配置

**Method**: `GET`  
**Base URL**: `http://localhost:3001/api/rule-data`

**Headers 设置：**
```
Content-Type: application/json
Cookie: token=你的token值
```

**或者使用 Authorization Header（如果支持）：**
```
Content-Type: application/json
Authorization: Bearer 你的token值
```

---

## 📝 测试场景

### 场景 1：查询今日数据（today）

**URL**: 
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=today
```

**完整请求示例：**
```
GET http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=today
Cookie: token=你的token值
```

**响应示例：**
```json
{
  "data": [
    {
      "account_id": "act_927139705822379",
      "ad_id": "120240158685270388",
      "ad_name": "9RUf-260115010",
      "spend": 14.02,
      "purchases": 0,
      "roas": 0,
      "cpa": 0,
      "cpc": 0.3595,
      "link_clicks": 39,
      "purchase_value": 0
    }
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

---

### 场景 2：查询过去 7 天数据（last_7_days）

**URL**: 
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=last_7_days
```

**完整请求示例：**
```
GET http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=last_7_days
Cookie: token=你的token值
```

---

### 场景 3：查询过去 30 天数据（last_30_days）

**URL**: 
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=last_30_days
```

**完整请求示例：**
```
GET http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=last_30_days
Cookie: token=你的token值
```

---

### 场景 4：自定义时间范围（custom_range）

**URL**: 
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=custom_range&custom_range={"since":"2026-01-14","until":"2026-01-20"}
```

**注意：** `custom_range` 参数需要 URL 编码。在 Thunder Client 中，你可以：

**方式 1：直接在 URL 中填写（Thunder Client 会自动编码）**
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=custom_range&custom_range={"since":"2026-01-14","until":"2026-01-20"}
```

**方式 2：使用 Query Params 面板**
在 Thunder Client 的 Query Params 面板中：
- `account_id`: `act_927139705822379`
- `time_window`: `custom_range`
- `custom_range`: `{"since":"2026-01-14","until":"2026-01-20"}`

**完整请求示例：**
```
GET http://localhost:3001/api/rule-data?account_id=act_927139705822379&time_window=custom_range&custom_range=%7B%22since%22%3A%222026-01-14%22%2C%22until%22%3A%222026-01-20%22%7D
Cookie: token=你的token值
```

**响应示例（如果有警告）：**
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

---

### 场景 5：查询指定广告的数据

**URL**: 
```
http://localhost:3001/api/rule-data?account_id=act_927139705822379&ad_ids=120240158685270388,120240158567770388&time_window=today
```

**完整请求示例：**
```
GET http://localhost:3001/api/rule-data?account_id=act_927139705822379&ad_ids=120240158685270388,120240158567770388&time_window=today
Cookie: token=你的token值
```

---

## 🔍 参数说明

### 必需参数

| 参数名 | 类型 | 说明 | 示例 |
|--------|------|------|------|
| `account_id` | string | Facebook 账户ID | `act_927139705822379` |

### 可选参数

| 参数名 | 类型 | 说明 | 默认值 | 示例 |
|--------|------|------|--------|------|
| `ad_ids` | string | 广告ID（多个用逗号分隔） | `null`（查询所有广告） | `120240158685270388,120240158567770388` |
| `time_window` | string | 时间窗口类型 | `today` | `today`, `yesterday`, `last_3_days`, `last_7_days`, `last_30_days`, `lifetime`, `custom_range` |
| `custom_range` | string (JSON) | 自定义时间范围（仅当 `time_window=custom_range` 时使用） | `null` | `{"since":"2026-01-14","until":"2026-01-20"}` |

### 时间窗口类型说明

| 类型 | 说明 |
|------|------|
| `today` | 今日数据 |
| `yesterday` | 昨日数据 |
| `last_3_days` | 过去 3 天（包含今天） |
| `last_7_days` | 过去 7 天（包含今天） |
| `last_30_days` | 过去 30 天（包含今天） |
| `lifetime` | 累计至今 |
| `custom_range` | 自定义时间范围（需要提供 `custom_range` 参数） |

---

## 📊 响应格式说明

### 成功响应（200）

```json
{
  "data": [
    {
      "account_id": "string",
      "ad_id": "string",
      "ad_name": "string",
      "ad_set_id": "string",
      "owner_id": number,
      "spend": number,
      "purchases": number,
      "link_clicks": number,
      "unique_link_clicks": number,
      "purchase_value": number,
      "add_to_cart_count": number,
      "initiate_checkout_count": number,
      "add_payment_info_count": number,
      "roas": number,
      "cpa": number,
      "cpc": number,
      "ucpc": number,
      "add_to_cart_cost": number,
      "checkout_cost": number,
      "payment_cost": number
    }
  ],
  "meta": {
    "account_timezone": "string",        // 账户时区（从账户配置获取）
    "display_timezone": "string",        // 显示时区（通常等于 data_timezone_used）
    "data_timezone_used": "string",      // 实际使用的时区（数据时区优先）
    "range": {
      "start": {
        "local": "string",               // 本地时间（数据时区）
        "utc": "string",                 // UTC 时间
        "iso": "string"                  // ISO 8601 格式
      },
      "end": {
        "local": "string",
        "utc": "string",
        "iso": "string"
      },
      "days": number                     // 时间跨度（天数）
    },
    "warnings": [                        // 警告信息数组
      {
        "code": "string",                // 警告代码
        "message": "string"               // 警告消息
      }
    ]
  }
}
```

### 错误响应

**401 未授权：**
```json
{
  "error": "未登录，请先登录",
  "code": "UNAUTHORIZED"
}
```

**400 参数错误：**
```json
{
  "error": "缺少 account_id 参数"
}
```

**500 服务器错误：**
```json
{
  "error": "错误消息"
}
```

---

## 🎯 Thunder Client 使用技巧

### 1. 设置环境变量（推荐）

在 Thunder Client 中创建环境变量：
- `base_url`: `http://localhost:3001`
- `token`: `你的token值`

然后在请求中使用：
```
{{base_url}}/api/rule-data?account_id=act_927139705822379&time_window=today
```

### 2. 保存请求集合

创建一个请求集合，包含：
1. 登录请求（获取 token）
2. 各种时间窗口的查询请求
3. custom_range 查询请求

### 3. 使用 Pre-request Script（可选）

在 Thunder Client 中，你可以使用 Pre-request Script 自动获取 token（如果支持）。

---

## ⚠️ 注意事项

1. **Token 有效期**：Token 有效期为 7 天，过期后需要重新登录
2. **时区处理**：时区从账户配置自动获取，用户无需手动填写
3. **custom_range 格式**：必须是有效的 JSON 对象，日期格式为 `YYYY-MM-DD`
4. **数据源**：
   - `today`、`yesterday`（06:00 前）：从 `ad_snapshots` 查询（热数据）
   - 其他时间窗口：从 `daily_stats` 查询（冷数据，需要聚合）

---

## 🐛 常见问题

### Q1: 返回 401 未授权错误
**A:** 检查 Cookie 中的 token 是否正确设置，或者 token 是否已过期。

### Q2: custom_range 参数解析失败
**A:** 确保 `custom_range` 是有效的 JSON 格式，并且已经 URL 编码。

### Q3: 返回空数据
**A:** 检查：
- 账户ID是否正确
- 时间范围内是否有数据
- 广告ID是否正确（如果指定了 `ad_ids`）

---

## 📚 相关文档

- 时区配置方案：`时区配置方案.md`
- 开发计划：`DEV_PLAN.md`
- 任务清单：`TASKS.md`

