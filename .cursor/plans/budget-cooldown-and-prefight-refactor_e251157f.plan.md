---
name: budget-cooldown-and-prefight-refactor
overview: Refactor rule execution cooling and budget actions so that all actions share a unified cooldown key abstraction, budget changes are skipped when already at target, and cooldown for budget actions is applied per target node (adset/campaign) end-to-end.
todos:
  - id: db-migration-scope-key
    content: 为 rule_ad_execution_state 添加 scope_key 列并迁移主键到 (rule_id, scope_key)，更新 Drizzle schema 映射
    status: completed
  - id: action-executor-cooldownkey
    content: 在 actionExecutorService 中为 pause/activate/预算动作计算 cooldownKey，并在返回结果中暴露给调度层
    status: completed
  - id: budget-prefight-equal-skip
    content: 在 ABO/CBO 预算执行分支中增加 Pre-Flight：当前预算等于目标预算时记为 skipped，不调 FB API
    status: completed
  - id: scheduler-write-scope-cooldown
    content: 在 executeRulesForAccount 中使用 cooldownKey 写入 rule_ad_execution_state，并对预算动作增加执行层按目标节点冷却检查
    status: completed
  - id: tests-and-validation
    content: 增加/更新相关单元测试与集成验证场景，覆盖 Pre-Flight、scopeKey 冷却和多规则互不干扰的行为
    status: pending
isProject: false
---

### 总体目标

- **统一抽象 `cooldownKey`**：所有动作（暂停/激活/预算）都使用「规则 ID + 冷却键」做冷却；冷却键可以表示广告本身，也可以表示预算目标节点。
- **预算 Pre-Flight**：当当前预算已经等于计算出的目标预算时，直接记为 skipped，不再调用 FB API，避免重复操作与噪音日志。
- **预算按目标节点冷却（含 Cron 第二步）**：预算类动作的冷却从「按广告 ad_id」升级为「按真实执行对象（adset 或 campaign）」；Cron 调度层与执行层使用同一套 cooldownKey 语义，且不同规则之间互不影响。

---

### 一、数据层改造：`rule_ad_execution_state` 支持 scopeKey（方案2）

1. **表结构迁移设计**（推荐新增列，并调整主键）

- 目标：从原来的 `(rule_id, ad_id)` 主键，演进为 `(rule_id, scope_key)`，让 scopeKey 可以表达广告或预算目标节点。
- 在迁移脚本中新建列：
  - `scope_key VARCHAR(100) NOT NULL` 注释：`'冷却键：如 ad:123, budget:act_..._c_...'`。
  - 临时保持 `ad_id` 列用于回填和兼容。
- 数据迁移步骤：
  - 第 1 步：给所有现有行填充 scope_key = CONCAT('ad:', ad_id)。
  - 第 2 步：删除原主键 `(rule_id, ad_id)`，新增主键 `(rule_id, scope_key)`。
  - 第 3 步：为 `scope_key` 加索引（如 `idx_scope_key(scope_key)`）。
  - 可选：保留 `ad_id` 作为只读诊断字段（或在后续版本清理）。
- 对应 Drizzle schema（`server/db/schema.js`）：
  - 更新 `ruleAdExecutionState` 为：
    - 字段：`ruleId`, `scopeKey`, `lastExecutedAt`, `lastStatus`。
    - 主键：`primaryKey([ruleId, scopeKey])`。
  - 若保留 `ad_id`，可映射为可选字段，仅用于兼容旧数据/调试。

2. **工具函数签名升级**

- 在 [`server/services/cronService.js`](server/services/cronService.js) 中，将冷却相关函数从 `adId` 语义改为 `scopeKey`：
  - `loadRuleAdExecutionState(ruleId, scopeKeys: string[])`：改为 SELECT scope_key；返回 `Map<scopeKey, Date>`。
  - `upsertRuleAdExecutionStateBatch(entries)`：entries 内含 `{ ruleId, scopeKey, lastStatus }`，INSERT/UPDATE 目标列为 `scope_key`。
- 所有调用方统一改用 scopeKey，不再直接传 adId。

3. **向后兼容与一次性迁移注意事项**

