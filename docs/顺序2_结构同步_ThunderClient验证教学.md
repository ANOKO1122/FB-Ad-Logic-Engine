# 顺序2 结构同步 — Thunder Client 手把手验证教学

配合《顺序2_结构同步_验证与测试清单.md》使用，用 **Thunder Client**（或 curl / REST Client）完成全部 8 项验证。  
下面先按 **Thunder Client 界面** 一步步教你怎么点、怎么填，再给出每条用例的完整配置与验收标准。

---

## 工具选择（任选其一即可）

| 工具 | 说明 |
|------|------|
| **Thunder Client**（推荐） | 你截图里的插件，在 Cursor/VS Code 里直接发请求，不用切窗口；支持环境变量、收藏请求。 |
| **VS Code REST Client** | 在 `.http` 文件里写请求，点 "Send Request" 发送；适合把用例当文档保存。 |
| **curl** | 命令行，复制即用，适合 CI 或不想装插件时。 |

本教学以 **Thunder Client** 为主；文末会给出 REST Client 和 curl 的等价示例。  
下文中的 URL 一律直接写成 **`http://localhost:3000/...`**（本机）。若服务在 192.168.0.67，把 `localhost` 换成 `192.168.0.67` 即可。

---

## 哪些验证用管理员、哪些用普通用户

| 验证项 | 用谁登录 / 用谁发请求 | 说明 |
|--------|------------------------|------|
| **登录（第 0 步）** | 管理员 或 普通用户 均可 | 测用例 1～7 时用**管理员**（或该账户负责人）登录拿 token；测用例 8 时需再用**普通用户**登录拿另一个 token。 |
| **用例 1：手动同步全量** | **管理员** 或 **该账户的负责人** | 只有管理员、或 `account_mappings` 里该 `account_id` 的负责人，才能调 `POST /api/sync/structure` 成功；否则 403。 |
| **用例 2～7** | 不区分（脚本 + 日志 + SQL） | 2～7 主要是执行 `node server/scripts/manual-unified-heartbeat.js`、看后端日志、跑 SQL，不通过 Thunder Client 用「谁」发请求。若你前面用例 1 已用管理员通过，保持即可。 |
| **用例 8：权限与安全** | **必须用普通用户**（非管理员、且不是该账户负责人） | 用**普通用户 B** 的 token，请求里填**他人**的 `account_id`，预期 **403**。若用管理员，会 200，无法验证「越权被拦」。 |

**操作建议**：  
- 先**用管理员**登录 → 完成用例 1～7（登录、手动同步、心跳脚本、日志、SQL、轮转、Piggyback 等）。  
- 再**用普通用户 B** 登录一次，拿 B 的 token → 单独发一条「手动同步他人账户」的请求 → 看是否 403（用例 8）。

---

## 怎么验证和测试（最小流程）

按下面顺序做一遍即可。URL 直接写 **`http://localhost:3000`** 开头（若服务在 192.168.0.67，把 `localhost` 换成 `192.168.0.67`）。

1. **启动后端**  
   `npm run dev` 或 `node server/index.js`，确认端口 3000 已监听。

2. **用管理员登录拿 token**  
   - POST **`http://localhost:3000/api/auth/login`**  
   - Body（JSON）：`{"username":"管理员用户名","password":"管理员密码"}`  
   - Send → Status 200 → 复制响应里的 `token`，保存好（后面用例 1～7 的 Headers 里要用）。

3. **测手动同步（用例 1）**  
   - POST **`http://localhost:3000/api/sync/structure`**  
   - Headers：`Authorization` = `Bearer 刚复制的token`，`Content-Type` = `application/json`  
   - Body（JSON）：`{"account_id":"你的act_xxx"}`  
   - Send → Status 200，Body 有 `ok: true`、`synced_count`；后端日志有 `[2.4] 结构同步完成 ... mode=full`。

4. **用 SQL 验证**  
   `SELECT account_id, has_full_synced, last_full_count, last_full_success_at FROM structure_sync_status WHERE account_id = '你的act_xxx';`  
   该行应为 `has_full_synced=1`，`last_full_count` 为正数。

5. **用例 2～7**  
   按文档后面执行 `node server/scripts/manual-unified-heartbeat.js`、看日志、跑对应 SQL。

