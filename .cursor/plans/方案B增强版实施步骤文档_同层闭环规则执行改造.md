# 方案B增强版实施步骤文档：同层闭环规则执行改造

## 1. 文档定位

### 1.1 [目标]

- 本文档用于指导 `feat/rule-exec-closed-loop-b` 分支上的实际开发。
- 目标不是再次讨论方案是否成立，而是把既有 `plan` 转成可直接执行的开发步骤。
- 读者对象分为两类：
  - 人工开发者：需要知道改哪里、为什么这样改、如何验收。
  - `auto`：需要按顺序推进，不跳步骤，不混淆合同边界。

### 1.2 [核心约束]

1. `rules.actions[*].type` 的**持久化合同不变**，继续保存 `pause_ad`、`activate_ad`、`increase_budget`、`decrease_budget`、`set_budget`。
2. **执行语义**在运行时解释：`pause_ad`、`activate_ad` 由 `targetLevel` 决定实际作用在 `ad`、`adset`、`campaign`。
3. 本次改造按 **M1 -> M2 -> M3 -> M4 -> M5** 顺序推进，禁止跳过 `typed snapshot` 直接改执行层。
4. 每个里程碑都必须同时交付：
  - 代码改动
  - 测试改动
  - 验证记录
  - 回归确认

## 2. 当前代码基线与实施依据

### 2.1 [现状结论]

1. `targetLevel` 的前后端配置入口已经存在，说明“规则目标层级”这条合同已经建立。
2. `rule_matched_objects` 当前仍是 **ad-only 快照模型**，`object_type` 只是预留字段，没有真正进入业务闭环。
3. `ruleEngineDispatcher` 与 `ruleDataService` 当前仍以 **ad_id 聚合与评估** 为中心。
4. `actionExecutorService`、`FacebookMarketingAPI`、`automation_logs` 当前仍以 **ad 状态动作与 ad 审计字段** 为中心。

### 2.2 [当前代码证据]

- `server/routes/rules.js`
  - 已校验 `targetLevel` 为 `ad|adset|campaign`。
- `src/views/RuleManager.vue`
  - 已支持 `targetLevel` 的 UI 选择与提交。
- `server/services/dynamicScopeService.js`
  - 快照写入时固定写入 `object_type='ad'`。
- `server/services/ruleEngineDispatcher.js`
  - 动态快照读取时固定过滤 `object_type = 'ad'`。
- `server/services/ruleDataService.js`
  - 当前只有 `queryRuleData(...)`，没有 `queryRuleDataByLevel(...)`。
- `server/services/actionExecutorService.js`
  - 状态动作仍调用 `pauseAd`、`activateAd`，日志仍写 `adId`、`adName`。
- `server/index.js`
  - 仅存在 `pauseAd`、`activateAd`，没有 `pauseAdset`、`activateAdset`、`pauseCampaign`、`activateCampaign`。
- `server/routes/system.js`
  - 审计日志列表与详情接口当前主要读取 `ad_id`、`ad_name`。
- `server/services/ruleExecutionStateService.js`
  - 冷却层已经支持通用 `scopeKey`，这是后续按层级扩展的基础。

### 2.3 [为什么必须按顺序做]

1. `M2` 不完成，`M3` 就无法基于同层对象做查询。
2. `M3` 不完成，`M4` 就只能继续拿 ad 级数据去执行 adset/campaign 动作，语义会错位。
3. `M4` 不完成，`M5` 的日志与冷却键就只能记录错误对象，审计会失真。

## 3. 总体开发节奏

### 3.1 [建议提交节奏]

1. `M1` 单独一个提交：合同与内部解释层。
2. `M2` 单独一个提交：typed snapshot + migration。
3. `M3` 单独一个提交：同层查询与性能门禁。
4. `M4` 单独一个提交：同层状态执行与 pre-flight 信任门禁。
5. `M5` 单独一个提交：审计模型、冷却键、读路径兼容。

