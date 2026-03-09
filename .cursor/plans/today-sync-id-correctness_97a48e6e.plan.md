---
name: today-sync-id-correctness
overview: 只修复今日热同步链路中 adset_id/campaign_id 的补齐与传递，保证 ABO/CBO 预算动作稳定执行，不新增父级 Piggyback 或结构同步复杂度。
todos:
  - id: today-sync-id-flow-review
    content: 梳理今日热同步到 matchedAd 的 adset_id/campaign_id 流程，并在 ingestorService/structureSyncService/ruleDataService/ruleEngineDispatcher 中标出读写位置。
    status: pending
  - id: today-sync-insight-id-merge
    content: 在 syncAccountTodayStats 中确认 ADS_FIELDS/STRUCTURE_FIELDS 包含 adset_id/campaign_id，并在写入前将 resolve 结果统一合并到 insight.campaign_id/insight.adset_id。
    status: pending
  - id: ad-snapshots-write-mapping
    content: 检查和调整 ad_snapshots 写入函数的 DTO→DB 映射，确保 ad_set_id/campaign_id 正确写入且不被覆盖为默认值。
    status: pending
  - id: rule-read-and-matchedAd-id
    content: 检查 ruleDataService 与 ruleEngineDispatcher，将 ad_set_id/campaign_id 从 ad_snapshots 读出并写入 matchedAd，保证 actionExecutor 只依赖 matchedAd 上的 ID。
    status: pending
  - id: abo-cbo-tests-and-docs
    content: 为 ABO/CBO 预算执行设计测试场景并更新相关 docs，说明热链路 ID 补齐与结构同步近3天轮转的职责边界。
    status: pending
isProject: false
---

# 今日热同步 ID 补齐与预算执行稳定性方案

### 1. 目标与边界

- **核心目标**：
  - 确保所有被今日热同步命中的广告，在规则执行时都能可靠带上 **`adset_id` 与 `campaign_id`**，从而让 **ABO（按广告组调预算）** 与 **CBO（按广告系列调预算）** 的预算动作稳定执行，不再出现「CBO 广告系列但无 campaign_id」之类的问题。
- **明确不做**：
  - 不新增「父级 Piggyback」逻辑，不为广告组/广告系列单独再打一批 API；
  - 不改动现有「结构同步近 3 天轮转」的框架与职责，只在文档口径上说明它和热链路的分工。

---

### 2. 梳理现有热链路数据流（只读确认）

- **关键链路文件**：
  - 今日同步与 Piggyback：[`server/services/ingestorService.js`](server/services/ingestorService.js)
    - `syncAccountTodayStats(accountId, ownerId, timezoneName, facebookApi)`
    - `fillCampaignAdsetFromStructure(accountId, items)`
  - 结构解析与结构表 Piggyback：[`server/services/structureSyncService.js`](server/services/structureSyncService.js)
    - `ADS_FIELDS` 常量
    - `piggybackStructureFromToday(accountId, activeAdIds, structurePayload, facebookApi)`
  - 规则数据读取：[`server/services/ruleDataService.js`](server/services/ruleDataService.js)
    - 针对 `ad_snapshots` 的查询函数（如 `queryAdSnapshots`/`loadAdMetricsForAccount` 等）
  - 规则执行与预算动作：
    - [`server/services/ruleEngineDispatcher.js`](server/services/ruleEngineDispatcher.js)
    - [`server/services/actionExecutorService.js`](server/services/actionExecutorService.js)（ABO/CBO 预算分支以及「CBO 广告系列但无 campaign_id」警告所在）
- **输出一条清晰数据流**（只读分析，不改代码）：

  1. Today 调 FB Insights → 拿到 `insights[]`（含 `ad_id`、可能含部分 `adset_id/campaign_id`）。
  2. Today 调一次 `resolveObjectsByIds(activeAdIds, { fields: STRUCTURE_FIELDS })` → 得到 `allAdsWithStructure[]`，组装成 `structurePayload[adId] = { name, effective_status, adset_id, campaign_id, ... }`。
  3. `insights.forEach(...)` 中合并 status 与结构字段 → 准备写入队列。
  4. 写入队列函数将 `insight` 映射为 DB 的 `ad_snapshots` 行（含 `ad_set_id` / `campaign_id` 列）。
  5. `ruleDataService` 从 `ad_snapshots` 中 SELECT，构建规则评估 DTO。
  6. `ruleEngineDispatcher` 将 DTO 转成 `matchedAd`，传给 `actionExecutorService`。
  7. `actionExecutorService` 根据 `matchedAd.adset_id` / `matchedAd.campaign_id` 决定走 ABO 还是 CBO 分支。