6. **用例 8（权限）**  
   **用普通用户 B** 登录 → 拿 B 的 token → POST **`http://localhost:3000/api/sync/structure`**，Headers 用 B 的 `Bearer token`，Body 里 `account_id` 填**他人**的账户 → 预期 **403**。

---

## Thunder Client 界面说明（对照你截图）

- **最上方一排**：左边 **Method 下拉**（选 GET/POST 等）→ 中间 **URL 输入框** → 右边蓝色 **Send**。
- **左侧请求配置**：**Query**（URL 参数）、**Headers**（请求头）、**Auth**、**Body**（POST 时用）、Tests、Pre Run。
- **右侧**：发送后显示 **Status**（状态码）、**Size**、**Time**，下面 **Response** 里是返回内容。

发请求时：先选 Method、填 URL，再在 **Headers** 里加 `Authorization`，POST 时在 **Body** 里选 JSON 并写内容，最后点 **Send**。  
环境变量用法：URL 或 Body 里写 `{{变量名}}`，例如 `{{baseUrl}}`、`{{token}}`。

---

## 前置准备（必做）

### 1. 服务与数据库

- 后端已启动：`npm run dev` 或 `node server/index.js`，默认 `http://localhost:3000`。
- MySQL 已就绪，能执行文档中的 SQL（如 DBeaver、MySQL Workbench、或 VS Code SQL 插件）。
- 环境变量已配置：至少 `FACEBOOK_ACCESS_TOKEN`、数据库连接。

### 2. 准备两个账号（用于用例 8 权限测试）

- **账号 A**：管理员，或某账户的负责人（`account_mappings` 里该账户的 `owner_id` 对应用户）。
- **账号 B**：普通用户，且**不是**你要测的那几个 `act_xxx` 的负责人。

若暂时只有管理员，用例 8 可先跳过或仅测「用他人 account_id 调接口是否 403」。

### 3. Thunder Client 环境变量（推荐）

**baseUrl 用哪个？**

- **本机测本机**（后端和 Thunder Client 都在当前电脑）：用 **`http://localhost:3000`**（不要末尾斜杠）。
- **服务在另一台机器**（例如后端跑在 192.168.0.67）或从他机/手机访问：用 **`http://192.168.0.67:3000`**。

在 Thunder Client 里建 **Environment**，例如 `Local`：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `baseUrl` | `http://localhost:3000` | 本机用这个；跨机或服务在 192.168.0.67 时改为 `http://192.168.0.67:3000` |
| `token` | （先留空，登录后粘贴） | 登录响应里的 `token` |
| `accountId` | `act_123456789` | 你已绑定的真实广告账户 ID |

请求里用：`{{baseUrl}}`、`{{token}}`、`{{accountId}}`。

**在 Thunder Client 里建 Environment：**

1. 点 Thunder Client 侧边栏的 **Env**（或底部状态栏的 Environment 名）。
2. 点 **Add** 或 **+** 新建，名字填 `Local`。
3. 在 Key/Value 表里新增三行：
   - `baseUrl` → `http://localhost:3000`（本机）或 `http://192.168.0.67:3000`（跨机/服务在 67）
   - `token` → 先留空，登录后再粘贴
   - `accountId` → 你的真实广告账户 ID，如 `act_123456789`
4. 保存后，在发请求前确保右上角/底部选中的是 **Local**，这样 `{{baseUrl}}` 等才会生效。

---

## 第 0 步：拿到 JWT（所有需登录的请求都会用到）

**用谁登录**：测用例 1～7 时用**管理员**登录；测用例 8 时再单独用**普通用户 B** 登录一次拿 B 的 token。

### 在 Thunder Client 里一步一步做

1. **新建请求**：左侧点 **New Request** 或 **+**，给个名字如「登录」。
2. **Method**：左上下拉选 **POST**。
3. **URL**：在中间 URL 框里填 **`http://localhost:3000/api/auth/login`**（若服务在 192.168.0.67 则填 `http://192.168.0.67:3000/api/auth/login`）。
4. **Body**：
   - 点左侧 **Body** 标签。
   - 类型选 **JSON**（通常默认就是）。
   - 在文本框里写（把用户名密码换成你的）：
     ```json
     {"username":"你的用户名","password":"你的密码"}
     ```
   - 注意不要多逗号、不要用单引号。