- 迁移脚本需要：
  - 在变更主键前，保证 `scope_key` 列上已经没有 NULL。
  - 若存在重复 (rule_id, ad_id) 行（理论上不会），需要检查并清洗后再切主键。
- 部署顺序：

  1. 在无写入窗口执行 SQL 迁移（加列+填充+换主键）。
  2. 部署包含新 Drizzle schema 与新代码的版本。

---

### 二、统一抽象：动作级 `cooldownKey` 设计

1. **cooldownKey 规则**

- 非预算类动作（`pause_ad`、`activate_ad` 等）：
  - `cooldownKey = "ad:" + adId`。
- 预算类动作（`increase_budget`/`decrease_budget`/`set_budget`）：
  - 先在预算执行逻辑中决定目标节点：
    - 若 ABO（广告组有预算）：`targetNodeId = adsetId`，`cooldownKey = "budget_adset:" + adsetId`。
    - 若 CBO（广告系列有预算）：`targetNodeId = campaignId`，`cooldownKey = "budget_campaign:" + campaignId`。
- 保证：对于同一个规则和同一个目标节点，`cooldownKey` 始终一致；不同规则之间依然由 `rule_id` 区分，不会互相影响。

2. **在执行层产出 cooldownKey**

- 在 [`server/services/actionExecutorService.js`](server/services/actionExecutorService.js) 中：
  - 在预算分支，原本已经算出了 `adsetDetail` / `campaignDetail` 与 `targetNodeId`：
    - ABO 分支：在设置 `targetNodeId = adsetId` 时，构建 `cooldownKey = "budget_adset:" + adsetId`。
    - CBO 分支：在设置 `targetNodeId = campaignId` 时，构建 `cooldownKey = "budget_campaign:" + campaignId`。
  - 对于 pause/activate 分支，可在入口处构建 `cooldownKey = "ad:" + matchedAd.ad_id`。
- 执行函数返回值扩展：
  - `executeActionsForAd` 当前返回每个动作的 `{ actionType, status, errorMessage, durationMs }`；
  - 设计为额外返回一个可选字段：`cooldownKey?`，用于调度层写冷却表（预算动作才有，非预算可不填）。

3. **调度层消费 cooldownKey**

- 在 `executeRulesForAccount` 中，当前只记录 `stateUpdates.push({ ruleId, adId, lastStatus })`：
  - 改为按如下规则：
    - 若 `results` 中某条动作携带 `cooldownKey`：
      - `scopeKey = cooldownKey`，写入 `{ ruleId, scopeKey, lastStatus }`。
    - 否则（如 pause/activate 等非预算）：
      - `scopeKey = "ad:" + adId`。
- 之后调用 `upsertRuleAdExecutionStateBatch` 时，统一传 `scopeKey`。

> 这样，「冷却键」在执行路径上被统一抽象出来，并且落地到 DB 中。

---

### 三、预算 Pre-Flight：目标值相同直接跳过

1. **ABO 分支逻辑调整**

- 位置：`increase/decrease/set_budget` 分支中的 ABO 部分：
```260:312:server/services/actionExecutorService.js
if (isABO) {
  targetNodeId = adsetId
  targetLabel = '广告组'
  const currentCents = ...
  isDaily = ...
  newBudgetCents = (action._resolvedBudgetCents != null ? ... : computeNewBudgetCentsOnce(currentCents, action))
  if (isSimulation) { ... } else {
    logger.info(`    🔧 执行: ...`)
    logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
    await api.updateAdsetBudget(...)
  }
}
```

- 新增 Pre-Flight 判断：
  - 在非 Dry Run 分支中、调用 FB API 之前：
    - 若 `currentCents === newBudgetCents`：
      - 记一条 info 日志：`"Pre-Flight: 广告组 XXX 预算已是目标值 YYY 分，跳过"`；
      - `status = 'skipped'`，`errorMessage = 'budget_already_target'`；
      - `apiRequest/apiResponse` 记录为 Pre-Flight 结构（不含真实 POST）；
      - 直接 break/return，不再调用 `updateAdsetBudget`。

