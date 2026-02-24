# pause_ad 真闭环 — 验证清单与教学

> 用**某个广告账户下的 1～2 个广告**做验证，是最小、最安全的做法。本文教你一步步怎么选广告、建规则、做 Dry Run、再做真实执行，并验收 FB 后台状态与日志。

---

## 一、能不能用「某个账户下的几个广告」测试？

**可以。** 这正是推荐方式。

| 做法 | 说明 |
|------|------|
| **选 1 个账户 + 1～2 个广告** | ✅ 推荐。影响范围小，验证完可立刻在 FB 后台手动恢复。 |
| **选多个账户、多广告** | 也可以，但没必要；验证逻辑相同，反而容易乱。 |
| **不指定 target_ids（整账户）** | 若账户下广告多，会匹配很多，不利于精确定位问题。 |

**原则**：先小范围验证通过，再考虑扩大。

---

## 二、验证流程总览（4 个阶段）

```
阶段 0：准备（选账户、选广告、建规则）
    ↓
阶段 1：Dry Run 验证（不真调 FB，确认逻辑走通）
    ↓
阶段 2：Pre-Flight 验证（本地 status 已 PAUSED 则跳过）
    ↓
阶段 3：真实 POST 验证（非 Dry Run，FB 后台真变 PAUSED）
    ↓
阶段 4：（可选）FB already-state 容错验证
```

建议按顺序做；阶段 1 通过后再做阶段 3。

---

## 三、阶段 0：准备（选账户、选广告、建规则）

### 0.1 选广告的 3 个条件

| 条件 | 说明 |
|------|------|
| 在 `ad_snapshots` 有数据 | 规则引擎查的是数据库，没有快照则不会命中。 |
| 当前 status 为 ACTIVE | 只有 ACTIVE 的才会被 pause；已 PAUSED 的会 Pre-Flight 跳过。 |
| 今天有 spend（可选） | 若用 `spend > 0` 作条件，必须有今日花费才能命中。 |

### 0.2 查库：找可用的广告

```sql
-- 某账户下「今天有数据」且 status=ACTIVE 的广告（取前 5 条）
SELECT account_id, ad_id, ad_name, status, spend, synced_at
FROM ad_snapshots
WHERE account_id = 'act_你的账户ID'
  AND data_date = CURDATE()   -- 若没有 data_date 列，用 synced_at 近 24h 也可
  AND status = 'ACTIVE'
ORDER BY spend DESC
LIMIT 5;
```

如果没有 `data_date`，可用：

```sql
SELECT account_id, ad_id, ad_name, status, spend, synced_at
FROM ad_snapshots
WHERE account_id = 'act_你的账户ID'
  AND synced_at >= NOW() - INTERVAL 24 HOUR
  AND status = 'ACTIVE'
ORDER BY spend DESC
LIMIT 5;
```

记下 1～2 个 `ad_id`（例如 `120238825337380446`），后面建规则时用。

### 0.3 建一条「只针对这几条广告」的规则

规则要满足：
- `target_level = 'ad'`
- `target_ids = ['你选的ad_id1', '你选的ad_id2']`
- 条件要能命中：例如 `spend > 0`（today）
- `actions = [{ type: 'pause_ad' }]`
- **先设 `is_simulation = true`**（Dry Run）

**方式一：Thunder Client / curl 创建**

```http
POST http://localhost:3000/api/rules
Authorization: Bearer 你的JWT
Content-Type: application/json

{
  "ruleName": "pause_ad验证测试",
  "accountId": "act_你的账户ID",
  "targetLevel": "ad",
  "targetIds": ["120238825337380446"],
  "conditions": [
    { "metric": "spend", "operator": "gt", "value": 0, "time_window": "today" }
  ],
  "logicOperator": "AND",
  "actions": [{ "type": "pause_ad" }],
  "isSimulation": true,
  "enabled": true
}
```

**方式二：前端 RuleManager 创建**

1. 进入规则管理页
2. 新建规则，名称填「pause_ad验证测试」
3. 账户选你要测的那个
4. 目标层级选「广告」，手动输入或选择你查到的 ad_id
5. 条件：`spend > 0`，时间窗口 today
6. 动作：暂停广告
7. **Dry Run 开关打开**（is_simulation）
8. 保存并启用

创建后记下 `rule_id`（例如 150）。

---

## 四、阶段 1：Dry Run 验证（不真调 FB）

**目的**：确认规则能命中、Pre-Flight 与 Dry Run 逻辑正确，且**不会真正调用 FB API**。