### 3.2 [每个里程碑固定动作]

1. 先改后端合同与数据结构。
2. 再改执行/查询主链路。
3. 再补测试。
4. 最后跑验证命令并记录结果。

### 3.3 [固定验证命令]

1. `npm test`
2. `npm run build`
3. 如需联调：`npm run dev:all`

## 4. 里程碑1：合同层落地（动作语义与兼容）

### 4.1 [目标]

- 明确并固化 **“旧动作枚举继续入库，执行前按 `targetLevel` 解释”** 的边界。
- 避免后续开发中把 `pause_ad` 误改为新的持久化枚举，导致历史数据不兼容。

### 4.2 [设计意图]

1. 数据库存量规则已经使用旧动作枚举，直接整体迁移风险高。
2. 前端、模板校验、优先级逻辑、叙述文案都依赖旧枚举，先稳住合同，改造成本可控。
3. 把“动作含义解释”放在执行层，属于**解释器层改造**，不会破坏存量数据。

### 4.3 [修改范围]

- `server/routes/rules.js`
- `server/utils/templateValidator.js`
- `server/utils/actionPriority.js`
- `server/services/actionExecutorService.js`
- `src/utils/ruleAuditNarrative.js`
- `src/views/RuleManager.vue`

### 4.4 [具体执行步骤]

1. 在 `server/routes/rules.js` 明确接口级合同注释与校验逻辑：
   - `pause_ad`、`activate_ad` 合法。
   - `targetLevel` 合法值固定为 `ad|adset|campaign`。
   - 若未来引入 `pause_adset`、`pause_campaign` 一类新枚举，且与 `targetLevel` 不一致，直接 `400`。
2. 在 `server/utils/templateValidator.js` 保持旧枚举白名单不变，只补充注释，明确“旧枚举 = 持久化合同”。
3. 在 `server/services/actionExecutorService.js` 新增内部解析函数，例如：
   - `resolveStatusActionIntent(rule, action, matchedObject)`
   - 返回 `resolvedStatusTargetLevel`、`resolvedStatusOp`、`resolvedObjectId`、`resolvedObjectName`
4. 本阶段只建立**解释层**，不在这里一次性完成 adset/campaign API 调用。
5. 在 `src/views/RuleManager.vue` 与 `src/utils/ruleAuditNarrative.js` 统一文案：
   - 状态动作作用于“目标层级对象”。
   - 预算动作仍保持 ABO/CBO 智能路由。

### 4.5 [验证与测试]

1. 接口测试：
   - 创建 `targetLevel=campaign` 且 `actions=[{type:'pause_ad'}]` 的规则。
   - 期望：接口创建成功，数据库仍保存 `pause_ad`。
2. 单元测试：
   - 在 `server/tests/rules.test.js` 增加 `pause_ad + campaign` 的创建/更新用例。
   - 在 `server/tests/templateValidator.test.js` 验证旧枚举仍然通过。
3. 人工验收：
   - 打开规则管理页，确认动作文案没有误导成“只作用于广告”。

### 4.6 [完成标准]

1. 规则创建、更新、模板校验都继续接受旧动作枚举。
2. 代码中出现统一的内部解释层入口，后续 `M4` 直接复用。
3. 前端与审计叙述文案不再把状态动作写死成广告级语义。

## 5. 里程碑2：typed snapshot 落地（同层快照）

### 5.1 [目标]

- 把 `rule_matched_objects` 从 ad-only 快照改为真正的 **typed snapshot**。
- 让 `object_type` 与 `object_id` 成为同层对象标识，而不是“广告 ID 外挂一个类型字段”。

### 5.2 [设计意图]

1. `ad`、`adset`、`campaign` 的 ID 字符串存在碰撞可能，旧唯一键不安全。
2. 动态筛选如果继续下钻到广告层，规则条件和执行对象会出现**层级错位**。
3. 同层快照是整个闭环的基础数据源，必须先稳定。

