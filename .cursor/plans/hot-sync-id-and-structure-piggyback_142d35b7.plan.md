---
name: hot-sync-id-and-structure-piggyback
overview: 确保今日热同步链路可靠写入 adset_id/campaign_id 并带入规则执行，同时在此基础上为广告组与广告系列增加基于 spend>0 的结构 Piggyback 补齐。
todos:
  - id: hot-sync-id-flow-review
    content: 梳理今日热同步到 matchedAd 的 adset_id/campaign_id 流向，并标出可能丢字段的环节。
    status: pending
  - id: hot-sync-id-write-read-fix
    content: 修正 today resolve、insights 合并、ad_snapshots 写入与 ruleDataService/matchedAd 构造中的 adset_id/campaign_id 读写映射，并补充 ABO/CBO 专门测试用例。
    status: pending
  - id: parent-piggyback-design
    content: 基于 activeAdIds/structurePayload 设计父级 Piggyback 的 adsetIds/campaignIds 输入集合与结构 upsert 输出接口。
    status: pending
  - id: parent-piggyback-implementation
    content: 实现并限流广告组与广告系列的结构 Piggyback（仅结构字段），确保与近3天结构同步职责不冲突。
    status: pending
  - id: docs-and-tasks-update
    content: 更新 DEV_PLAN、TASKS 及相关 docs，说明热同步 ID 补齐与父级 Piggyback 的职责，并补充验证步骤。
    status: pending
isProject: false
---

# 热同步 ID 补齐与广告组/系列结构 Piggyback 执行方案

### 1. 目标与范围

- **目标 1（必做）**：修正并验证「今日热同步 → 写入 ad_snapshots → ruleDataService → matchedAd」这条链路，确保任意被 today sync 命中的广告，都能稳定带上 **`adset_id` 与 `campaign_id`**，避免再出现 CBO/ABO 因缺少 ID 无法调整预算的情况。
- **目标 2（推荐增强）**：在现有 Piggyback 能力基础上，扩展为对 **广告组（adsets）与广告系列（campaigns）** 的结构 Piggyback ——利用今天 `spend>0` 的广告推导出其父级 ID，并补齐 `structure_adsets` / `structure_campaigns`，作为结构轮转（近 3 天）的补充，而非替代。
- **不改动**：冷数据/归档、规则执行频率与时间段、结构近 3 天轮转整体框架（`cronService` 中的结构同步任务仍保留，只调整职责说明与必要日志）。

### 2. 阶段 A：热同步链路 adset_id/campaign_id 补齐（方案 1，必做）

#### 2.1 梳理当前今日热同步写入链路

- **核心文件**：
- [`server/services/ingestorService.js`](server/services/ingestorService.js)：`syncAccountTodayStats`、`fillCampaignAdsetFromStructure`、写 ad_snapshots 的内部队列逻辑。
- [`server/services/ruleDataService.js`](server/services/ruleDataService.js)：`queryAdSnapshots` / 类似查询方法。
- [`server/services/ruleEngineDispatcher.js`](server/services/ruleEngineDispatcher.js)：`loadDataForAccount`、`evaluateRuleWithCache`。
- [`server/services/actionExecutorService.js`](server/services/actionExecutorService.js)：预算执行处根据 `matchedAd.adset_id` / `matchedAd.campaign_id` 决定 ABO/CBO 路径并打当前这条警告日志。
- **动作**：
- 通读上述函数，画出一条从 **Today API 响应（insights） → resolveObjectsByIds 结果（structurePayload） → ad_snapshots 行 → ruleDataService DTO → matchedAd** 的数据流，确认哪些环节读/写 `adset_id` / `campaign_id`。
- 标注出任何一个可能"丢字段"或"未 select 出来"的位置，作为后续改动点候选。

#### 2.2 校验 Today resolve 结果是否完整带出结构 ID

- **检查点**：`syncAccountTodayStats` 中 resolve 段落：
- 确认 `STRUCTURE_FIELDS` / `ADS_FIELDS` 至少包含：`id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time`。
- 确认循环中构建 `structurePayload[adId] `时，确实赋值了 `adset_id` 与 `campaign_id`。
- **调整思路（若有缺失）**：
- 若字段列表里缺 `adset_id`/`campaign_id`，直接在 `STRUCTURE_FIELDS` 中补上；
- 若 resolve 结果里字段名是 `adset_id` / `campaign_id` 但 DTO 命名不一致，统一到与 DB/Rule 层一致的命名。

#### 2.3 在写入 ad_snapshots 之前合并结构 ID