### 1.1 操作步骤

1. 确认规则 `is_simulation = true`
2. 触发单条规则执行：

   **Thunder Client：**
   ```http
   POST http://localhost:3000/api/rules/150/execute
   Authorization: Bearer 你的JWT
   ```
   （把 150 换成你的 rule_id）

   **curl：**
   ```bash
   curl -X POST "http://localhost:3000/api/rules/150/execute" ^
     -H "Authorization: Bearer 你的JWT"
   ```

3. 看后端日志
4. 查 `automation_logs`

### 1.2 预期结果

| 检查项 | 预期 |
|--------|------|
| API 响应 | `200`，`matched_count >= 1`，`executed_count` 或 `skipped_count` 有值 |
| 后端日志 | 出现 `[Dry Run]`，例如 `[Dry Run] 广告 xxx 将执行: pause_ad` |
| FB 后台 | **广告状态不变**（仍是 ACTIVE） |
| automation_logs | 有记录，`is_simulation = 1`，`action_type = 'PAUSE_AD'` |

### 1.3 查 automation_logs

```sql
SELECT id, ad_id, action_type, is_simulation, status, error_message, triggered_at
FROM automation_logs
ORDER BY id DESC
LIMIT 5;
```

### 1.4 若失败：3 个可能原因

| 现象 | 可能原因 | 怎么查 |
|------|----------|--------|
| matched_count = 0 | 规则没命中（条件不满足或 target_ids 不对） | 查 ad_snapshots 该 ad 的 spend、status；确认 target_ids 正确 |
| 409 ALREADY_RUNNING | 已有规则任务在执行 | 等几秒再试，或查 `GET /api/cron/status` |
| 401/403 | 未登录或无权执行该规则 | 确认 token 有效、该 rule 属于当前用户或 admin |

---

## 五、阶段 2：Pre-Flight 验证（本地已 PAUSED 则跳过）

**目的**：确认当 `ad_snapshots.status` 已是 PAUSED 时，**不会调用 FB API**，直接记 skipped。

### 2.1 操作步骤

1. 在数据库把某个测试广告的 status 改成 PAUSED：

   ```sql
   UPDATE ad_snapshots
   SET status = 'PAUSED'
   WHERE account_id = 'act_你的账户ID'
     AND ad_id = '你选的ad_id';
   ```

2. 规则可保持 Dry Run 或关掉 Dry Run（Pre-Flight 两种模式都会生效）
3. 触发单条规则执行：`POST /api/rules/:id/execute`
4. 看日志、查 automation_logs

### 2.2 预期结果

| 检查项 | 预期 |
|--------|------|
| 后端日志 | `Pre-Flight: 广告 xxx 已 PAUSED，无需 pause，跳过` 或 `[Dry Run] Pre-Flight: ...` |
| automation_logs | `status = 'skipped'`，`error_message` 含「目标已达成」或「already_paused」 |
| FB API | **未被调用**（没有真实 pause 请求） |

### 2.3 验证 SQL

```sql
SELECT ad_id, action_type, status, error_message
FROM automation_logs
WHERE ad_id = '你选的ad_id'
ORDER BY id DESC
LIMIT 3;
```

### 2.4 验证后恢复

```sql
-- 把 status 改回 ACTIVE，便于阶段 3 再做真实执行
UPDATE ad_snapshots
SET status = 'ACTIVE'
WHERE account_id = 'act_你的账户ID'
  AND ad_id = '你选的ad_id';
```

---

## 六、阶段 3：真实 POST 验证（FB 后台真变 PAUSED）

**目的**：确认非 Dry Run 下，会**真实调用 FB API**，且 FB 广告状态变为 PAUSED。

### 6.1 操作步骤

1. **确认环境**：
   - `.env` 中 `FACEBOOK_ACCESS_TOKEN` 已配置且有效
   - 测试广告在 FB 后台当前是 **ACTIVE**

2. **关掉 Dry Run**：
   - 把规则的 `is_simulation` 改为 `false`
   - 可用 PATCH 或前端编辑

   ```http
   PATCH http://localhost:3000/api/rules/150
   Authorization: Bearer 你的JWT
   Content-Type: application/json

   { "isSimulation": false }
   ```

3. **触发执行**：
   ```http
   POST http://localhost:3000/api/rules/150/execute
   Authorization: Bearer 你的JWT
   ```

4. **验收**：
   - 打开 FB 广告管理后台，找到该广告
   - 状态应为 **PAUSED**
   - 查 automation_logs 和 rule_execution_summaries