### 5.3 [修改范围]

- `server/db/schema.js`
- `server/db/migrations`
- `server/services/dynamicScopeService.js`
- `server/services/ruleEngineDispatcher.js`
- `server/tests/dynamicScopeService.helpers.test.js`
- `server/tests/rules.test.js`

### 5.4 [具体执行步骤]

1. 新建 migration，例如 `044_rule_matched_objects_typed_snapshot.sql`：
   - 删除旧唯一键 `(rule_id, account_id, object_id)`。
   - 新增唯一键 `(rule_id, account_id, object_type, object_id)`。
   - 新增索引 `idx_account_rule_type(account_id, rule_id, object_type)`。
2. 更新 `server/db/schema.js` 注释，把 `objectType` 的语义从“预留”改为“真实业务字段”。
3. 改造 `server/services/dynamicScopeService.js`：
   - 新增“按层产出对象”的标准结构，例如 `{ objectType, objectId, objectName }`。
   - `targetLevel=ad` 产出 ad。
   - `targetLevel=adset` 产出 adset。
   - `targetLevel=campaign` 产出 campaign。
4. 快照写入逻辑改成基于对象数组写入，不再假设 `finalAdIds`。
5. 历史 diff 逻辑改为比较复合键：
   - 旧逻辑只比较 `object_id`，跨层会冲突。
   - 新逻辑必须比较 `${objectType}:${objectId}`。
6. `rule_matched_objects_history` 的 `object_ids_snapshot` 与 checksum 也要写入复合 token，而不是裸 `object_id`。
7. `server/services/ruleEngineDispatcher.js` 本阶段先完成“按规则目标层读取快照”的入口改造：
   - 读取时不再写死 `object_type='ad'`。
   - 先返回 `targetObjectIds` 与 `targetLevel`，供 `M3` 使用。

### 5.5 [验证与测试]

1. migration 验证：
   - 执行后检查 `SHOW INDEX FROM rule_matched_objects;`
   - 必须看到新的唯一键与 `idx_account_rule_type`。
2. 单元测试：
   - 补 `server/tests/dynamicScopeService.helpers.test.js`
   - 场景覆盖 `ad/adset/campaign` 三种快照写入。
   - 覆盖同一 `object_id` 在不同 `object_type` 下可共存。
3. 接口/集成测试：
   - 在 `server/tests/rules.test.js` 或新增集成用例中验证动态筛选规则刷新后，快照表写入目标层对象。
4. SQL 验证：
   - 手工查询 `rule_matched_objects`，确认 `targetLevel=campaign` 时 `object_type='campaign'`。

### 5.6 [完成标准]

1. `rule_matched_objects` 可同时安全存储 `ad/adset/campaign`。
2. 动态快照历史 diff 不再因跨层同 ID 发生误判。
3. 调度器可按规则层级读取目标对象，而不是只读 ad。

## 6. 里程碑3：同层查询与判断（query by level + SQL 门禁）

### 6.1 [目标]

- 实现 `queryRuleDataByLevel(accountId, objectIds, level, timeWindow, timezone, customRange)`。
- 把规则判断从“只支持 ad 数据”升级为“按目标层级聚合后判断”。

### 6.2 [设计意图]

1. `adset`、`campaign` 规则必须先把分子与分母聚合，再计算 `ROAS`、`CPA`、`UCPC` 等派生指标。
2. 直接平均子节点指标会产生错误结果，属于典型的**聚合口径错误**。
3. 查询改造后会显著增加 SQL 压力，因此必须同步建立性能门禁。

### 6.3 [修改范围]

- `server/services/ruleDataService.js`
- `server/services/ruleEngineDispatcher.js`
- `server/db/migrations`
- `server/tests/ruleDataService.test.js`
- `server/tests/ruleEngineDispatcher.test.js`