- **现有逻辑**：`syncAccountTodayStats` 中已经有一段 `insights.forEach(...)`，会根据 `statusMap` 和 `structurePayload` 合并状态与结构字段。
- **校验与补强**：
- 确认该 `forEach` 在任何写入队列之前执行，确保所有 `insight` 在入队前就拥有 `adset_id` / `campaign_id`；
- 在这段逻辑里，明确加入：
- 若 `payload.campaign_id` 非空，则设置 `insight.campaign_id`；
- 若 `payload.adset_id` 非空，则设置 `insight.adset_id`；
- 确认之后仍保留 `await fillCampaignAdsetFromStructure(accountId, insights)` 作为兜底。

#### 2.4 确认 ad_snapshots schema 与写入映射

- **文件**：
- [`server/db/schema.js`](server/db/schema.js)：`ad_snapshots` 表定义，应含 `ad_set_id` 与 `campaign_id` 列（已由迁移 020/021 完成）。
- 对应的写入函数（如 `saveSnapshotsToDbInternal` 或等价名称）。
- **检查内容**：
- 写入 ad_snapshots 的 SQL/映射中，确认使用 `insight.adset_id` / `insight.campaign_id` 正确填充 DB 列；
- 若存在命名不一致（如列叫 `ad_set_id`、DTO 叫 `adset_id`），确保映射函数中做了正确转换；
- 在写入前不再有任何逻辑把这两个字段覆盖为 null/空串。

#### 2.5 确认 ruleDataService 读出 ID 并传入 matchedAd

- **文件**：[`server/services/ruleDataService.js`](server/services/ruleDataService.js)、[`server/services/ruleEngineDispatcher.js`](server/services/ruleEngineDispatcher.js)。
- **步骤**：
- 在 `queryAdSnapshots` / `loadDataForAccount` 中检查 SELECT 语句，确保包含 `campaign_id` 与 `ad_set_id` 列；
- 确认返回的 DTO（用于规则评估的数据结构）已经带上这些字段；
- 在 RuleEngine/Dispatcher 构建 `matchedAd` 的地方，显式将 `campaign_id` 与 `adset_id` 写入 `matchedAd` 对象：
- 例如 `matchedAd = { ad_id, ad_name, status, adset_id: row.ad_set_id, campaign_id: row.campaign_id, ... }`；
- 确认 `actionExecutorService` 中只依赖 `matchedAd.*`，不再直接去 DB 或快照再查一轮。

#### 2.6 针对 ABO/CBO 规则执行路径的针对性测试设计

- **新增/扩展测试用例位置**：`server/tests` 下与 ruleEngineDispatcher / actionExecutorService 相关的测试文件。
- **典型测试场景**：
- **场景 1：ABO**
- 构造 ad_snapshots 行：`ad_id=A1, ad_set_id=S1, campaign_id=C1, status=ACTIVE`；
- 规则触发 `increase_budget`；
- 断言：执行路径调用的是 `getAdsetBudgetDetail(S1)` 与 `updateAdsetBudget(S1, ...)`，没有 CBO 警告日志。
- **场景 2：CBO**
- 构造 ad_snapshots 行：`ad_id=A2, ad_set_id=S2(无预算), campaign_id=C2(有预算), status=ACTIVE`；
- 规则触发 `increase_budget`；
- 断言：执行路径最终调用 `getCampaignBudgetDetail(C2)` 与 `updateCampaignBudget(C2, ...)`，**不再出现「CBO 广告系列但无 campaign_id」警告**。
- **场景 3：结构表兜底**
- 构造 ad_snapshots 行中 `campaign_id` 为空，但 structure_ads 中存在 `ad_id=A3, campaign_id=C3`；
- 模拟 today sync 中 `fillCampaignAdsetFromStructure` 的效果，确保最后 matchedAd 包含 `campaign_id=C3`，执行时走 CBO 路径而非失败。

### 3. 阶段 B：父级结构 Piggyback（广告组 + 广告系列，方案 2，增强项）

#### 3.1 设计父级 Piggyback 的输入与出口

- **输入来源**（沿用现有 Piggyback 思路）：
- `syncAccountTodayStats` 中的 `activeAdIds` 与 `structurePayload`；
- `structurePayload[adId] `已包含 `adset_id` 与 `campaign_id`。
- **父级 ID 集合构造**：
- `adsetIds = 去重后的所有 payload.adset_id（过滤空值）`；
- `campaignIds = 去重后的所有 payload.campaign_id（过滤空值）`；
- 可按批次（例如每 200 或 500 个）处理，避免单次请求过长。
- **出口**：
- 调用新的内部函数，例如：
- `piggybackAdsetsFromToday(accountId, adsetIds, facebookApi)`；
- `piggybackCampaignsFromToday(accountId, campaignIds, facebookApi)`；
- 这两个函数负责：调 FB API → upsert `structure_adsets` / `structure_campaigns`。