5. **Headers**：登录一般不用改，若有需要可点 **Headers** 加一行 `Content-Type` = `application/json`。
6. **发送**：点右上蓝色 **Send**（或按 `Ctrl+Enter`）。
7. **看右侧**：
   - **Status** 应为 **200**。
   - **Response** 里会有 `success`、`token`、`user`。点开 `token`，**整段复制**（从 `eyJ...` 到结尾）。
8. **把 token 存进 Environment**：
   - 打开 **Env** → 选中 **Local** → 找到 `token` 那一行，把刚才复制的整段粘到 **Value**。
   - 保存。之后所有带 `Authorization: Bearer {{token}}` 的请求都会自动用这个 token。

### 预期响应示例

- **Status**: `200`
- **Body** 示例：
```json
{
  "success": true,
  "message": "登录成功",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": 1, "username": "admin", "role": "admin", ... }
}
```

若 Status 是 401，检查用户名密码；400 看是否少写 username/password。

---

## 用例 1：手动同步全量 — Thunder Client 界面操作

**目的**：确认手动同步只走全量、只刷指定账户，且状态表更新。

### 一步一步操作

1. **新建请求**：名字如「手动同步结构」。
2. **Method**：选 **POST**。
3. **URL**：填 **`http://localhost:3000/api/sync/structure`**（若服务在 192.168.0.67 则填 `http://192.168.0.67:3000/api/sync/structure`）。
4. **Headers**（必填，否则会 401）：
   - 点 **Headers** 标签。
   - 确保有 **两行**（没有就点 + 或 Add）：
     | 参数名 | 值 |
     |--------|-----|
     | `Authorization` | `Bearer {{token}}` |
     | `Content-Type` | `application/json` |
   - 注意 `Bearer` 和 `{{token}}` 之间有一个空格；若没用 Environment，这里就写 `Bearer 粘贴的token`。
5. **Body**：
   - 点 **Body** 标签，类型选 **JSON**。
   - 内容写：`{"account_id":"{{accountId}}"}`  
     若没用 Environment，写死：`{"account_id":"act_你的真实账户ID"}`。
6. **Send**：点右上 **Send**。
7. **看右侧**：
   - **Status 200**：Body 里应有 `ok: true`、`account_id`、`synced_count`、`duration_ms` → 说明同步成功。
   - **Status 429**：`reason: "cooldown"` → 说明 2 分钟冷却中，等会再试或看日志验证冷却逻辑。
   - **Status 403**：权限不足（不是该账户负责人/管理员）。
   - **Status 401**：token 过期或没填，重新登录拿 token。
8. **看后端终端日志**：应出现 `[2.4] 冷却检查` 和 `✅ [2.4] 结构同步完成 account=... mode=full ...`，**不能**是 `mode=incremental` 且 synced 接近全表数。

### 小结（用例 1）

**用谁**：**管理员**或**该账户的负责人**（否则 403）。

| 在 Thunder Client 里 | 填什么 |
|---------------------|--------|
| Method | POST |
| URL | `http://localhost:3000/api/sync/structure` |
| Headers | `Authorization` = `Bearer 你的token`，`Content-Type` = `application/json` |
| Body (JSON) | `{"account_id":"你的act_xxx"}` |

之后所有「需登录」的请求都加 **Headers** 里这两行；Body 按用例不同再改。

---

## 用例 1：手动同步全量（单账户）

**目的**：确认 `POST /api/sync/structure` 只走全量、只刷指定账户，且 `structure_sync_status` 正确更新。

### 1.1 Thunder Client 请求（用管理员或该账户负责人）

| 项 | 值 |
|----|-----|
| **Method** | `POST` |
| **URL** | `http://localhost:3000/api/sync/structure` |
| **Headers** | `Authorization: Bearer 你的token`，`Content-Type: application/json` |
| **Body** | **JSON**：`{"account_id":"你的act_xxx"}` |

（也可用 Query：`?account_id=你的act_xxx`，不写 Body。）

### 1.2 预期响应

- **成功**：`200`，Body 类似：
```json
{
  "ok": true,
  "account_id": "act_xxx",
  "synced_count": 123,
  "duration_ms": 5000
}
```
- **冷却中**：`429`，`reason: "cooldown"`，`retry_after_sec`。
- **锁占用**：`409`，`reason: "lock_busy"`。

### 1.3 看服务端日志

在运行后端的终端里搜：

- `[2.4] 冷却检查` → 紧接着应有 `✅ [2.4] 结构同步完成 account=act_xxx mode=full synced=N duration_ms=...`
- **不能出现**：`mode=incremental` 且 synced 数接近该账户广告总数（即“incremental 却 touched=全表”）。

