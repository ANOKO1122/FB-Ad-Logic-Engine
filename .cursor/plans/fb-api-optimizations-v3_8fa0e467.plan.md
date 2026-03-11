---
name: fb-api-optimizations-v3
overview: 在 v2 方案基础上，补充预算合并可观测性、Batch 响应顺序安全，以及 Insights 源头过滤的空结果健壮性，形成更加完备的 FB API 优化落地计划。
todos:
  - id: insights-filtering-v3
    content: 在 getAdInsights 与 fetchInsightsInBatches 中实现 spend>0 的 server-side filtering，并对 data 为空/缺失情况做健壮处理；保留本地过滤与 DISABLE_SPEND_FILTERING 兜底。
    status: completed
  - id: actions-batch-v3
    content: 在 FacebookMarketingAPI 中实现 batchRequests（50 条分片、双 JSON 解析、结果顺序保持），并在 actionExecutorService 中完成 pendingActions 收集、预算去重合并（含覆盖日志）、按账户 Batch 提交和 ENABLE_ACTION_BATCH 开关。
    status: completed
  - id: pseudo-increment-v3
    content: 在 unifiedHeartbeatSync 中按 Track2 启用状态与白名单过滤 runPseudoIncrementForAccount 的执行账户，仅对非 Track2 账户保留伪增量，同时打印 Track2/伪增量账户数量日志并保留 Piggyback 逻辑。
    status: completed
isProject: false
---

# FB API 三项关键优化落地方案（v3 最终版）

## 一、总体目标与版本说明

- **目标**：在不改变业务语义的前提下，进一步打磨三项 Facebook API 优化：
- 热数据 Insights 源头过滤（spend>0）。
- 规则执行动作 Batch POST（含分片、预算去重合并、全局优先级）。
- 基于 Track2 的伪增量弱化（结构同步职责收敛）。
- **v3 增量点**：在 v2 的基础上，增加三条“工程避坑”细节：
- 预算合并时的可观测日志，避免被动排查“规则被覆盖”。
- Batch 分片结果拼接时的索引顺序保证，防止错配子响应。
- Insights filtering 后 `data: []` 的健壮处理，避免空集合异常。

---

## 二、优化二：Insights 热数据源头过滤（spend>0）

### 2.1 背景与目标

- 当前 Today 与滑动窗口 Insights：FB 返回全量广告数据，Node 端再按 `spend>0` 过滤。
- 目标：在 FB 端就通过 `filtering` 过滤出 `spend>0` 的记录，减少 total_cputime 与包体，同时保留本地过滤兜底。

### 2.2 实施方案

1. **统一过滤配置**

- 在 `FacebookMarketingAPI` 中定义：
- `const DEFAULT_SPEND_FILTERING = [{ field: 'spend', operator: 'GREATER_THAN', value: '0' }]`。
- 可选辅助函数 `buildSpendFiltering()` 返回此数组，便于未来扩展。

2. **改造 `getAdInsights`（`server/index.js`）**

- 在内部 `buildParams(fields)` 中：
- 现有参数：`fields, level, limit, access_token, date_preset/time_range, use_account_attribution_setting...`。
- 新增逻辑：
- 若 `options?.spendGreaterThanZero === true` 且 `process.env.DISABLE_SPEND_FILTERING !== '1'`：
- 设置 `params.filtering = JSON.stringify(DEFAULT_SPEND_FILTERING)`。
- 在 `syncAccountTodayStats` 调用处，增加 `spendGreaterThanZero: true`，确保 Today 热数据走源头过滤。

3. **改造滑动窗口 Batch Insights（`fetchInsightsInBatches` in `ingestorService.js`）**

- 构造 `relative_url` 时追加 `filtering`：
- `const filtering = encodeURIComponent(JSON.stringify(DEFAULT_SPEND_FILTERING))`；
- `...&filtering=${filtering}`。
- 保持 `date_preset`/`time_range`/`time_increment` 等逻辑与原先一致，确保滑动窗口语义不变。

4. **空结果健壮性（v3 新增重点）**

- 针对 FB 返回 `data: []` 或根本无 `data` 字段情况：
- `const list = Array.isArray(data?.data) ? data.data : []`；
- 后续 map/forEach 都基于 `list`，避免对 `undefined` 做遍历。
- 在 `syncAccountTodayStats` / `syncAccountSlidingWindow` 中，当 `insights.length === 0`：
- 记录 info 级日志（例如“今日无 spend>0 广告，跳过写入”）；
- 返回 `success: true, syncedCount: 0`，而不是抛异常。

5. **本地过滤与兜底开关**

- 保留原有 Node 端 `filter(spend>0)` 逻辑；
- 通过 `DISABLE_SPEND_FILTERING` 环境变量可一键关闭 server-side filtering，回退到纯本地过滤。

