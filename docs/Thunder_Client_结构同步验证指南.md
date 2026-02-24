# Thunder Client 结构同步（POST /api/sync/structure）验证指南

本文档手把手教你用 Thunder Client 完成「手动同步结构」的本地自测，包括：第一次同步（200）、冷却期（429）、可选锁占用（409）及常见报错排查。

---

## 前置条件

- 已安装 Thunder Client（VS Code / Cursor 扩展）
- 后端已执行迁移 `014_create_structure_ads.sql`，存在 `structure_ads` 表
- 环境变量：`.env` 中已配置 `FACEBOOK_ACCESS_TOKEN`（有效 Token）
- 你有一个可用的广告账户 ID（如 `act_123456789`），且该账户已映射到当前登录用户（`account_mappings` 中该用户有权限）

---

## 一、启动服务

1. 在项目根目录打开终端，执行：
   ```bash
   npm run dev:server
   ```
   或你平时的启动命令（如 `npm run dev:all`）。
2. 确认终端无报错，看到类似：
   ```text
   🚀 服务器运行在 http://0.0.0.0:3001
   ```
3. 记下实际端口（默认 `3001`，若设置了 `PORT` 则以 `.env` 为准）。

---

## 二、获取登录 Token（用于 Authorization）

接口需要登录态，Thunder Client 用 **Authorization: Bearer &lt;token&gt;** 最方便。

### 2.1 新建「登录」请求

1. Thunder Client 左侧点 **New Request**（或 `Ctrl+N`）。
2. 方法选 **POST**。
3. URL 填（端口改成你实际用的，下同）：
   ```text
   http://localhost:3001/api/auth/login
   ```
4. **Headers** 里加一行：
   - Key: `Content-Type`  
   - Value: `application/json`
5. **Body** 选 **JSON**，内容示例（用户名密码改成你的）：
   ```json
   {
     "username": "test2",
     "password": "你的密码"
   }
   ```
6. 点 **Send**，在 Response 里找到 `token` 字段，**整段复制**（一串很长的 JWT）。

### 2.2 用环境变量存 Token（推荐）

1. 点 Thunder Client 右上角 **Env**。
2. 新建或选中环境（如 `FB-Ad-Logic-Engine`）。
3. 添加变量：
   - `baseUrl` = `http://localhost:3001`（端口按实际）
   - `authToken` = 粘贴刚才复制的 token
4. **Save**，并在下拉里选中该环境，这样后面请求可用 `{{baseUrl}}`、`{{authToken}}`。

---

## 三、第一次同步（期望 200）

### 3.1 新建请求

1. **New Request**，方法选 **POST**。
2. URL：
   ```text
   {{baseUrl}}/api/sync/structure
   ```
   或写死：`http://localhost:3001/api/sync/structure`。
3. **Headers**：
   - `Content-Type` = `application/json`
   - `Authorization` = `Bearer {{authToken}}`  
     若没用环境变量，则写：`Bearer 你复制的token`（注意 Bearer 后有一个空格，token 不要带引号、不要换行）。
4. **Body** 选 **JSON**：
   ```json
   {
     "account_id": "act_你的账户"
   }
   ```
   把 `act_你的账户` 换成你有权限的真实广告账户 ID（如 `act_123456789`）。

### 3.2 发送并检查响应

1. 点 **Send**。
2. **期望**：
   - **Status: 200**
   - Body 示例：
     ```json
     {
       "ok": true,
       "account_id": "act_123456789",
       "synced_count": 42,
       "duration_ms": 1500
     }
     ```
   - `synced_count` &gt; 0，`duration_ms` 有数值。

### 3.3 在 MySQL 里验证

执行（账户 ID 换成你用的）：

```sql
SELECT COUNT(*), MAX(last_synced_at)
FROM structure_ads
WHERE account_id = 'act_你的账户';
```

- 应有至少一行结果。
- `COUNT(*)` &gt; 0。
- `MAX(last_synced_at)` 为刚才请求完成后的时间（几秒内）。

---

## 四、冷却期验证（2 分钟内再调，期望 429）

1. **不要改任何参数**，用同一个请求再点一次 **Send**（距第一次成功同步 &lt; 2 分钟）。
2. **期望**：
   - **Status: 429**
   - Body 示例：
     ```json
     {
       "ok": false,
       "reason": "cooldown",
       "retry_after_sec": 90
     }
     ```
   - `reason` 为 `cooldown`，`retry_after_sec` 为剩余冷却秒数（正数）。
3. **再次查库**（同上 SQL）：
   - `MAX(last_synced_at)` **不应变化**，仍是第一次同步的时间。

---

## 五、（可选）锁占用验证（409）

用两个客户端几乎同时发**同一 account_id** 的同步请求，其中一个应得到 409。

### 方法 A：Thunder Client 开两个窗口

1. 复制当前「结构同步」请求（或再建一个相同配置的请求）。
2. 在两个请求里都填**同一个** `account_id`，且都带有效 `Authorization`。
3. 先点第一个请求的 **Send**，**立刻**点第二个请求的 **Send**（间隔尽量小，&lt; 1 秒）。
4. **期望**：
   - 一个请求 **200**（先拿到锁的）。
   - 另一个请求 **409**，Body 示例：
     ```json
     {
       "ok": false,
       "reason": "lock_busy"
     }
     ```

### 方法 B：Thunder Client + curl

1. Thunder Client 发一次 POST `/api/sync/structure`（保持不关）。
2. 在终端立刻执行（替换 `YOUR_TOKEN` 和 `act_你的账户`）：
   ```bash
   curl -X POST "http://localhost:3001/api/sync/structure" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -d "{\"account_id\": \"act_你的账户\"}"
   ```
3. 两个请求中一个 200、一个 409 即符合预期。

---

## 六、常见报错与排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| **401** | 未登录或 Token 无效 | 检查 Headers 里 `Authorization: Bearer &lt;token&gt;` 是否正确；Token 是否从登录接口新拿的、无多余空格/换行；必要时重新登录复制 token。 |
| **401**（Facebook 相关） | 服务端未配置 FB Token | 检查 `.env` 中 `FACEBOOK_ACCESS_TOKEN` 是否配置且有效。 |
| **403** | 当前用户无该账户权限 | 检查 `account_mappings` / `assertAccountAccess`：当前登录用户是否拥有该 `account_id`。 |
| **500** + 表不存在 | 未执行迁移 014 | 执行 `server/db/migrations/014_create_structure_ads.sql`。 |
| **500** + FB API 错误 | Token 失效、网络或 FB 限流 | 检查 Token 是否过期、网络/代理、FB 返回的具体错误信息（看服务端日志）。 |

---

## 七、Thunder Client 请求汇总（复制即用）

- **Base URL**（按你实际端口改）：`http://localhost:3001`
- **登录**：`POST {{baseUrl}}/api/auth/login`，Body JSON：`{"username":"你的用户名","password":"你的密码"}`，从响应取 `token`。
- **结构同步**：`POST {{baseUrl}}/api/sync/structure`  
  - Headers：`Content-Type: application/json`，`Authorization: Bearer {{authToken}}`  
  - Body：`{"account_id":"act_你的账户"}`  

按「二 → 三 → 四 → 五」顺序执行即可完成全部验证。