#### 3.2 复用现有结构同步的字段与 upsert 逻辑

- **字段列表复用**：
- `ADSETS_FIELDS = 'id,name,effective_status,status,campaign_id,updated_time,created_time'`；
- `CAMPAIGNS_FIELDS = 'id,name,effective_status,status,updated_time,created_time'`；
- 与 [`server/services/structureSyncService.js`](server/services/structureSyncService.js) 中用于结构同步的字段集保持一致，避免列不一致导致后续查询/索引问题。
- **upsert 逻辑复用**：
- 参考 `doStructureAdsetsUpsert` / `doStructureCampaignsUpsert` 的 SQL 或内部 upsert 函数，新增/复用对应的 `UPSERT_STRUCTURE_ADSETS_SQL` / `UPSERT_STRUCTURE_CAMPAIGNS_SQL`；
- Piggyback 调用时仅传入本轮需要补齐的 adset/campaign 记录，避免与定时结构同步重复处理全量。

#### 3.3 调用 Facebook API 的方式与限流

- **调用方式选择**：
- 若 `FacebookMarketingAPI` 已提供 `resolveObjectsByIds` 仅针对 ads，可考虑：
- 新增 `resolveAdsetsByIds` / `resolveCampaignsByIds`；或
- 借助现有 `getStructurePage` 封装，传入 `ids` 过滤（若支持）。
- 字段仅限结构字段，不请求 metrics，减小响应体与配额消耗。
- **频率控制与优先级**：
- 将父级 Piggyback 视为 **P1 best-effort 任务**：
- 只在 Today 成功且 `activeAdIds.length > 0` 时触发；
- 总量受限于 `adsetIds` / `campaignIds` 集合大小；
- 可以配合现有 `p-limit` / usage 自适应休眠策略，避免与主心跳/结构轮转抢资源。
- 日志中记录本轮父级 Piggyback 的触达数：例如
- `[PiggybackParent] account=... adsets=XX campaigns=YY`。

#### 3.4 与「结构同步（近 3 天）」的职责边界

- **结构同步继续保留的职责**：
- 覆盖 **所有** 近 3 天有结构变更的对象，无论其是否产生过 spend；
- 包括：新建未投放、仅改名/改状态、冷账户的结构更新。
- **父级 Piggyback 的补充作用**：
- 对于「今天真的在跑钱」的那批对象，父级 Piggyback 可以让其 adset/campaign 结构更快更新；
- 结构轮转负责"全局一致性"，父级 Piggyback 负责"今日热路径的快速一致性"。
- **计划中明确写清**：在 DEV_PLAN / TASKS 更新时，将这一职责划分说明在对应章节，避免未来误删结构同步任务。

#### 3.5 父级 Piggyback 的测试与验证思路

- **接口/日志验证**：
- 在测试环境触发一次 today sync（有 spend>0），通过日志检查：
- `[Piggyback]` 针对 ads 的日志；
- `[PiggybackParent]` 或类似前缀针对 adsets/campaigns 的日志；
- 用 SQL 检查 `structure_adsets` / `structure_campaigns` 中最近写入的记录是否包含：
- 来自本轮 `adsetIds` / `campaignIds`；
- `created_time` / `updated_time` 字段合理、有最近的 `last_synced_at`。
- **回归结构同步**：
- 按 `docs/结构同步近3天_测试与验证指南.md` 执行一次结构同步验证，确认轮转逻辑仍正常工作（未被父级 Piggyback 干扰）。

### 4. 阶段 C：文档与任务清单更新（可并入已有 DEV_PLAN/TASKS 更新流程）

- 在 [`DEV_PLAN.md`](DEV_PLAN.md) 与 [`TASKS.md`](TASKS.md) 中：
- 为「Today 同步 ID 补齐」与「父级结构 Piggyback」各增加一条简要说明与勾选项；
- 在结构同步章节补充一小段「热同步 Piggyback vs 结构近 3 天轮转」的职责说明，避免后续误认为结构同步可以删除；
- 若有新的测试文档（比如 "CBO/ABO ID 补齐与预算执行验证"），在 `docs/` 下新增并在 DEV_PLAN/TASKS 中挂链接。

### 5. 计划执行顺序建议

1. **先完成阶段 A**：从代码阅读 → ID 流向梳理 → 写入/读取链路修正 → 单测/集成测试（优先解决 CBO/ABO 无 ID 导致的预算执行失败）。
2. **再做阶段 B**：在确认热链路 ID 正确后，再扩展父级 Piggyback，用 spend>0 驱动 adset/campaign 的结构补齐与快速更新。
3. **最后更新文档**：在 DEV_PLAN / TASKS / 新增 docs 中将上述改动沉淀为长期约定与验证清单。