6. **观测与验证**

- 首次启用时在 `getAdInsights` 增加一次性 info 日志，确认 filtering 生效；
- 对比优化前后：心跳周期内 Insights 返回条数、ad_snapshots 写入数、限流告警是否明显改善。

---

## 三、优化一：规则执行 Batch POST（分片 + 去重合并 + 可观测）

### 3.1 背景与目标

- 当前规则执行：每个广告、每个动作独立调用 FB API；预算类动作还要求 GET+POST 两次调用。
- 目标：
- 收集同一轮规则执行中的所有动作，按账户分组，使用 Batch POST 发送；
- 支持每批最多 50 子请求的分片；
- 对预算动作进行去重/合并，避免同一 AdSet/Campaign 重复改价；
- 增加日志记录“谁覆盖了谁”的信息，方便事后解释与排查。

### 3.2 Facebook API 层：`batchRequests`（含分片与顺序保证）

1. **方法签名与优先级**

- 在 `FacebookMarketingAPI` 新增：
- `async batchRequests(requests, { priority = 'action', label = 'actions_batch' } = {})`。
- 全部通过现有 `makeRequest` 发出，`requestPriority: 'action'`，确保在全局限流队列中高优先级处理。

2. **50 条上限的分片策略**

- 使用简单循环或 `lodash.chunk`：
- `for (let i = 0; i < requests.length; i += 50) { const chunk = requests.slice(i, i + 50) ... }`；
- 保证每个 Graph Batch 的子请求数量 ≤ 50。

3. **双重 JSON 解析与顺序拼接（v3 强调）**

- 对每个分片的响应：
- 最外层为数组 `[{ code, body, headers }, ...]`；
- 对每个元素：`const parsedBody = subRes.body ? JSON.parse(subRes.body) : null`；
- 封装为 `{ code: subRes.code, body: parsedBody, raw: subRes }`。
- **顺序安全要求**：
- Facebook Batch 保证“子响应顺序 == 子请求顺序”；
- `batchRequests` 在合并多个分片结果时，应按分片顺序直接拼接：
- 例如维护一个全局数组 `allResults.push(...chunkResults)`，确保第 i 个请求的结果始终是 `allResults[i]`；
- 不做额外排序或基于 code 的重排，防止出现“广告 A 的错误日志写到了广告 B 上”的错位问题。

### 3.3 动作收集与预算去重合并（`actionExecutorService`）

1. **动作描述结构**

- 定义统一的 `PendingAction` 结构：
- 状态类：`{ kind: 'status', op: 'pause'|'activate', accountId, adId }`；
- 预算类：`{ kind: 'budget', scope: 'adset'|'campaign', accountId, nodeId, isDaily, newBudgetCents, sourceRuleId, rawAction }`。

2. **阶段 A：收集 pendingActions（不直接发请求）**

- 在原先 `executeActionsForAd` 循环中：
- 保留 Pre-flight、冷却（`isCooldownDue`）、Smart Mute、Dry Run 等所有既有判断逻辑；
- 当判定“需要执行动作”时，不直接 `await api.*`，而是 push 一个 `PendingAction` 列表项；
- 对预算类动作：
- 使用 `getAdsetBudgetDetail` / `getCampaignBudgetDetail` 拿到 `currentCents` 与 `isDaily`；
- 用 `computeNewBudgetCentsOnce(currentCents, action)` 算出 `newBudgetCents`；
- 若 Pre-flight 判定 `currentCents === newBudgetCents`，则标记为 `skipped`，不产生 pendingAction。

3. **阶段 B：预算动作去重与合并（含幂等日志）**

- 按 accountId 将 `pendingActions` 分组后，对每个账号：
- 使用 Map 以 `(scope, nodeId)` 作为 key 聚合预算动作：
- key 示例：`budget_adset:123`、`budget_campaign:456`。
- 若同一 key 有多条预算意图：
- 采用“保留最后一条动作”的策略：
- 视为后创建/后编辑的规则优先；
- **v3 新增：记录覆盖日志**：
- 当发生合并时，写 info 级或 debug 级日志，例如：
- `logger.info('budget_merge', { accountId, scope, nodeId, keptRuleId, overwrittenRuleIds })`；
- 这样，当运营人员询问“规则 A 明明触发了，为什么预算是规则 B 的数值？”时，可以快速从日志中查到合并记录，解释“被后来的规则覆盖”。
- 经过合并后，保证：同一 nodeId 在单轮内只有一条预算修改，避免 Batch 里自己和自己打架。

4. **阶段 C：构造 Batch 请求并发送**