---

### 3. Today resolve 与 insights 的 ID 补齐（上游保证有 ID）

#### 3.1 校验并固化 ADS_FIELDS / STRUCTURE_FIELDS

- 在 [`server/services/structureSyncService.js`](server/services/structureSyncService.js) 与 [`server/services/ingestorService.js`](server/services/ingestorService.js) 中确认：
  - `ADS_FIELDS` / `STRUCTURE_FIELDS` 至少包含：
    - `id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time`
  - 若有命名差异（如某处仅用 `ADS_FIELDS`、某处自己拼字段串），统一为同一常量，避免某条路径漏掉 `adset_id/campaign_id`。

#### 3.2 明确 structurePayload 的内容

- 在 `syncAccountTodayStats` 中构建 `structurePayload` 时，确保：
  - `structurePayload[adId] = { name, effective_status, status, configured_status, adset_id, campaign_id, updated_time, created_time }`；
  - **不丢 `adset_id/campaign_id`**，即使 Insight 本身已有 `campaign_id`，也要以 resolve 结果为权威来源之一。

#### 3.3 在入队前统一合并结构 ID

- 在 `insights.forEach(insight => { ... })` 那段逻辑中（同一函数内）：
  - 固化如下逻辑（伪代码层面，不改实现框架）：
    ```js
    const payload = structurePayload[adId]
    if (payload) {
      if (payload.campaign_id != null) insight.campaign_id = payload.campaign_id
      if (payload.adset_id != null) insight.adset_id = payload.adset_id
    }
    ```

  - 保证 **在任何写入队列 / 落盘之前**，`insight.campaign_id` 与 `insight.adset_id` 就已经被 resolve 结果补齐。

#### 3.4 结构表兜底：fillCampaignAdsetFromStructure（仅查 DB，不加 API）

- 保持并利用现有兜底逻辑：
  - `await fillCampaignAdsetFromStructure(accountId, insights)` 会：
    - 对 `campaign_id/adset_id` 仍为空的 insight；
    - 只查 `structure_ads`（`SELECT ad_id,adset_id,campaign_id ...`）；
    - 把查到的值写回 insight 的 `campaign_id/adset_id`；
  - 明确这一步 **只是 DB 兜底，不额外调用 FB API**。
- 计划中要求：
  - 检查 SQL 与映射，确认 `item.campaign_id` 与 `item.adset_id` 被正确修改；
  - 用一两个 SQL/测试场景验证：当 `ads` 表中有 `campaign_id` 但 Insight 缺失时，最后写库的 `ad_snapshots` 能补上这个 ID。

---

### 4. 写入 ad_snapshots：DTO → DB 映射校验

#### 4.1 确认 ad_snapshots schema 含 ID 列

- 在 [`server/db/schema.js`](server/db/schema.js) 中确认：
  - `ad_snapshots` 表包含：`ad_set_id`、`campaign_id` 列（已有迁移 020/021 支持）。
  - 字段类型与长度与结构表保持兼容（一般为 `VARCHAR(50)`）。

#### 4.2 检查写入函数映射

- 在 [`server/services/ingestorService.js`](server/services/ingestorService.js) 中，找到写 `ad_snapshots` 的函数（例如 `saveSnapshotsToDbInternal` 或类似命名）：
  - 确认映射中存在：
    - `ad_set_id` ← `insight.adset_id`
    - `campaign_id` ← `insight.campaign_id`
  - 确认不会在写入前有任何逻辑把这两个字段清空或覆盖为默认值。
- 如有必要，在计划中标出「若写入函数当前未使用这两个字段，需要补上映射」这一项，作为后续具体实现点。

---

### 5. 规则数据读取与 matchedAd 构造：下游正确携带 ID

#### 5.1 ruleDataService 中的 SELECT 字段

- 在 [`server/services/ruleDataService.js`](server/services/ruleDataService.js) 中，找出读取今日/区间数据用于规则评估的查询逻辑：
  - 确认 SELECT 中包含 `ad_set_id` 与 `campaign_id` 列；
  - 返回 DTO 中保留这两个字段（例如 `row.ad_set_id`、`row.campaign_id`）。

#### 5.2 ruleEngineDispatcher / RuleEngine 构造 matchedAd