### 6.4 [具体执行步骤]

1. 在 `server/services/ruleDataService.js` 新增 `queryRuleDataByLevel(...)`。
2. 保留现有 `queryRuleData(...)` 作为 ad 兼容入口：
   - `queryRuleData(...)` 内部可以继续服务 ad 规则。
   - `queryRuleDataByLevel(...)` 为新主路径。
3. 为不同层级建立统一聚合维度：
   - `ad` 使用 `ad_id`
   - `adset` 使用 `ad_set_id` 或系统内统一字段名
   - `campaign` 使用 `campaign_id`
4. 聚合规则固定为：
   - 先 `SUM(spend)`、`SUM(purchase_value)`、`SUM(link_clicks)`、`SUM(unique_link_clicks)`、`SUM(purchases)`
   - 再计算 `roas`、`cpa`、`ucpc`、`ctr`、`cpc`
5. 在 `server/services/ruleEngineDispatcher.js` 改造缓存结构：
   - 缓存 key 必须包含 `level + timeWindow + customRange`
   - 不能把 ad 与 adset 的结果共用一个 cache key
6. 动态规则与静态规则都改成“以目标层对象 ID”为过滤集，不再默认回落到 ad union。
7. 新增性能索引 migration，例如 `045_add_level_aggregation_indexes.sql`：
   - `daily_stats(account_id, date, ad_set_id)`
   - `daily_stats(account_id, date, campaign_id)`
   - `ad_snapshots(account_id, data_date, ad_set_id)`
   - `ad_snapshots(account_id, data_date, campaign_id)`
8. 为 `ad/adset/campaign` 三类核心 SQL 分别输出 `EXPLAIN` 样例，作为交付物。
9. 如当前字段命名不统一，例如 `adset_id` 与 `ad_set_id` 混用，先在查询层做统一映射，禁止把字段命名问题扩散到规则引擎上层。

### 6.5 [验证与测试]

1. 单元测试：
   - `server/tests/ruleDataService.test.js` 增加 adset/campaign 聚合测试。
   - 明确验证“先求和再计算派生指标”的口径。
2. 调度器测试：
   - `server/tests/ruleEngineDispatcher.test.js` 覆盖不同 `targetLevel` 的缓存与过滤逻辑。
3. SQL 验证：
   - 对 `ad/adset/campaign` 三类查询分别执行 `EXPLAIN`。
   - 验收标准：`type=ALL` 出现次数为 `0`。
4. 性能验证：
   - 基准样本：`1` 个账户、`5000` 个 ad、`500` 个 adset、`100` 个 campaign、`50` 条启用规则。
   - 验收阈值：
     - 单条核心聚合 SQL `p95 <= 500 ms`
     - 单账户完整评估 `p95 <= 3000 ms`

### 6.6 [完成标准]

1. 同一条规则在 `ad/adset/campaign` 三层都能基于同层数据完成判断。
2. 聚合指标计算口径固定且有测试保护。
3. SQL 性能门禁有索引、有 `EXPLAIN`、有耗时记录。

## 7. 里程碑4：执行层同层化（状态动作 + pre-flight 信任门禁）

### 7.1 [目标]

- 让状态动作真正作用于 `ad/adset/campaign` 目标对象。
- 建立“状态源存在且新鲜才 pre-flight，否则 direct API fallback”的可信门禁。

### 7.2 [设计意图]

1. 状态动作本质上是**控制面操作**，必须与规则目标层一致。
2. 本地状态源如果不新鲜，pre-flight 就会把本应执行的动作错误跳过。
3. FB API 对 `already-in-state` 有容错能力，因此本地状态不可信时应优先保证执行正确性，而不是优先节流。

### 7.3 [修改范围]

- `server/index.js`
- `server/services/actionExecutorService.js`
- `server/services/cronService.js`
- `server/tests/preFlight.test.js`
- `server/tests/actionBatchSingleRule.test.js`
- 建议新增 `server/tests/actionExecutorStatusByLevel.test.js`