### 1.4 必跑 SQL（验证 status 表）

在 MySQL 里执行（把 `act_xxx` 换成你的 `{{accountId}}`）：

```sql
SELECT account_id, has_full_synced, last_full_count, last_full_success_at, last_success_at
FROM structure_sync_status
WHERE account_id = 'act_xxx';
```

### 1.5 通过标准

- 响应 200，且只同步了你传的那个 account。
- 日志里是 **mode=full**，没有“incremental 却 synced≈全表”。
- 上表里该行：`has_full_synced=1`，`last_full_count` 为正数，`last_full_success_at`/`last_success_at` 为刚执行时间。

**可选**：2 分钟内再发一次同一请求，应得到 429（冷却），说明冷却生效。

---

## 用例 2：伪增量差异触达

**目的**：确认伪增量只对差异集合调 FB，touched 规模远小于全表。

### 2.1 操作（不用 Thunder Client 发请求）

在项目根目录执行：

```bash
node server/scripts/manual-unified-heartbeat.js
```

### 2.2 看服务端日志

搜索 **`[伪增量]`**，按账户看，期望每账户一行类似：

- `[伪增量] account=act_xxx recentActiveIds=N diffIds=M touched=T diffHead5=[...]`
- 或 `diffIds=0 touched=0 diffHead5=[]`

### 2.3 可选 SQL（对比全表行数）

```sql
SELECT COUNT(*) FROM structure_ads WHERE account_id = 'act_xxx';
```

用这个数和日志里的 **touched** 比：touched 应远小于该 COUNT。

### 2.4 通过标准

- 每个有参与心跳的账户都有一条 `[伪增量]` 日志。
- 有 diffIds 时：`touched <= diffIds`，且 touched 远小于该账户 structure_ads 全表行数。
- diffIds=0 时，不应再出现一大串 resolve 调用（伪增量不因 0 差异去拉一批）。

---

## 用例 3：状态差异检测生效

**目的**：在 FB 后台改广告状态后，下一轮伪增量能把本地 `structure_ads` 更成 PAUSED/ACTIVE。

### 3.1 操作顺序

1. 在库里或选择器里记下某条 **ACTIVE** 广告的 `ad_id`（例如 `123456789`）。
2. 到 **FB 广告后台** 把这条广告**暂停**（或先暂停再启用，看你要测哪种）。
3. 在本机执行一次统一心跳：  
   `node server/scripts/manual-unified-heartbeat.js`
4. 看该账户的 `[伪增量]`：期望 `diffIds>=1`、`touched>=1`，且 `diffHead5` 里包含该 ad_id（若在前 5 个）。

### 3.2 必跑 SQL（核对本地状态）

把 `act_xxx`、`刚操作的那条ad_id` 换成实际值：

```sql
SELECT ad_id, effective_status, status, configured_status, last_synced_at
FROM structure_ads
WHERE account_id = 'act_xxx' AND ad_id = '刚操作的那条ad_id';
```

### 3.3 通过标准

该行 `effective_status`（或 status/configured_status）与 FB 后台一致（如 PAUSED/ACTIVE）。

---

## 用例 4：1h 降频 + 旋转

**目的**：同一账户 1 小时内不重复触达刚 touched 的那批；多轮 diffHead5 会轮转。

### 4.1 操作

1. 执行一次：`node server/scripts/manual-unified-heartbeat.js`，记下某账户的 `[伪增量] ... diffHead5=[...]`。
2. 隔几分钟再执行一次，再记该账户的 `diffHead5`。
3. 可选：再跑 1～2 次，看 diffHead5 是否变化。

### 4.2 通过标准

- 第二次：要么 `diffIds=0 diffHead5=[]`，要么 `diffHead5` 与第一次**不同**。
- 多轮之间 diffHead5 有变化（不会连续两轮完全同一批 id 且 touched>0）。

### 4.3 可选 SQL

```sql
SELECT ad_id, last_synced_at
FROM structure_ads
WHERE account_id = 'act_xxx' AND effective_status = 'ACTIVE'
ORDER BY last_synced_at DESC
LIMIT 10;
```

---

## 用例 5：NULL 自愈

**目的**：`last_synced_at IS NULL` 的 ACTIVE 行能被伪增量选中并补齐 `last_synced_at`。