### 6.2 预期结果

| 检查项 | 预期 |
|--------|------|
| FB 广告后台 | 该广告状态从 ACTIVE → **PAUSED** |
| 后端日志 | `执行: 暂停广告 xxx`、`成功暂停广告 xxx` |
| automation_logs | `is_simulation = 0`，`status = 'success'` |
| rule_execution_summaries | 有对应 run_id 的摘要，`executed_count >= 1` |

### 6.3 验证 SQL

```sql
-- 最近一条 pause 成功记录
SELECT ad_id, action_type, is_simulation, status, api_request, api_response, triggered_at
FROM automation_logs
WHERE action_type = 'PAUSE_AD'
ORDER BY id DESC
LIMIT 1;

-- 摘要
SELECT run_id, rule_id, matched_count, executed_count, failed_count, status
FROM rule_execution_summaries
ORDER BY id DESC
LIMIT 5;
```

### 6.4 若失败：3 个可能原因

| 现象 | 可能原因 | 怎么查 |
|------|----------|--------|
| Token 未配置 / 190 错误 | Token 过期或无效 | 检查 .env 的 FACEBOOK_ACCESS_TOKEN；FB 开发者后台检查 Token 权限 |
| status = 'fail' | FB API 返回错误 | 看 automation_logs 的 error_message、api_response |
| 广告未变 PAUSED | 没真正命中或执行到该广告 | 确认 target_ids、conditions 能命中；看 executed_count 是否 > 0 |

### 6.5 验证后恢复广告（可选）

如需把广告重新打开，在 FB 广告管理后台手动点「启用」，或在 FB API 中调 activate。

---

## 七、阶段 4：（可选）FB already-state 容错

**目的**：当 FB 返回「already paused」之类错误时，应记 `skipped` 而不是 `fail`。

**操作**：对**已经 PAUSED** 的广告再触发一次规则。可能出现两种情况：

1. **Pre-Flight 生效**：本地 ad_snapshots 已更新为 PAUSED → 直接 skipped，不调 API
2. **调了 API**：若本地还未更新，会调 pauseAd，FB 返回 "already paused" → 应记 skipped

**预期**：无论哪种，automation_logs 中该条应为 `status = 'skipped'`，不应为 `fail`。

---

## 八、通用 SQL 速查

```sql
-- 1. 某账户下可测广告
SELECT ad_id, ad_name, status, spend
FROM ad_snapshots
WHERE account_id = 'act_xxx'
  AND synced_at >= NOW() - INTERVAL 24 HOUR
  AND status = 'ACTIVE'
LIMIT 5;

-- 2. 最近 pause 相关日志
SELECT ad_id, action_type, is_simulation, status, error_message, triggered_at
FROM automation_logs
WHERE action_type = 'PAUSE_AD'
ORDER BY id DESC
LIMIT 10;

-- 3. run_id 下同一 ad 是否仅一条（M4 仲裁验收）
SELECT run_id, ad_id, COUNT(*) AS cnt
FROM automation_logs
WHERE run_id IS NOT NULL
GROUP BY run_id, ad_id
HAVING cnt > 1;
-- 理想结果：0 行
```

---

## 九、验证通过 Checklist

完成以下打勾即视为 pause_ad 真闭环验收通过：

- [ ] 阶段 0：已选 1 个账户、1～2 个广告，并建好规则
- [ ] 阶段 1：Dry Run 下规则能命中，日志有 [Dry Run]，FB 后台广告状态未变
- [ ] 阶段 2：ad_snapshots.status=PAUSED 时，Pre-Flight 跳过，不调 FB API
- [ ] 阶段 3：非 Dry Run 下，FB 后台广告真实变为 PAUSED，automation_logs 有 success
- [ ] （可选）阶段 4：FB 返回 already 时记 skipped，不记 fail

---

## 十、与 Thunder Client 的配合

若使用 Thunder Client，可新建一个 Collection，包含：

1. `POST /api/auth/login` — 获取 token
2. `POST /api/rules` — 创建测试规则
3. `PATCH /api/rules/:id` — 修改 isSimulation
4. `POST /api/rules/:id/execute` — 触发单条执行
5. `GET /api/cron/status` — 查是否正在执行

环境变量建议：`baseUrl = http://localhost:3000`，`token = 登录后复制的值`。

---

> **说明**：本验证清单对应 TASKS 3.7「pause_ad 真闭环」与 3.3 Pre-Flight。完成上述验收后，可在 TASKS.md 中勾选 3.7。