### 7.4 [具体执行步骤]

1. 在 `server/index.js` 的 `FacebookMarketingAPI` 中新增：
   - `pauseAdset(adsetId)`
   - `activateAdset(adsetId)`
   - `pauseCampaign(campaignId)`
   - `activateCampaign(campaignId)`
2. 在 `server/services/actionExecutorService.js` 中基于 `M1` 的解释层实现状态动作分发：
   - `ad -> pauseAd / activateAd`
   - `adset -> pauseAdset / activateAdset`
   - `campaign -> pauseCampaign / activateCampaign`
3. 新增 pre-flight 状态读取函数，按层查询：
   - `ad` 读 `ad_snapshots.status`
   - `adset` 读 `structure_adsets.effective_status`
   - `campaign` 读 `structure_campaigns.effective_status`
4. 新增新鲜度判断：
   - 统一读取 `structure_sync_status.last_heartbeat_data_update_at`
   - 阈值固定 `30` 分钟
5. pre-flight 决策逻辑固定为：
   - 有状态且新鲜 -> 执行 pre-flight
   - 状态缺失或超过 `30` 分钟 -> `direct_api_fallback`
6. ad 状态动作的 Batch 逻辑可以保留；adset/campaign 本阶段允许先走串行执行。
7. 预算动作保持原逻辑，不改 ABO/CBO 路由，不把预算路径混入这次状态动作改造。
8. 调度层 `server/services/cronService.js` 要把传入执行层的对象结构升级为通用目标对象，而不是默认 `matchedAd`。

### 7.5 [验证与测试]

1. 单元测试：
   - `server/tests/preFlight.test.js` 覆盖“状态新鲜”和“状态过期”两类分支。
   - 新增 `server/tests/actionExecutorStatusByLevel.test.js`，覆盖三层状态动作分发。
2. 回归测试：
   - `server/tests/actionBatchSingleRule.test.js` 确认 ad 批量状态动作能力不回退。
3. 人工验证：
   - 分别创建 `ad/adset/campaign` 三层 pause/activate 规则。
   - 分别验证 fresh / stale 两类 `last_heartbeat_data_update_at` 场景。
4. 结果验证：
   - stale 场景必须进入 `direct_api_fallback`，不能因为本地旧状态被误判为“无需执行”。

### 7.6 [完成标准]

1. 三层状态动作都能正确发往对应 API 目标。
2. pre-flight 只在可信状态源上运行。
3. 预算动作行为与改造前完全一致。

## 8. 里程碑5：可观测性与兼容读路径（日志 + 冷却键）

### 8.1 [目标]

- 让审计日志与冷却键都准确表达真实目标对象。
- 同时保留旧字段读路径，保证现有日志页不失效。

### 8.2 [设计意图]

1. 若日志仍写 `ad_id/ad_name`，上线后 adset/campaign 动作会被错误记录成广告动作。
2. 冷却键若仍统一写 `ad:*`，同层闭环会退化成错误的冷却粒度。
3. 新旧字段双写是最稳妥的过渡方式，能兼顾上线安全与查询兼容。

### 8.3 [修改范围]

- `server/db/schema.js`
- `server/db/migrations`
- `server/services/actionExecutorService.js`
- `server/services/ruleExecutionStateService.js`
- `server/services/cronService.js`
- `server/routes/system.js`
- `src/utils/ruleAuditNarrative.js`
- `src/views/RuleManager.vue`

### 8.4 [具体执行步骤]

1. 新建 migration，例如 `046_add_generic_object_fields_to_automation_logs.sql`：
   - 增加 `object_type`
   - 增加 `object_id`
   - 增加 `object_name`
   - 增加 `preflight_mode`