### 5.1 造数（在 MySQL 执行）

把 `act_xxx` 换成你的账户 ID，执行后**记下被更新的 ad_id**（可从 LIMIT 1 查出来）：

```sql
UPDATE structure_ads
SET last_synced_at = NULL
WHERE account_id = 'act_xxx' AND effective_status = 'ACTIVE'
LIMIT 1;
-- 若需查看被改的是哪条：
-- SELECT ad_id FROM structure_ads WHERE account_id = 'act_xxx' AND last_synced_at IS NULL AND effective_status = 'ACTIVE' LIMIT 1;
```

### 5.2 操作

1. 执行一次：`node server/scripts/manual-unified-heartbeat.js`。
2. 看该账户 `[伪增量]`：期望 `recentActiveIds>=1`、`diffIds>=1`、`touched>=1`，且 diffHead5 含该 ad_id（若在前 5）。

### 5.3 必跑 SQL（第一次心跳后）

把 `act_xxx`、`造数的那条ad_id` 换成实际值：

```sql
SELECT ad_id, last_synced_at
FROM structure_ads
WHERE account_id = 'act_xxx' AND ad_id = '造数的那条ad_id';
```

### 5.4 通过标准

- 第一次心跳后：该行 **last_synced_at 非 NULL**。
- 再触发一次心跳：该 ad 不应再出现在新一批 diffHead5（或该轮 diffIds=0）。

---

## 用例 6：Piggyback 与伪增量不重复 resolve

**目的**：Today 对 activeAdIds 只做一次 resolve；Piggyback 优先复用，缺口补查很少。

### 6.1 操作

执行一次：`node server/scripts/manual-unified-heartbeat.js`（保证有账户走 Today 分支）。

### 6.2 看服务端日志（搜索关键字）

- **Today**：`批量解析活跃广告元数据` 或 `同轮仅此一次 resolve`。
- **Piggyback**：`[Piggyback] account=act_xxx 补齐 structure_ads: 复用=X, 缺口补查=Y`。

### 6.3 通过标准

- 有「同轮仅此一次 resolve」类日志。
- Piggyback 的 **缺口补查 Y** 为 0 或个位数（不会每轮都大额补查）。

---

## 用例 7：每小时全量轮转

**目的**：整点后 5 分钟有轮转执行或明确跳过；优先级正确；usage 高/熔断时本小时跳过。

### 7.1 操作

1. 等到某小时的 **第 5 分钟**（如 14:05），看后端日志。
2. 期望看到：`[结构轮转] 本小时处理 N 个账户（并发 1）` 或 `本小时跳过: ...`。
3. 可选：在 usage 高或熔断时再等下一个整点后 5 分钟，看是否出现「本小时跳过」。

### 7.2 预期日志示例

- **正常**：`[结构轮转] 本小时处理 6 个账户（并发 1）`，随后有若干条 `✅ [2.4] 结构同步完成`。
- **跳过**：`[结构轮转] 本小时跳过：Token 熔断` 或 `本小时跳过：API 使用率 85% >= 85%`。

### 7.3 可选 SQL（轮转前/后各跑一次）

```sql
SELECT account_id, has_full_synced, last_full_count
FROM structure_sync_status
ORDER BY has_full_synced, last_full_count;
```

确认未铺表（has_full_synced=0 或 last_full_count=0）的账户先被处理。

### 7.4 通过标准

- 整点后 5 分钟有轮转日志或跳过日志。
- 被处理的账户顺序符合优先级（未铺表优先）。
- usage≥85 或熔断时出现「本小时跳过」。

---

## 用例 8：权限与安全（手动同步）— Thunder Client 里怎么测

**目的**：非负责人/非管理员不能同步他人账户；越权请求 403，且不触发实际同步。

### 8.1 准备

- 用 **账号 B**（非管理员、且不是目标账户负责人）登录一次，拿到 B 的 token；在 Thunder Client 里要么新建一个 Environment「用户B」只填 B 的 `token`，要么临时把当前 Environment 的 `token` 改成 B 的。
- 准备一个 **他人**的 `account_id`（在 `account_mappings` 里不属于 B 的 `owner_id`）。若只有管理员，可用另一个 act_xxx 且该账户不归当前用户管。

### 8.2 在 Thunder Client 里一步一步做