- 在 [`server/services/ruleEngineDispatcher.js`](server/services/ruleEngineDispatcher.js) 或 RuleEngine 构造 `matchedAd` 的位置：
  - 将 `ad_set_id` 与 `campaign_id` 显式映射到 `matchedAd`：
    - `matchedAd = { ad_id, ad_name, status, adset_id: row.ad_set_id, campaign_id: row.campaign_id, ... }`。
  - 确保 M4 的 `actionExecutorService` **只依赖 `matchedAd` 上的这两个字段**，不再自己查库或做二次 resolve。

#### 5.3 actionExecutorService 中 ABO/CBO 路径自检

- 在 [`server/services/actionExecutorService.js`](server/services/actionExecutorService.js) 中：
  - 确认 ABO 分支（adset 有预算）只看 `matchedAd.adset_id`；
  - 确认 CBO 分支在 `!isABO` 且 `matchedAd.campaign_id` 存在时才调用 `getCampaignBudgetDetail` / `updateCampaignBudget`；
  - 当 `matchedAd.campaign_id` 缺失时，目前日志会打出「CBO 广告系列但无 campaign_id，无法调整预算」，这是我们要通过上游链路修复来消除的情况。

---

### 6. 专门为 ABO/CBO 设计的验证与测试计划

#### 6.1 单元/集成测试场景设计

- 在 `server/tests` 目录中（不在本方案中修改代码，仅规划用例）：
  - **场景 A：标准 ABO**
    - 构造一条 ad_snapshots 行：`ad_id=A1, ad_set_id=S1, campaign_id=C1, status=ACTIVE`；
    - 注入到 ruleDataService 的测试数据源，触发 `increase_budget` 类型规则；
    - 断言：
      - 走的是 `getAdsetBudgetDetail(S1)` → `updateAdsetBudget(S1, ...)` 路径；
      - 未打印 CBO 相关的警告日志。
  - **场景 B：标准 CBO**
    - 构造快照：`ad_id=A2, ad_set_id=S2(无预算)、campaign_id=C2(有预算)`；
    - 触发预算规则；
    - 断言：
      - 走的是 `getCampaignBudgetDetail(C2)` → `updateCampaignBudget(C2, ...)` 路径；
      - 不再出现「CBO 广告系列但无 campaign_id」警告。
  - **场景 C：结构表兜底**
    - ad_snapshots 中 `campaign_id` 为空，但 `structure_ads` 里 `ad_id=A3, campaign_id=C3`；
    - 模拟 today sync 调用 `fillCampaignAdsetFromStructure` 后再写库；
    - 断言：规则执行时 `matchedAd.campaign_id=C3`，预算执行正常。

#### 6.2 日志与 SQL 手工验证

- 手工在测试环境执行一轮 today sync（已有 spend>0 的广告）：
  - 看 `ingestorService` 日志中：
    - `✅ 从 API 查询到 ... spend>0`；
    - `📋 批量解析活跃广告元数据`；
    - （如有）`[structure_ads 兜底] 补齐 ... 条 campaign_id/adset_id`。
  - 用 SQL 验证：
    - 从 `ad_snapshots` 里随机抽几条今日快照，确认 `ad_set_id/campaign_id` 非空且与 FB 后台对应广告一致。

---

### 7. 结构同步的职责说明（仅文档口径，不改代码）

- 在 [`docs/0结构同步任务改造—执行方案.md`](docs/0结构同步任务改造—执行方案.md) 或新的补充文档中，增加一小段说明：
  - **热链路（Today + resolve + ad_snapshots）**：
    - 负责「今天确实在花钱的广告」的指标与 ID 完整性；
    - 保障规则执行与预算动作依赖的 `adset_id/campaign_id` 可靠。
  - **结构同步近 3 天轮转**：
    - 负责「近 3 天所有结构变更」（新建、改名、改状态），不依赖是否有 spend；
    - 维护 `structure_campaigns/adsets/ads` 的 name/status/created_time/updated_time 镜像。
  - 两者互补：**删除任何一条都会有盲区**，但在预算执行这个问题上，只需通过阶段 A 修复热链路即可，不需要新增父级 Piggyback。

---

### 8. 执行顺序建议

1. **先做链路梳理与字段确认（章节 2、3）**：只读查清 Today → ad_snapshots → matchedAd 的 ID 流向，标记具体需要修正的函数与字段。
2. **再做写入/读取侧的映射校准（章节 4、5）**：确保 `insight` → `ad_snapshots` → `ruleDataService` → `matchedAd` 中 ID 不丢、不被覆盖。
3. **最后补上 ABO/CBO 专门测试与文档说明（章节 6、7）**：用测试与 SQL/日志双重验证预算执行不再因缺 ID 报错，同时在文档中固化「热链路 vs 结构同步」分工，方便以后维护。