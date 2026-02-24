# 用 Thunder Client 验证 /api/structure/objects/multi

按下面步骤在 Thunder Client 里逐条发请求并核对响应即可。

---

## 一、通用设置（每条请求前检查）

1. **方法**：左上角选 **GET**。
2. **Base URL**（不变）：  
   `http://localhost:3001/api/structure/objects/multi`
3. **认证**（二选一）：
   - **方式 A（推荐）**：点 **Headers** 选项卡 → 新增一行：
     - **parameter**：`Authorization`
     - **value**：`Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImlhdCI6MTc3MTkwMDQ5MywiZXhwIjoxNzcyNTA1MjkzfQ.8QRV4jbUyDbPMkeMI79zCJVcCeGa7Er8pm1B8Q2DHnE`  
     （可换成你自己的 token，前面保留 `Bearer ` 和空格）
   - **方式 B**：点 **Auth** 选项卡 → Type 选 **Bearer Token** → 在 Token 框粘贴上述 JWT（不需要写 "Bearer "）。
4. 发请求：点右上角蓝色 **Send**，或按 **Ctrl+Enter**。
5. 看结果：右侧 **Status** 看状态码，**Response** 选项卡看 JSON 内容。

---

## 二、逐条验证

### 用例 1：缺参 account_ids → 400

- **Query**：  
  - 不勾选/不填任何参数，或把 `account_ids`、`type` 都删掉。  
- **URL**：保持为  
  `http://localhost:3001/api/structure/objects/multi`  
  （问号后面不要跟任何参数）。

**发送后检查：**

- **Status**：`400`
- **Response**：有 `"error"`，内容类似「缺少 account_ids 参数」。

---

### 用例 2：type 非法 → 400

- **Query** 选项卡里填：

  | parameter   | value   |
  |------------|---------|
  | account_ids | act_123 |
  | type       | invalid |

- **URL** 会变成：  
  `http://localhost:3001/api/structure/objects/multi?account_ids=act_123&type=invalid`

**发送后检查：**

- **Status**：`400`
- **Response**：有 `"error"`，内容类似「type 只允许 campaign | adset | ad」。

---

### 用例 3：有权限的多账户 → 200

- **Query** 填：

  | parameter   | value |
  |------------|-------|
  | account_ids | act_1905531400268801,act_1501999950830277 |
  | type       | ad    |
  | limit      | 50    |

（若你有自己的两个有权限账户，把 `account_ids` 换成那两个，逗号分隔。）

**发送后检查：**

- **Status**：`200`
- **Response**：
  - 有 `items` 数组，里面每条对象都有 `account_id`，且只出现你传的那两个账户。
  - 有 `meta`：
    - `meta.accounts`、`meta.allowed_accounts` 为 2；
    - `meta.requested_accounts` 为 2。

---

### 用例 4：1 个有权限 + 1 个无权限（需非 admin 账号）

- **Query** 填：

  | parameter   | value |
  |------------|-------|
  | account_ids | act_有权限的id,act_999999999999999 |
  | type       | ad    |
  | limit      | 50    |

把 `act_有权限的id` 换成你**当前登录用户**在后台有权限的账户 ID；`act_999999999999999` 为无权限账户。

**注意**：当前用户若是 **admin**，两个 id 都会放行，会得到 `allowed_accounts=2`。要用**非 admin** 的 token 才能看到下面结果。

**发送后检查（非 admin）：**

- **Status**：`200`
- **Response** 里 `meta`：
  - `meta.requested_accounts` = 2
  - `meta.allowed_accounts` = 1  
  - `items` 里只有有权限账户的数据。

---

### 用例 5：全部无权限 → 403（需非 admin 账号）

- **Query** 填：

  | parameter   | value |
  |------------|-------|
  | account_ids | act_999999999999999 |
  | type       | ad    |
  | limit      | 50    |

**注意**：admin 会放行任意 id，不会 403。需用**非 admin** 的 token。

**发送后检查（非 admin）：**

- **Status**：`403`
- **Response**：有 `"code": "ACCOUNT_FORBIDDEN"`（或等价错误码）。

---

## 三、操作小结

| 步骤 | 操作 |
|------|------|
| 方法 | GET |
| URL 根 | `http://localhost:3001/api/structure/objects/multi` |
| 认证 | Headers 加 `Authorization: Bearer <你的token>` 或 Auth 选 Bearer Token |
| 参数 | 在 **Query** 里填 parameter / value，每行一个参数 |
| 发送 | 点 **Send** 或 Ctrl+Enter |
| 判断 | 看右侧 **Status** 和 **Response** 是否符合上面各用例的期望 |

服务需已启动：在项目目录执行 `npm run dev:server`（默认端口 3001）。