2. 更新 `server/db/schema.js`，为 `automation_logs` 建立对应字段定义。
3. 改造 `server/services/actionExecutorService.js` 日志写入逻辑：
   - 新字段写真实目标对象。
   - 旧 `adId/adName` 保留兼容写入。
   - 当目标层不是 `ad` 时，旧字段可回填“关联 ad”或留空，但必须在文档中统一规则；推荐保留兼容值并以新字段为准。
4. 冷却键统一改造：
   - 状态动作改为 `status_ad:*`
   - 状态动作改为 `status_adset:*`
   - 状态动作改为 `status_campaign:*`
   - 预算动作继续使用 `budget_adset:*`、`budget_campaign:*`
5. `server/services/cronService.js` 与 `server/services/ruleExecutionStateService.js` 同步适配新冷却键前缀。
6. `server/routes/system.js` 列表页与详情页读路径改为：
   - 优先读 `object_type/object_id/object_name`
   - 若为空，再回退到 `ad_id/ad_name`
7. `src/utils/ruleAuditNarrative.js` 与 `src/views/RuleManager.vue` 同步展示真实对象层级与对象名称。

### 8.5 [验证与测试]

1. 审计接口测试：
   - 查询 `GET /api/automation-logs`
   - 查询 `GET /api/automation-logs/:id`
   - 期望优先返回通用对象字段。
2. 单元/集成测试：
   - 建议新增 `server/tests/systemAutomationLogs.test.js`
   - 覆盖“新字段存在”和“仅旧字段存在”两种返回路径。
3. 冷却验证：
   - 同一规则对同一 `campaign` 执行后，冷却记录必须落在 `status_campaign:{id}`。
   - 不得再落在 `ad:{id}`。
4. 人工验收：
   - 日志列表页与详情页可以正确展示 adset/campaign 执行记录。

### 8.6 [完成标准]

1. 审计日志准确记录真实对象。
2. 冷却粒度与目标层级一致。
3. 历史日志页与旧查询路径不因新字段上线而失效。

## 9. 全局测试矩阵

### 9.1 [自动化测试]

1. `npm test`
2. `npm run build`
3. 重点关注测试文件：
   - `server/tests/rules.test.js`
   - `server/tests/templateValidator.test.js`
   - `server/tests/dynamicScopeService.helpers.test.js`
   - `server/tests/ruleDataService.test.js`
   - `server/tests/ruleEngineDispatcher.test.js`
   - `server/tests/preFlight.test.js`
   - `server/tests/actionBatchSingleRule.test.js`

### 9.2 [手工测试]

1. `ad/adset/campaign` 三层 pause/activate 规则各验证一轮。
2. `last_heartbeat_data_update_at` 新鲜与过期各验证一轮。
3. 动态筛选快照写入三层对象。
4. 审计日志展示真实对象层级。
5. ABO/CBO 预算行为保持不变。

### 9.3 [性能测试]

1. 输出 `ad/adset/campaign` 三份 `EXPLAIN` 报告。
2. 输出一份本地压测报告：
   - `1` 个账户
   - `5000` 个 ad
   - `500` 个 adset
   - `100` 个 campaign
   - `50` 条规则

## 10. auto 执行注意事项

### 10.1 [开发边界]

1. 禁止一次性把 `actions.type` 改成新枚举。
2. 禁止把预算动作和状态动作混在同一条改造链里一起重写。
3. 禁止在 `M2` 未完成前直接改 `M4` 执行层主路径。

### 10.2 [推荐执行顺序]

1. 先完成 `M1` 并提交。
2. 再完成 `M2` 与 migration 并提交。
3. 再完成 `M3` 与索引、`EXPLAIN` 验证。
4. 再完成 `M4` 执行链。
5. 最后完成 `M5` 审计与冷却兼容。

### 10.3 [最终交付物]

1. 设计与实施文档
2. migration 与索引说明
3. 单测与集成测试改动
4. `EXPLAIN` 报告
5. 压测报告
6. 灰度与回滚手册