- 对每个 accountId 的动作集合：
- 将状态动作转换为子请求：
- `method: 'POST'`；
- `relative_url` 与现有 `pauseAd`/`activateAd` 保持一致（例如 `/adId`）；
- `body` 中写 `status=PAUSED` / `status=ACTIVE`。
- 将预算动作转换为子请求：
- 复用 `updateAdsetBudget` / `updateCampaignBudget` 的 URL 和参数格式：
- `relative_url: '${adsetId}'` 或 `${campaignId}`；
- `body: JSON.stringify({ [field]: newBudgetCents })`，field 为 `daily_budget` 或 `lifetime_budget`。
- 将构造好的 requests 交给 `facebookApi.batchRequests`：
- 通过索引顺序一一对应 pendingActions；
- 对每个子响应：若成功则标记为 `executed`，否则标记为 `fail`，记录错误信息供 `automation_logs` 与 `rule_execution_summaries` 使用。

5. **GET 预算兜底与缓存**

- 在当前阶段仍保留 `getAdsetBudgetDetail` / `getCampaignBudgetDetail`：
- 在单轮执行中对相同 nodeId 的结果可用 Map 做内存缓存，避免重复 GET；
- 未来如将 budget 落到 `structure_adsets` / `structure_campaigns`，可改为“结构表优先 + GET 兜底”。

6. **开关与回退**

- 引入 `ENABLE_ACTION_BATCH` 环境变量：
- 开启：走“收集 + 合并 + Batch”路径；
- 关闭：保留原先“逐条调用”路径，用于快速回滚或问题定位对比。

---

## 四、优化三：按 Track2 弱化伪增量

### 4.1 背景与目标

- `unifiedHeartbeatSync` 在完成数据同步和归档后，对所有账户执行 `runPseudoIncrementForAccount`，以 RecentActiveIds+DiffIds 的方式补充结构广告状态。
- Track2 Fast Sync 已对部分账户提供高频结构同步，伪增量在这些账户上与 Track2 重合。
- 目标：
- Track2 账户：不再重复跑伪增量，结构同步职责收敛到 Track1+Track2+Piggyback；
- 非 Track2 账户：保留伪增量作为兜底防线。

### 4.2 实施方案

1. **Track2 启用判断函数**

- 在 `unifiedHeartbeatSync` 中读取：
- `ENABLE_TRACK2_FAST_SYNC`；
- `TRACK2_FAST_SYNC_ACCOUNT_IDS`（逗号分隔字符串）。
- 定义：`isTrack2EnabledForAccount(accountId)`：
- 若 `ENABLE_TRACK2_FAST_SYNC !== '1'` → 返回 false；
- 若 `TRACK2_FAST_SYNC_ACCOUNT_IDS` 为空 → 返回 true （所有账户视为 Track2 覆盖）；
- 否则仅当 accountId 在白名单集合中时返回 true。

2. **筛选伪增量账户**

- 将原先：`const accountsForPseudo = results.filter(r => r?.accountId)` 改为：
- `const accountsForPseudo = results.filter(r => r?.accountId && !isTrack2EnabledForAccount(r.accountId))`。
- 仅对 `accountsForPseudo` 执行 `runPseudoIncrementForAccount(accountId, activeAdIds || [], facebookApi)`。

3. **日志与观测**

- 增加概要日志：
- 记录本轮：总账户数、Track2 覆盖账户数、仍执行伪增量账户数；
- 有助于评估 Track2 的覆盖程度与伪增量任务的缩减效果。

4. **保留 Piggyback**

- 不改动 `piggybackStructureFromToday` 逻辑：
- daysBack===0 且 activeAdIds 非空时，继续对新增/缺失结构进行补齐；
- Track2 与伪增量开关不影响 Piggyback。

---

## 五、实施顺序与风险控制

1. **先上线优化二（Insights 源头过滤）**：代码改动集中、逻辑简单，有 DISABLE_SPEND_FILTERING 兜底，优先缓解心跳与滑动窗口的 API 压力。
2. **分阶段上线优化一（Batch 动作）**：

- 先在测试环境只对暂停/启用动作启用 Batch，验证分片 + 顺序 + 双解析逻辑；
- 再接入预算动作及其去重合并逻辑，并开启“预算被覆盖”日志；
- 通过 ENABLE_ACTION_BATCH 控制灰度范围和回滚。

3. **最后上线优化三（弱化伪增量）**：在 Track2 已平稳运行后启用，先对白名单中的少数账户生效，再酌情扩大覆盖范围。

整体来看，该 v3 方案在 v2 的基础上进一步提升了：

- **可观测性**：预算覆盖日志、伪增量账户计数日志。
- **正确性**：Batch 返回顺序保证、空 Insights 结果健壮处理。
- **可运维性**：多个环境开关（DISABLE_SPEND_FILTERING / ENABLE_ACTION_BATCH / Track2 开关）支持快速回退与精细化灰度。