1. **新建请求**：名字如「权限-越权同步他人账户」。
2. **Method**：**POST**。
3. **URL**：**`http://localhost:3000/api/sync/structure`**。
4. **Headers**：
   - `Authorization` = `Bearer 普通用户B的token`（**必须用 B 的 token**，用 B 的身份发请求才会测出越权被拦）。
   - `Content-Type` = `application/json`。
5. **Body**（JSON）：`{"account_id":"他人的act_xxx"}`（填一个 B 没有权限的账户 ID）。
6. **Send**。
7. **看右侧**：
   - **Status 应为 403**；Body 里通常有 `error` 或 `ACCOUNT_FORBIDDEN` 等。
   - 若 Status 是 200，说明权限校验有漏洞。
8. **看后端日志**：不应出现 `[2.4] 结构同步完成` 或 FB 请求（说明接口在 403 前就拦住了，没有真正同步）。

### 8.3 通过标准

- 返回 403，且服务端无实际同步与 FB 调用。

---

## 速查：Thunder Client 请求汇总

| 用例 | 用谁 | Method | URL | Body |
|------|------|--------|-----|------|
| 拿 JWT | 管理员 或 普通用户 | POST | `http://localhost:3000/api/auth/login` | `{"username":"...","password":"..."}` |
| 1 手动全量 | **管理员 / 该账户负责人** | POST | `http://localhost:3000/api/sync/structure` | `{"account_id":"你的act_xxx"}` |
| 8 权限(越权) | **普通用户 B**（非管理员、非该账户负责人） | POST | `http://localhost:3000/api/sync/structure` | `{"account_id":"他人的act_xxx"}`，Header 用 B 的 token |

其余用例 2、3、4、5、6、7 均为：执行 `node server/scripts/manual-unified-heartbeat.js` + 看日志 + 跑文档中的 SQL。

---

## 验收打勾表（与清单一致）

| # | 用例 | 通过 |
|---|------|------|
| 1 | 手动同步全量（单账户） | □ |
| 2 | 伪增量差异触达 | □ |
| 3 | 状态差异检测生效 | □ |
| 4 | 1h 降频 + 旋转 | □ |
| 5 | NULL 自愈 | □ |
| 6 | Piggyback 与伪增量不重复 resolve | □ |
| 7 | 每小时全量轮转 | □ |
| 8 | 权限与安全 | □ |

全部打勾后即可视为本方案验证通过。若某条失败，可对照《顺序2_结构同步_验证与测试清单.md》里该用例的「可能原因 1/2/3」定位代码与配置。

---

## 附录 A：用 VS Code REST Client 测试（可选）

若你更习惯在项目里留 `.http` 文件、点一下就能发请求，可安装 **REST Client** 扩展，新建 `docs/api-test.http`：

```http
### 变量（REST Client 用 # 注释）
### 0. 登录（管理员或普通用户；测用例 8 时用普通用户 B 再登录一次）
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{"username":"你的用户名","password":"你的密码"}

### 1. 手动同步结构（用管理员或该账户负责人 token，否则 403）
POST http://localhost:3000/api/sync/structure
Authorization: Bearer 这里粘贴管理员的token
Content-Type: application/json

{"account_id":"你的act_xxx"}

### 8. 权限测试：用普通用户 B 的 token + 他人 account_id（应 403）
POST http://localhost:3000/api/sync/structure
Authorization: Bearer 这里粘贴普通用户B的token
Content-Type: application/json

{"account_id":"他人的act_xxx"}
```

用法：在 `.http` 文件里，每个 `###` 上面会出现 "Send Request"；点一下即发送该请求，响应在右侧打开。

---

## 附录 B：用 curl 测试（复制即用）

把 `YOUR_TOKEN`、`act_xxx`、`localhost:3000` 换成实际值后，在终端执行。

**登录（拿 token）：**
```bash
curl -X POST "http://localhost:3000/api/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"你的用户名\",\"password\":\"你的密码\"}"
```
从输出里复制 `token` 字段。

**手动同步结构：**
```bash
curl -X POST "http://localhost:3000/api/sync/structure" -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d "{\"account_id\":\"act_xxx\"}"
```

**权限测试（应 403）：**
```bash
curl -X POST "http://localhost:3000/api/sync/structure" -H "Authorization: Bearer 用户B的TOKEN" -H "Content-Type: application/json" -d "{\"account_id\":\"他人的act_xxx\"}"
```

Windows CMD 里双引号需转义，若报错可改用 PowerShell 或 Git Bash。