2. **CBO 分支逻辑调整**

- 位置：同一预算分支中的 CBO 部分：
```314:341:server/services/actionExecutorService.js
} else {
  const campaignId = ...
  ...
  const campaignDetail = await api.getCampaignBudgetDetail(campaignId)
  currentCents = ...
  isDaily = ...
  newBudgetCents = computeNewBudgetCentsOnce(currentCents, action)
  logger.info(`    🔧 执行: ...`)
  logger.info(`      当前预算: ${currentCents} 分，新预算: ${newBudgetCents} 分`)
  await api.updateCampaignBudget(campaignId, newBudgetCents, isDaily)
}
```

- 同样在非 Dry Run +算出 `newBudgetCents` 后：
  - 若 `currentCents === newBudgetCents`：按 ABO 分支相同方式记录 skipped 日志和审计，不调 FB。

3. **与冷却键的配合**

- 即便是“已达目标值被 Pre-Flight 跳过”的情况，也应该被写入冷却表（last_status 可以记为 `no_change` 或 `success`）：
  - 这样可以避免每分钟都重复做相等判断，满足“执行频率”含义：只要规则刚刚尝试过一次，就按执行频率冷却。

---

### 四、预算冷却从“按广告”到“按目标节点”的完整链路（含 Cron 第二步）

这一节拆成两步：先保证执行层按目标节点冷却，然后让 Cron 也基于 cooldownKey 冷却，形成真正统一的语义。

#### 步骤一：执行层按目标节点冷却

1. **新增/复用冷却查询工具**

- 
  - . 单独提供一个小 helper，例如 `loadAndCheckBudgetCooldown(ruleId, scopeKey, intervalMin)`，内部调用现有 `loadRuleAdExecutionState`。

在表结构统一为 (rule_id, scope_key) 的前提下，用 loadRuleAdExecutionState 做底层查询，再加一个 isCooldownDue(ruleId, scopeKey, intervalMin) 这种 helper，把“查表 + 算 diff + 和 intervalMin 比较”包在一起。Cron 的过滤逻辑也可以改成调用同一个 helper（或一个批量版 filterByCooldown(ruleId, pairsWithIntervalMin)），这样“按目标节点冷却”和“规则互不影响”的语义只在一处实现，更稳、更好测。

- 设计建议：在 `cronService` 里增加一个可复用函数：
```js
async function isCooldownDue(ruleId, scopeKey, intervalMin) {
  const state = await loadRuleAdExecutionState(ruleId, [scopeKey])
  const lastAt = state.get(scopeKey)
  const nowUtc = Date.now()
  const diffMin = lastAt ? (nowUtc - lastAt.getTime()) / 60000 : Infinity
  return diffMin >= intervalMin
}
```


2. **在预算分支入口增加“按目标节点冷却”检查**

- 在 ABO/CBO 两个分支、算出 `targetNodeId` 和 `cooldownKey` 之后，在真实执行和 Pre-Flight 之前：
  - 调用 `isCooldownDue(meta.winnerRule.id, cooldownKey, intervalMin)`；
  - 若返回 false：
    - 记录一条日志：`"冷却未到期，跳过预算调整"`；
    - `status = 'skipped'`，`errorMessage = 'cooldown_not_reached'`；
    - 执行结果写入 automation_logs；
    - 不再调 FB，也不再往下更新预算冷却表（或按需要记录 lastStatus='skipped'）。

3. **写入冷却表**

- 在预算实际执行或 Pre-Flight 结束后，把 `(rule_id, cooldownKey)` 写入冷却表：
  - 对应 `upsertRuleAdExecutionStateBatch` 的 entries 中加入该条：
    - `{ ruleId: meta.winnerRule.id, scopeKey: cooldownKey, lastStatus: computedStatus }`。

> 完成步骤一后，即使 Cron 仍是按广告冷却，在预算执行点已经保证了「规则 × 目标节点」的冷却语义。

#### 步骤二：Cron 调度层也切换为按目标节点冷却

1. **在调度阶段预估 cooldownKey**

- 当前调度阶段只知道规则和匹配的 `matchedAd`，还未执行动作。要按目标节点冷却，需要在这里“预估” cooldownKey：
  - 对非预算类动作：仍用 `cooldownKey = "ad:" + matchedAd.ad_id`；
  - 对预算类动作：需要一个轻量的规则：
    - 若 rule.targetLevel 明确为 `adset` 或 `campaign`，可以直接用相应 ID 构造 cooldownKey；
    - 否则，可采用简化策略：在调度阶段仍用 `ad:` 前缀，而把“真正的预算冷却”留给执行层（即步骤一已经实现的那部分）。
- 由于预算路由中还会做 ABO/CBO 判定，**完全准确地在调度阶段就分辨 ABO/CBO 可能会引入额外 FB 查询**；为避免增加 GET 调用，可以采取混合策略：
  - Cron 调度层维持现有“按广告基础冷却”（保证不会无限频繁触发）；
  - 预算类的“精确按目标节点冷却”主要依赖执行层步骤一;
  - 仅在以后有足够性能预算时，再考虑在调度阶段引入预算详情缓存。

> 鉴于性能和现有设计，建议：**Cron 只做“粗粒度按广告冷却”，预算的精确冷却交给执行层**。这样逻辑简单、风险小，也满足你“规则之间互不影响 + 预算按目标节点冷却”的核心诉求。

2. **如需完全统一（可选高阶）**

- 若后续希望完全统一（Cron 也严格按目标节点冷却），可以：
  - 引入一次性的小型缓存（例如本轮评价中对每个 adsetId/campaignId 缓存一次 budgetDetail），避免多次 GET；
  - 在仲裁结果中提前做一次预算路由预估，并把 `cooldownKey` 注入到调度层的 `pairs` 结构中；
  - 将 `loadRuleAdExecutionState` / `upsertRuleAdExecutionStateBatch` 全部改用 `scopeKey`；
  - 这一步属于后续性能/架构优化，并非当前修复重复调预算的必需项。

---

### 五、测试与验证思路

1. **单元测试**

- 为 `computeNewBudgetCentsOnce` + 新增的 Pre-Flight 分支编写测试：
  - 当前=目标时不调用 updateXxxBudget，status=skipped。
- 为新的 scopeKey 冷却函数编写测试：
  - rule1/rule2 作用于同一 targetNodeId，冷却相互独立。
  - 同一规则多广告指向同一 CBO 系列，只在冷却到期前执行一次预算动作。

2. **集成测试/手工验证场景**

- 场景 A：
  - 规则 1：间隔 15 分钟，set_budget CBO 系列到 70$；
  - 规则 2：间隔 26 分钟，increase_budget 10%；
  - 同一个广告 A 同时满足两个规则条件：
    - 验证：规则 1 执行后，规则 2 在自身冷却到期并条件满足时仍能执行（规则之间互不影响）。
- 场景 B：
  - 规则 set_budget 目标 70$，预算已是 70$：
    - 日志只出现一次真实 POST，之后每轮出现 Pre-Flight skipped 日志，无 FB 预算变更记录。
- 场景 C：
  - 同一 CBO 系列下多广告命中同一预算规则：
    - 验证：冷却期内只对该系列执行一次预算调整（或一次 Pre-Flight），不存在「A 执行后，B 再次执行」的重复操作。

---

### 六、对规则执行频率语义的保证

- 冷却键始终为 `(rule_id, scopeKey)`，其中 scopeKey 可以是广告本身或预算目标节点；
- 每条规则都有自己的 `executionIntervalMinutes`，冷却仅在该规则的记录上生效：
  - 规则 1（15 分钟）和规则 2（26 分钟）作用于同一广告或同一 CBO 系列时：
    - `(rule1, scopeKey)` 与 `(rule2, scopeKey)` 是两行独立记录；
    - 规则 1 的执行不会影响规则 2 的冷却计时，完全符合你“规则之间互不影响”的要求。

通过以上改造，你可以得到：

- 统一、可扩展的冷却键抽象；
- 预算动作的 Pre-Flight 跳过与预算幂等；
- “规则 × 目标节点”维度的预算冷却，且不破坏现有 Cron 架构和规则互不干扰的语义。