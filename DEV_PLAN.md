# FB Ad-Intelligence Server 开发计划（DEV_PLAN）

> 本文档用于给 Cursor/开发者一个「从现在到 V2.0 极致落地版」的执行路线图。  
> 配套的任务拆解见：`TASKS.md`。

---

## 1. 项目背景与目标

- 项目定位：本地运行的 Facebook Marketing API 智能监控与自动化规则系统，将演进为「服务端决策中枢」，支持 7x24 小时无人值守、多账户隔离、可审计执行日志。
- 当前基础：
  - 前端：Vue 3 + Pinia + Vite，已实现多层级监控视图、账户切换、基础 UI/UX。
  - 后端：Express + MySQL + node-cron，已实现多用户认证/授权、基础监控 API。
  - 测试：Vitest + Supertest 已规划并部分落地。
- 深度优化目标（来自《自动化优化方案》）：
  - 建立稳定、可扩展的数据采集与频率控制层。
  - 构建具备时区意识、复合逻辑的规则配置层。
  - 引入带优先级和安全护栏的动作执行层。
  - 完成有审计与机器人通知的反馈与监控层。

---

## 2. 当前阶段与演进路线对齐

结合 README.md 的 Phase 划分与《自动化优化方案》：

- Phase 1：稳定性与透明化 —— ✅ 已完成，用于支撑后续迭代。
- Phase 2：多用户隔离架构 —— ✅ 已完成，规则应继续遵守 owner 维度隔离。
- Phase 3：规则重心下沉与 7x24h 自动化 —— 🔄 进行中（约 88%），是本计划的主要施工范围。
  - ✅ 数据架构层（M2）：已完成（约 98%）
  - ✅ 规则配置层（M3）：已完成并进入多账户闭环阶段（约 95%）
  - 🔄 动作执行层（M4）：核心链路已通并完成动态筛选执行一致性（约 70%）
  - 🔄 反馈与监控层（M5）：基础审计与动态刷新观测已具备（约 20%）
- Phase 4：前端布局优化 —— ✅ 已完成，可在后续做小幅改进。
- Phase 5：审计、模拟与安全实战 —— ⏳ 规划中，对应《自动化优化方案》的第 4 部分。

**最新进度（2026-03-07）**：
- ✅ **动态筛选多账户闭环（M3.5 + M4.x）**：依据 `.cursor/plans/多账户动态筛选闭环_51336d09.plan.md`。① DynamicScope 策略 B 修复：`ERROR_OVERSIZE` 不清空旧快照，仅 `NORMAL` 规则按 `rule_id + account_id` 原子替换；② 单条执行路径与调度路径统一到 Dispatcher，`executeSingleRule` 改走 `loadDataForAccount + evaluateRuleWithCache`，确保 `use_dynamic_scope=1` 时严格按 `rule_matched_objects(rule_id, account_id)` 取目标；③ 前端 RuleManager 打通动态开关（默认开）、上限、状态、手动重算、排除名单配置/回显/摘要；④ TriggerB/TriggerC 升级为多账户语义：保存规则后按规则涉及账户逐个防抖刷新，TriggerC 传 `ruleId` 自动刷新全部目标账户并返回 `accountResults`；⑤ 修复 `targetIds=act_xxx:id` 在动态计算中的账户隔离解析，避免跨账户串值；⑥ 删除规则事务内联动清理 `rule_matched_objects`，避免孤儿快照；⑦ 补齐自动化测试（Dispatcher act:id 隔离、DynamicScope 多账户 helper、rules 删除联动清快照）并通过。手工验收覆盖 TriggerB/TriggerC 多账户、A 超限 B 正常、执行与快照一致，全部通过。
- ✅ **Track2 极速结构同步 + 全局 FB 限流 + 脏结构刷新**：依据 `.cursor/plans/fast-track-batch-sync-final_2a7a3666.plan.md`。① 在 `server/index.js` 中实现统一三边 Batch 内核 `unifiedStructureBatch(accountId, { sinceSec, limit })`，一次 Batch 请求同时拉取 `campaigns/adsets/ads` 三个 edge，正确解析双重转义 JSON body，并在子响应 code≠200 或 body.error 存在时记录含 message/code/subcode 的 warn 日志，对失败 edge 触发 Unix 秒 / ISO8601 回退重拉第一页，单 edge 修复不影响其它 edge 结果。② 在 `structureSyncService.js` 中新增 Track2 快速结构同步链路：`fastSyncStructureForAccount` 与 `collectFastSyncDataForAccount` 在账户级 MySQL 锁下调用 unified batch + 软分页补页（仅对返回 after 的 edge 调用 `getStructurePage` 继续拉，页数上限由 `maxSoftPagesPerEdge` 控制，默认 20，可通过 `TRACK2_FAST_SYNC_MAX_SOFT_PAGES` 调整），并将 `adsets/ads` 视为关键 edge，任一 edge 持续报错（含 FB 限流 `User request limit reached`）即整账户返回 `ok=false, reason='edge_failed'`，避免假成功。③ Track2 Cron 使用 `collectFastSyncDataForAccount` 收集白名单账户结果后，在 `applyMergedFastSyncPayload` 中按 `(account_id, object_id)` 去重合并，并对 `structure_campaigns/structure_adsets/structure_ads` 分别执行 chunked bulk upsert（默认块大小 300，可在 opts 中调节），返回本轮写入三表行数与被标记 dirty 的账户数；写库只对有变更的账户在 `structure_sync_status.fast_dirty` 上打标。④ 通过迁移 032/033 为 `structure_sync_status` 新增 `last_fast_sync_ts`、`last_fast_filter_since_sec` 与 `fast_dirty/fast_dirty_marked_at/fast_dirty_cleared_at` 列，Track2 每轮成功后无论是否有数据命中，都会用本轮使用的 `sinceSec` 推进专用水位，并仅对有变更的账户将 `fast_dirty` 置 1；规则调度入口 `executeRulesForAccount(fromScheduler=true)` 在账户锁内调用 `refreshStructureIfDirtyBeforeRules`，若 dirty 为 1 则先按最近 Fast Sync 水位刷新一次结构，成功后清空标记，失败则保留标记并打告警日志，从而实现「规则尽量使用最新结构，但失败不会阻塞执行」。⑤ `cronService.js` 新增 Track2 Fast Sync 定时任务，Cron 为 `7,27,52 * * * *`（每小时 3 次，避开 :45 热数据 Today 同步），账户列表来源为 account_mappings + 环境变量 `TRACK2_FAST_SYNC_ACCOUNT_IDS` 白名单，账户并发由 `TRACK2_FAST_SYNC_CONCURRENCY` 控制，窗口计算为 `sinceSec = max(last_fast_sync_sec - TRACK2_FAST_SYNC_BUFFER_SEC, now - 3d)`，当前 buffer=14400 秒（4 小时，已通过日志差值验证）；当 Token 熔断器 `getCircuitBreakerStatus().isLocked` 为 true 或最近 `getLastUsageRate() >= TRACK2_FAST_SYNC_USAGE_SKIP_THRESHOLD` 时，本轮 Track2 直接跳过。Track1 「结构轮转（近3天）」保持每小时 :12 跑最多 6 账户（账户并发 5），但可通过 `ENABLE_UNIFIED_STRUCTURE_BATCH/unifiedLimit/unifiedMaxSoftPages` 选择复用 unified batch 内核，形成「Track2 极速铺表 + Track1 每小时兜底轮转」双轨结构。⑥ 在 `FacebookMarketingAPI.makeRequest` 外围引入全局请求队列 `enqueueFacebookRequest({ priority, label, queueTimeoutMs }, taskFn)`，通过环境变量 `FB_GLOBAL_REQUEST_CONCURRENCY` 与 `FB_GLOBAL_QUEUE_TIMEOUT_MS` 统一限制发往 Facebook 的并发数和排队超时时间；所有 Today/Track1/Track2/规则动作请求都会按优先级 `action > today > track2 > cold` 入队，队列内部按优先级 + FIFO 调度任务到固定并发槽位，并在排队超时后返回明确错误避免客户端自身 timeout；对于 action 优先级请求，在实际执行前必打印 `[FBQueue] 开始执行` 日志，便于确认止损类请求不会在结构同步/冷任务压力下被饿死。

**本窗口执行方案（2026-03-09）**：依据 `.cursor/plans/fb-api-optimizations-v3_8fa0e467.plan.md`（FB API 三项关键优化落地方案 v3）。三项优化及实施顺序：① **优化二** Insights 热数据源头过滤（FB 端 spend>0 过滤、空结果健壮、本地兜底、`DISABLE_SPEND_FILTERING`）；② **优化一** 规则执行 Batch POST（分片≤50、预算去重合并与覆盖日志、`batchRequests` 顺序拼接、`ENABLE_ACTION_BATCH`）；③ **优化三** Track2 弱化伪增量（Track2 账户不跑伪增量）。实施顺序：先优化二 → 再优化一（分阶段）→ 最后优化三。任务拆解与勾选见 TASKS.md「本窗口执行方案」小节。

**最新进度（2026-03-11）**：① **方案「动态规则_ux_与列表性能优化」已闭环**：优化 A（[同步] 按钮、syncJustDoneMessage、syncConfigFromMatch）与优化 B（GET /api/rules 附带 matched_count、规则卡片「当前生效 N 个对象」）已落地并验收。② **编辑弹窗 targetIds 与详情一致**：打开编辑时对动态规则拉取 GET /api/rules/:id 后，用接口返回的 target_ids 覆盖 ruleForm.targetIds 并调用 resolveSelectedTargetIds，避免「规则配置共 M 个」滞后于「当前匹配 N 个」。③ **重算时清理多余账户快照**：`refreshDynamicTargetsForRule` 在按当前 target_account_ids 刷新各账户后，执行 `DELETE FROM rule_matched_objects WHERE rule_id = ? AND account_id NOT IN (当前账户列表)`，避免目标账户缩小后 matched_count 虚高。④ 抽取 `resolveSelectedTargetIds(rawIds)` 复用。窗口总结见 `项目开发过程/项目总结-2026-03-11-动态规则UX与快照一致性修复.md`。

**本窗口补充进度（2026-03-09）**：
- ✅ 已完成优化二（Insights 源头过滤）：`getAdInsights` / `syncAccountTodayStats` / `fetchInsightsInBatches` 已接入 spend>0 filtering，保留本地兜底与 `DISABLE_SPEND_FILTERING` 开关，空结果健壮性已补齐。
- ✅ 已完成优化一（动作 Batch 主链路）：`FacebookMarketingAPI.batchRequests`（分片<=50、双 JSON 解析、顺序拼接）已落地；调度执行链路状态动作支持 `actions_batch`；`PendingAction` 收集、预算去重合并与 `budget_merge` 可观测日志已落地；`ENABLE_ACTION_BATCH` 开关生效。
- ✅ 已完成优化三（Track2 弱化伪增量）：`unifiedHeartbeatSync` 已按 `ENABLE_TRACK2_FAST_SYNC` 与 `TRACK2_FAST_SYNC_ACCOUNT_IDS` 判断 Track2 覆盖账户，仅对非 Track2 账户执行伪增量，并输出总账户/Track2/伪增量统计日志。

**最新进度（2026-03-04）**：
- ✅ **时区统一与执行日志显示**：① **连接池统一**：`server/db/drizzle.js` 改为复用 `server/db/connection.js` 的 pool（Single Source of Truth），不再自建 pool，确保 Drizzle 写入 `automation_logs.triggered_at` 与列表接口读取使用同一套「SET time_zone = UTC」连接。② **mysql2 时区选项**：`connection.js` 的 createPool 增加 `timezone: '+00:00'`，与已有会话 `SET time_zone = '+00:00'` 配合，避免驱动在 Date ↔ 字符串转换时按本地时区导致 8 小时偏差。③ **API 与前端**：执行日志列表/详情用 `toUTCISO()` 统一返回 `triggered_at`/`created_at` 为带 Z 的 UTC ISO；前端 `parseUTC` 对无 Z 字符串补 Z 后按 UTC 转北京展示。④ **冷却日志**：`ruleExecutionStateService.isCooldownDue` 的 debug 日志同时输出 `lastAtUtc` 与 `lastAtBj`（北京时间）。⑤ **文档**：`docs/0时区转换解决方案.md` 补充已落地规范与 SQL 说明（北京会话下勿对 `triggered_at` 再做 CONVERT_TZ）。验收：执行日志前端时间与本地北京时间一致；SQL 与前端一致。历史数据未迁移。本窗口总结见 `项目开发过程/项目总结-2026-03-04-时区统一与执行日志及连接池.md`。
- ✅ **预算动作护栏与前端精简**：依据 `.cursor/plans/budget-guardrail-ui-and-cooldown_c1b0010a.plan.md`。① **预算上下限校验**：`server/utils/templateValidator.js` 为预算动作新增 `min_daily_budget` 字段支持，并限定 increase 仅允许 `max_daily_budget`、decrease 仅允许 `min_daily_budget`、set_budget 禁止上下限，且上下限须为整数分且 `>=100`。② **预算语义收紧**：`computeNewBudgetCentsOnce` 将 increase/decrease/set_budget 语义固化为「超上限/在下限不动、执行后封顶/托底、set_budget 仅上调不下调」，与 MIN_BUDGET_CENTS 统一。③ **Pre-Flight 跳过原因细分**：执行层在 `currentCents === newBudgetCents` 时，根据当前与护栏位置输出 `above_max_cap` / `below_min_floor` / `budget_already_at_target` 三类 skip_reason，审计日志与 API 响应均带 reason，便于排查。④ **前端 RuleManager/AdminTemplates 精简**：规则页与管理员模板页的动作编辑 UI 仅在 increase 时显示「预算上限」、在 decrease 时显示「预算下限」、在 set_budget 时隐藏上下限输入；动作切换时自动清理无关字段，保存时仅对 increase 透传 max_daily_budget，对 decrease 透传 min_daily_budget，set_budget 不再透传上下限字段。⑤ **测试补齐**：`budgetUnitCents.test.js` 与 `templateValidator.test.js` 补齐预算护栏用例，新增 `budgetPreFlightReason.test.js` 验证三类预算 Pre-Flight 跳过原因。
- ⏳ **下一窗口建议**：Step 4 体验与完整性、4.2 IM 机器人；可选：历史执行日志/冷却表时区迁移（老数据减 8 小时转 UTC 语义）。

**此前进度（2026-03-02）**：
- ✅ **ROAS 一律用本地计算**：`server/services/ruleDataService.js` 的 `calculateSingleDayMetrics` 中单日 ROAS 改为仅用 `purchase_value/spend` 计算（spend=0→null；有花费无转化→0），**不再使用** DB/Facebook 的 roas 字段兜底，与多日 `aggregateMultiDayMetrics` 口径一致。规则条件判断完全依据自有数据，避免 FB roas 为空或口径差异导致误判。
- ✅ **验证**：提供并修正验证 SQL（单日/多日 ROAS、时区、automation_logs；MySQL 子查询去掉 LIMIT）；用户执行后确认单日/多日 our_roas 正确、规则 461 Pre-Flight skipped 行为符合预期。
- ✅ **预算冷却与 Pre-Flight 重构（budget-cooldown-and-prefight）**：依据 `.cursor/plans/budget-cooldown-and-prefight-refactor_e251157f.plan.md`。① **数据层**：迁移 031 为 `rule_ad_execution_state` 增加 `scope_key`，主键改为 (rule_id, scope_key)，ad_id 保留诊断；② **ruleExecutionStateService**：抽离 loadRuleAdExecutionState、isCooldownDue、upsertRuleAdExecutionStateBatch；③ **actionExecutorService**：pause/activate 用 cooldownKey=ad:，预算 ABO/CBO 用 budget_adset:/budget_campaign:，当前预算=目标预算时 Pre-Flight 记为 skipped 不调 FB，results 中返回 cooldownKey；④ **cronService 双写**：写冷却表时除按 cooldownKey 写入外，若 cooldownKey≠ad: 则再写入一条 ad:${adId}，使调度层「广告级冷却」过滤对预算动作生效（修改前只写 budget_*，Cron 按 ad: 过滤查不到，导致冷却期内每分钟仍执行）。验收：冷却表可见同一 rule_id 下 budget_* 与 ad: 两条；15 分钟内 Cron 不再重复执行。可选待办：单元/集成测试；执行层 isCooldownDue 对手动执行是否遵守冷却。
- ⏳ **下一窗口建议**：Step 4 体验与完整性、4.2 IM 机器人；可选：将 ROAS 统一口径写入文档或 RuleManager 提示。

**说明**：开发过程中若出现 `echo noop` 等 Shell 输出，为工具误调用产生的空操作，未连 MySQL、未改任何代码或文件；SQL 与执行命令由用户自行运行，代码修改仅通过文件读写工具完成。

**此前进度（2026-02-28）**：
- ✅ **执行频率与执行时间 适配方案七阶段全部完成**：依据 `docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md`。① 迁移与 Schema（rules 新字段 + rule_ad_execution_state 表，迁移 027/028）；② 心跳中移除规则触发（unifiedHeartbeatSync 不再调 executeRulesForAccount）；③ Cron 每分钟调度 + executeRulesForAccount 改造（fromScheduler 时读写冷却表、广告级间隔与执行时间段）；④ 执行时间段 isInExecutionWindow + 摘要 outside_execution_window；⑤ 移除 Smart Mute 执行路径（保留 mute_until/mute_reason 与 clear-ad-mute.js）；⑥ 移除 execute-all 与「立即运行所有规则」（保留单条 POST /api/rules/:id/execute）；⑦ API 与前端（执行频率/时间段配置、列表展示「执行频率」「执行时间」、单条执行保留）。前端修复：RuleManager normalizeRule 补全 executionIntervalMinutes/executionTimeWindows，解决保存后再编辑回显默认值问题。规则更新使用 **PUT /api/rules/:id**（不支持 PATCH 更新规则体）。教学文档：`docs/阶段五与阶段六_知识点与教学说明.md`。开发过程总结见 `项目开发过程/项目总结-2026-02-28-执行频率与执行时间方案完成与窗口总结.md`。
- ✅ **结构同步近 3 天改造与定时/前端（同日本窗口）**：依据 `docs/0结构同步任务改造—执行方案.md`。① getStructurePage 映射 created_time；② syncAccountStructureAds 改为只拉 updated_time >= 3 天前（Unix 秒 + 单 edge 报错回退 ISO）；③ structure_sync_status 增加 last_filter_since_sec（迁移 030）；④ 轮转命名/日志统一「近3天」；⑤ Cron 改为 5,35,55 * * * *、每次 5 账户；⑥ 前端「刷新列表」仅单选一个广告账户时可点击。验收见 `docs/结构同步近3天_测试与验证指南.md`。开发过程总结见 `项目开发过程/项目总结-2026-02-28-结构同步近3天与定时前端.md`。
- ✅ **监控范围条件「创建时间段」已落地并验证（本对话窗口）**：依据 `docs/0监控范围条件[创建时间段]—执行方案.md`。后端 structureSyncService 三 list + listStructureObjectsFromDb 支持 scope_created_within_hours；index.js 结构列表路由透传；前端 facebookApi 与 RuleManager 字段/值/校验/列表带参、多行取 min 小时；`docs/监控范围条件_后端SQL过滤与优先展示方案.md` 已更新。用户验证（名称包含 0227 + 近 24 小时内）与 SQL 核对通过。开发过程总结见 `项目开发过程/项目总结-2026-02-28-监控范围条件创建时间段完成.md`。
- ⏳ **下一窗口建议（按优先级）**：
  1. **Step 4 体验与完整性**：结构增量/定时同步、选择器优化；多账户「应用监控范围」拉全量时的加载提示或分页策略（可选）。
  2. **4.2 IM 机器人**：钉钉/飞书通知、60 秒聚合、Token 熔断/同步异常等告警接入。
  3. 可选：测试覆盖率 60%→80%；TLS/代理日志噪音优化（200 OK 后仍打 TLS 错误的可观测性优化）；按 `docs/采纳项验证与测试指南.md` 做回归。

**此前进度（2026-02-27）**：
- ✅ 采纳项 §2.5.3 已全部落地并验收通过；结构镜像三张表新增 created_time（迁移 029）；本窗口新增文档见 `docs/采纳项落地_知识点与教学说明.md`、`docs/采纳项验证与测试指南.md`、`docs/下一步与可选完善.md`。开发过程总结见 `项目开发过程/项目总结-2026-02-27-采纳项落地验收与教学及下一步.md`。

**此前进度（2026-02-24）**：
- ✅ **采纳清单与监控范围完善（文档定稿）**：多账户 multi、状态不等于、名称类大表等具体改法见 `docs/采纳清单与具体修改说明.md`；实现与验收在本窗口（2026-02-26/27）完成。

**此前进度（2026-02-14）**：
- ✅ **多账户规则 target_by_account 优化**：evaluateRule 当当前 accountId 不在 target_by_account 时设 targetAdIds=[] 不查全量；getRuleAccountIds/ruleAppliesToAccount 仅对「value 为非空数组」的账户执行；GET /api/structure/objects/multi 响应 meta 增加 per_account_limit、has_more；前端 refreshScopeItems 移除不在 scope 的 targetIds。详见 `项目开发过程/项目总结-2026-02-14-多账户target_by_account优化与ThunderClient验证.md`。
- ✅ **Thunder Client 小白验证步骤**：`docs/Thunder_Client_小白验证步骤.md`（登录→objects/multi 带 token 与 Query→检查 meta）；验证通过。
- ⏳ **下一窗口建议（按优先级）**：
  1. **Step 4 体验与完整性**：结构增量/定时同步、选择器优化等剩余项；可选将 RuleManager 选择器迁到 getStructureObjectsUnified。
  2. **4.2 IM 机器人**：钉钉/飞书通知、60 秒聚合、告警接入。
  3. 回归：规则执行（含 campaign/adset、多账户 target_by_account）、结构列表筛选、统一接口与旧接口并存。

**此前进度（2026-02-13）**：
- ✅ campaign/adset 维度补齐、规则目标解析改造、前端状态筛选、结构索引方案 B。详见 `项目开发过程/项目总结-2026-02-13-campaign_adset补齐与规则目标解析及结构统一接口.md`。

**此前进度（2026-02-12）**：
- ✅ 广告系列与 CBO 及 daily_stats campaign_id；自定义模板页面 UI 优化；TASKS 文档同步；归档口径与回退对齐；推荐顺序 Step 0～3 已全部验收完成。详见 `项目开发过程/项目总结-2026-02-12-*.md`

**此前进度（2026-02-11）**：
- ✅ 预算 GET 单位修复 + 2.3.1 收尾；Route 1 字段补齐（purchase_value 根因）；ROAS 方案 A 落地；RuleEngineDispatcher（§2.4）落地。详见 `项目开发过程/项目总结-2026-02-11-*.md`

**此前进度（2026-02-10）**：
- ✅ Winston 应用日志已落地：统一 logger、双写、关键模块替换为 logger。详见 `项目开发过程/项目总结-2026-02-10-Winston应用日志与双写及关键模块替换.md`

**此前进度（2026-02-07）**：
- ✅ 2.3 DNF 集成验收、3 模板 v2；代理瞬态重试 + CONCURRENT_LIMIT=6；resolve 回显、刷新列表已落地。详见 `项目开发过程/项目总结-2026-02-07-DNF集成验收与3模板v2及代理重试.md`

**此前进度（2026-02-05 / 2026-02-04 / 2026-02-02 / 2026-01-27 / 2026-01-30）**：
- ✅ 顺序2 伪增量 + Piggyback + 每小时全量轮转已落地并验证通过（8 项验收打勾）；2.2 选择器查库（GET /api/structure/ads 查 structure_ads）、2.1/2.4 已验收
- ✅ 规则管理功能完整实现、规则执行框架（AdsPolar、账户级锁、冷却期）、数据清洗与归档口径；M4 Vitest 验证与历史测试修复（94 用例通过）

**本 DEV_PLAN 的重点：**

- 将 Phase 3 + Phase 5 和《自动化优化方案》的 4 个层级，合并为一套可执行的开发路线。

---

## 3. 大里程碑（Milestones）

### M1：后端架构与测试骨架校准（复盘/补齐）

- 确认已完成：
  - `server/app.js` 与 `server/server.js` 架构分离。
  - `vitest.config.js` 已配置，基础健康检查测试通过。
- 如有缺口：
  - 按 README 中的实施指南补齐，确保：
    - 所有路由挂载在 `app.js`。
    - `server.js` 仅负责 `app.listen` 和定时任务启动。
    - `npm test` 可以在不占用端口的前提下跑通。

### M2：数据架构层（Data Ingestor + 精度/频率控制）

落地《自动化优化方案》的「一、数据架构层」：

- 引入 Data Ingestor 服务（批量拉取 + 双缓冲）。
- 接入 Facebook Batch API，按 20 条子请求分组。
- 实现 API 频率自适应与超时自愈机制。
- 保证 ID 精度、滑动窗口回溯、冷热数据分层。
- **数据清洗逻辑**（2026-01-27 完成）：在写入队列中过滤 spend=0 且 impressions=0 的僵尸数据，减少热表空间占用。实现位置：`server/services/ingestorService.js` 第1616-1637行。
- **归档查询口径修正**（2026-01-27 完成）：归档查询使用 data_date 而非 synced_at，确保按账户时区的自然日进行归档，避免时区差异导致的数据查询错误。实现位置：`server/services/ingestorService.js` 第2121行。
- **验证工具与文档**（2026-01-27 完成）：创建验证脚本（`test-verify-sync.js`、`test-verify-archive.js`）和文档（`验证执行步骤.md`、`验证SQL查询.sql`、`下一个窗口验证和测试清单.md`），支持系统化验证数据架构层功能。
- **Route 1 字段完整性**（2026-02-11 完成）：Today 心跳走 Insights First 路径时，`server/index.js` 的 `getAdInsights()` 必须请求 action_values、purchase_roas、website_purchase_roas 等 ROI 核心字段，否则 purchase_value 必为 0、规则 roas 判定失效。已补齐 fullFields 与 fallbackFields，mapItem 透传。

### M3：规则配置层（Rule Engine 配置与时区对齐）

落地「二、规则配置层」：

- 规则模型包含：目标对象、条件数组（AND/OR）、时间窗口、账户时区。
- 新增动态筛选模型：`use_dynamic_scope`、`scope_filters`、`exclude_ids`、`max_dynamic_matches`、`dynamic_scope_status`，并通过 `rule_matched_objects(rule_id, account_id)` 承载预计算快照。
- 支持 Today / Yesterday / Last 3 Days / 累计至今。
- **对象与状态口径**：前端选择器默认按 ACTIVE/PAUSED（基于 effective_status）过滤；规则执行前用本地 `ad_snapshots.status` 做 Pre-Flight（目标已达成则 skipped），不新增 per-ad GET；FB 返回「already in that state」类错误容错为 skipped/success。
- **比值类指标与规则比较语义**：cpc/ucpc/cpa/roas 在分母为 0 时为 null（不可比较）；规则比较时 null 与数值比较结果为 false；「坏 vs 空」口径见 **5.2.1 指标口径与规则引擎比较语义**。
- 提供 JSON 模板化 SOP 与前端免责提示。

### M4：动作执行层（冲突仲裁与安全护栏）

落地「三、动作执行层」：

- 实现动作优先级体系（暂停 > 降预算 > 加预算等）。
- 同一广告同一轮扫描只执行优先级最高的动作。
- 单条执行与调度执行统一 Dispatcher 口径；当 `use_dynamic_scope=1` 时均按每账户快照读取目标，保证执行与动态筛选快照一致。
- 支持 Smart Mute（手动/自动挂起），预算上限护栏。
- 引入 Pre-Flight Check 和重试策略。
- **动作下发与审计硬口径**：pause_ad 在非 Dry Run 下必须真实调用 FB API（POST），并在 automation_logs 记录 status=success/fail/skipped、skip_reason、is_simulation 等可复盘字段；验收以 FB 后台广告状态变为 PAUSED 为准。Pre-Flight 仅用本地 status + FB 返回 already-state 容错，不新增 per-ad GET。

### M5：反馈与监控层（审计日志 + IM 机器人 + 健康看板）

落地「四、反馈与监控层」 + README Phase 5：

- 建立 `automation_logs` 审计日志表。
- 支持 Dry Run 模式：只记日志不下发 API。
- 对接 IM 机器人（钉钉/飞书 Webhook），实现聚合报警。
- 实现系统健康看板的后端 API（前端可后续接入）。

### M5.1 应用日志与轮转（补充）

- 选型与策略：winston + winston-daily-rotate-file（文件 JSON 格式；开发环境 console 彩色输出；生产写文件）
- 文件与分级：combined-YYYY-MM-DD.log（info）、error-YYYY-MM-DD.log（error）、exceptions-YYYY-MM-DD.log（未捕获异常）、rejections-YYYY-MM-DD.log（未处理拒绝）
- 轮转与保留：按天切割；保留最近 14 天（可开启压缩）
- 安全与合规：生产不打印 Token 前缀；必要字段脱敏
- 接入范围：服务启动、cron、ingestor、频率与自愈、API 路由、规则执行入口
- 验收：日志文件按日期生成且分级；异常与拒绝可追踪；14 天保留策略生效；频率过载与熔断事件产生日志并可检索

---

## 4. 数据架构层设计（M2）

### 4.1 数据表与字段（MySQL + Drizzle）

围绕以下核心概念设计/补齐数据表（推荐使用 Drizzle ORM）：

- `ad_snapshots`（热数据：Today）
  - 主键：`id`（自增或雪花）；包含自然日字段 `data_date`(DATE)
  - 索引：唯一索引 `uk_account_ad_date(account_id, ad_id, data_date)`（保证每个账户+广告+自然日仅一行），`sync_session_id` 普通索引
  - 字段说明：
    - 基本信息：`account_id`(VARCHAR)、`ad_id`(VARCHAR)、`ad_name`、`status`(VARCHAR)、`owner_id`
    - 指标（今日快照入库，严格围绕 10 个字段与其所需原始计数）：
      - 十个核心字段（全部写入今日快照）：
        1. `status`：广告当前投放状态（ACTIVE/PAUSED 等）
        2. `spend`：花费（美元）
        3. `purchases`：购买次数（从 `actions` 精确提取 `offsite_conversion.fb_pixel_purchase`）
        4. `cpa`：单次购买成本（今日口径：实时计算 `spend / purchases`，当 `purchases=0` 时记为 `null`）
        5. `roas`：广告支出回报率（今日口径：优先从 `purchase_roas` 数组提取；降级从 `website_purchase_roas` 提取；兜底按 `purchase_value / spend` 计算）
        6. `cpc`：单次链接点击费用（今日口径：直接存 API `cpc`）
        7. `ucpc`：独立单次链接点击费用（今日口径：`cost_per_unique_link_click` 或 `cost_per_unique_inline_link_click`）
        8. `add_to_cart_cost`：加购费（今日口径：从 `cost_per_action_type` 提取）
        9. `checkout_cost`：结账费（今日口径：从 `cost_per_action_type` 提取）
        10. `payment_cost`：支付费（今日口径：从 `cost_per_action_type` 提取）
      - 为区间计算必需的原始计数字段（今日同时入库）：
        - `link_clicks`：从 `inline_link_clicks` 获取
        - `unique_link_clicks`：从 `unique_inline_link_clicks` 获取
        - `purchase_value`：从 `action_values` 中提取购买总金额
        - `add_to_cart_count`、`initiate_checkout_count`、`add_payment_info_count`：从 `actions` 提取
      - 原文与上下文：
        - `actions`(JSON)：所有动作数据（用于解析 counts 与 purchases）
        - `action_values`(JSON)：动作金额（用于解析 `purchase_value`）
    - 元信息：`data_date`(DATE)、`sync_session_id`(VARCHAR)、`synced_at`(DATETIME)、`timezone_name`(VARCHAR)
    - 自动化相关：`mute_until`(DATETIME)、`mute_reason`(VARCHAR)、`is_simulation`(BOOL 可选)
  - 热表清理：通过每日定时任务（建议账户本地时间 04:00 左右）删除 2 天前的旧快照，仅保留最近 2 天数据用于真空期兜底与问题排查。
- `daily_stats`（冷数据：历史快照）
  - 主键：`id`
  - 索引：`account_id + date`、`ad_id + date`
  - 字段：同上但聚合为「自然日」粒度；包括：
    - 累加型与原始计数（当日总量）：`spend`、`purchases`、`link_clicks`、`unique_link_clicks`、`purchase_value`、`add_to_cart_count`、`initiate_checkout_count`、`add_payment_info_count`
    - 十个核心字段的单日比值/成本类（单日直接入库 API 值，API 缺失则以原始计数兜底计算后入库）：`cpc`、`roas`、`ucpc`、`cpa`、`add_to_cart_cost`、`checkout_cost`、`payment_cost`
    - 结构化字段：`ad_set_id`、`actions`(JSON)、`timezone_name`
- `automation_logs`（执行审计）
  - 主键：`id`
  - 字段建议：
    - 关联：`account_id`、`ad_id`、`rule_id`、`owner_id`
    - 触发瞬时快照：`metrics_snapshot`(JSON)
    - 动作信息：`action_type`、`action_payload`(JSON)、`is_simulation`
    - API 原文：`api_request`(TEXT)、`api_response`(TEXT)
    - 状态：`status`(success/fail/skipped)、`error_message`
    - 时间：`triggered_at`(DATETIME)、`created_at`(DATETIME)
- `structure_ads`（结构镜像：广告清单/选择器数据源，0 次 FB 调用）
  - 存：ad_id、name、effective_status、层级 id、updated_time、**created_time**、last_synced_at
  - 不存：spend/roas 等指标
  - 用途：规则创建/编辑的指定对象选择器、名称搜索、分页、默认 ACTIVE/PAUSED 展示口径；created_time 供监控范围条件「创建时间段」后续扩展。
- 口径对齐：**ad_snapshots** = 热指标快照（且 Today 口径可只收 spend>0）；**structure_ads** = 结构与状态镜像（覆盖 0 花费广告，供选择器与状态展示）。结构镜像是「广告清单/选择器读库」用，与「热数据与广告的匹配」无关——热数据与广告的对应由 Insights 返回的 ad_id/ad_name 在写入 ad_snapshots 时已完成。

### 4.2 Data Ingestor 批量同步流程

- 入口：在后端（建议 `server/services/cronService.js` 或新建 `ingestorService.js`）提供：
  - `syncAccountTodayStats(accountId)`：同步单账户 Today 数据。
  - `syncAllAccountsTodayStats()`：同步当前系统内所有账户的 Today 数据。
  - **受控并发调度**：在统一心跳任务内，同步所有账户的 Today 数据时，要对账户列表采用受控并发调度：
    - 限制同一时刻并发运行的账户同步任务数量为 6。
    - 可以使用 `p-limit(6)` 或自实现并发池。
    - 避免"纯串行"或"一次性全并发"。
- 20-Batch 聚合：
  - 从待同步广告列表中，使用 `lodash.chunk`（或自实现）按 20 个一组切分。
  - 按 FB Batch API 规范，构造一个包含 20 个子请求的批处理请求。
- 字段与归因对齐：
  - 请求字段显式包含（只围绕 10 个字段与其计算所需的原始计数）：`ad_id, ad_name, adset_id, spend, cpc, roas, actions, action_values, cost_per_action_type, cost_per_unique_link_click, cost_per_unique_inline_link_click, inline_link_clicks, unique_inline_link_clicks`。
  - 今日快照：上述字段全部写入 `ad_snapshots`；其中 `cpa` 今日按 `spend/purchases` 计算后入库
  - 请求中强制 `use_account_attribution_setting=true`。
- 原子化同步会话：
  - 每次同步生成唯一 `sync_session_id`（时间戳 + 随机串）。
  - 同步时写入 `ad_snapshots`，同时标记 `sync_session_id`。
  - 规则引擎只处理「上一个完整批次」的数据：
    - 当前批次写入结束后，更新某个 `sync_sessions` 状态或在代码中维护「latest_complete_sessionId」。

### 4.3 API 频率与自愈机制

- 频率控制：
  - 解析响应头 `x-business-use-case-usage`。
  - 若能 parse 成 JSON，则根据占用率分三档：
    - < 50%：`sleep(500ms)`
    - 50%–85%：`sleep(2000ms)`
    - > 85%：`sleep(10000ms)` 且记录警报（发送到机器人）。
- **受控并发（Throttled Concurrency）**：
  - 在所有"按账户遍历 + 调用 Facebook API"的任务中：
    - Today 热同步
    - 冷路径双窗口归档
    - last_7d / last_14d 回补
  - 都要统一限制"同一时间并发运行的账户任务数量 = 6"。
  - 建议使用 `p-limit(6)` 或等价并发池，在统一心跳内调度账户任务。
  - 受控并发 + Header 自适应休眠是一起工作的：
    - 使用率高时，可以通过延长 sleep 或临时降低并发度继续保护配额。
- 日志与告警接入（补充）：
  - 在占用率高与熔断触发时写入 warn/error 级日志；将告警事件纳入"应用日志与轮转"的验收范围
- 超时保护：
  - 封装 `fetchWithTimeout`（或对 axios request 使用 `Promise.race`）：
    - 超时时间：45 秒。
    - 超时视为失败请求，不阻塞后续任务。
- Token 智能熔断：
  - 维护全局 `failureCount`（可存在内存或 Redis）。
  - 若连续 3 次收到错误码 190（Token 失效）：
    - 标记系统为 `isSystemLocked=true`。
    - 停止所有同步任务。
    - 发送高优先级报警（IM 机器人）。

### 4.4 精度与滑动窗口策略

- ID 精度保护：
  - 数据库中所有 ID 字段使用 `VARCHAR(50)`。
  - Node 端使用 `json-bigint` 或类似方案，将长整型 ID 始终解析为字符串。
- 滑动窗口回溯：
  - 同步范围：`Today + Past 7 Days`。
  - 使用 `ON DUPLICATE KEY UPDATE` 覆盖更新过去一周的数据。
  - 解决 FB 归因延迟导致的「迟到事件」。
- 热/冷数据分离：
  - 热数据（Today）：每 15 分钟统一心跳同步（用于规则触发），所有请求统一走 `UnifiedSyncJob` 入口，避免为 Today/Yesterday 分别起独立 Cron。
  - 冷数据（历史）：在统一心跳内每 15 分钟基于 `daily_archive_status` 任务注册表做巡检（Sliding Window / Trigger Threshold），按账户时区判断并执行双窗口归档：账户本地时间 ≥02:00 对 Yesterday 执行初步归档（将状态从 PENDING 标记为 ARCHIVED），账户本地时间 ≥12:00 对 Yesterday 执行深度对账覆盖（将 ARCHIVED 标记为 FINALIZED），错过可在后续心跳中补跑。
- 冷数据落盘口径（补充细化）：
  - 冷路径归档建议统一直接拉取 Facebook API 的 Yesterday 全天汇总包写入 `daily_stats`（UPSERT 覆盖写，最终一致）。
  - 展示层兜底：在冷归档未完成的真空期，可按账户时区降级到 `ad_snapshots` 的“昨日最后快照”（基于 `data_date = 昨日` 且 `synced_at` 最大的一行，尽力而为），无需额外 00:15 冷回溯任务。
  - 单日比值入库与迟到回补：
    - 昨日批量洞察：按 `date_preset=yesterday` 拉取 `cpc, roas, inline_link_clicks, unique_inline_link_clicks, actions, action_values, cost_per_action_type, cost_per_unique_link_click, cost_per_unique_inline_link_click`
      - 备注：此处用 `date_preset` 仅作为现阶段实现简化；中期优化以显式 `time_range(since/until)` 统一口径为目标，避免平台变更 `date_preset` 语义带来风险。
    - 与“最后快照”结果按 `ad_id` 合并，写入 `daily_stats` 的比值列与原始计数字段；比值类优先 API 值，缺失用原始计数兜底；`cpa` 按 `spend/purchases` 计算入库
    - 迟到归因回补：增加“近 7 天单日回补”任务，覆盖更新 `daily_stats` 的 `cpc/roas/ucpc/cpa/各成本` 与原始计数
  - 查询路由与聚合口径：
    - Today → `ad_snapshots`（直接读 API 值与今日原始计数）
    - 单日 → `daily_stats`（直接读日级比值列；原始计数直接读）
    - 多日区间 → `daily_stats`（仅用原始计数/金额加权计算比值，不做平均比值）
      - `cpc = SUM(spend) / SUM(link_clicks)`
      - `ucpc = SUM(spend) / SUM(unique_link_clicks)`
      - `cpa = SUM(spend) / SUM(purchases)`（区间统一按计算，不使用 cost_per_action_type）
      - `add_to_cart_cost = SUM(spend) / SUM(add_to_cart_count)`
      - `checkout_cost = SUM(spend) / SUM(initiate_checkout_count)`
      - `payment_cost = SUM(spend) / SUM(add_payment_info_count)`
      - `roas = SUM(purchase_value) / SUM(spend)`
    - 状态、花费、购买：
      - `status`：取最新状态展示
      - `spend`、`purchases`：区间直接 SUM

### 4.5 顺序2：结构镜像与选择器口径

- **结构同步**：
  1. **首次全量（Bootstrap）必须**：每个账户第一次跑一次真全量分页同步 `/act_xxx/ads`（6 类状态）→ upsert structure_ads；写入 structure_sync_status：has_full_synced=1、last_full_count=COUNT(*)、last_full_success_at、last_success_at。
  2. **Bootstrap 与轮转优先级（写死）**：① 任何账户 **has_full_synced=0** 或 has_full_synced=1 且 last_full_count=0（未铺表）时，轮转任务**必须优先处理该账户**（先铺表再谈伪增量）。② 若结构表本地 COUNT(*)=0 且 **has_full_synced=1**（异常态），本次**直接全量修复**并重置 last_full_count。③ **判定已铺表的最低标准**：**has_full_synced=1 且 last_full_count>0** 才算真正完成过一次可用的全量铺表。
  3. **后续增量主策略 = 伪增量**：不依赖 FB updated_time filtering（现网不可靠）。**Piggyback 与伪增量关系（写死，防重复调用）**：**结构写库用的 resolveObjectsByIds 同一轮心跳内只执行一次**；Piggyback 承担 activeAdIds 补齐，**尽量复用 Today 同步里已拿到的 ad name/status**（能复用就复用，只对「缺口」补查）；伪增量**只对 diffIds** 调用 resolveObjectsByIds。**diffIds** = recentActiveIds − activeAdIds。**recentActiveIds 取数口径（写死）**：`effective_status='ACTIVE' AND last_synced_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR`（6h/12h/24h 项目选一写死；用 UTC_TIMESTAMP 避免 session time_zone 歧义）。**每账户每轮差异上限 maxDiffIds=200**，超过按 **last_synced_at 最新优先**。仅对 diffIds 拉 id, name, effective_status, status, configured_status, updated_time, **created_time** → upsert 到 structure_ads；diffIds 为空则不调 FB。
  4. **全量保底**：每小时结构全量轮转，**默认 6 个账户**，**允许动态上调到 12**（条件：API 使用率低 + P0 不繁忙；降级：usage 高/退避/429 → 本小时少跑或不跑）。**结构全量并发固定 1**。结构全量必须为 P1 后台任务：**永远让路 P0**（主心跳/归档/回补），撞上就跳过或延后。
  5. **退避策略**：基于 **x-business-use-case-usage** 的强制降级；水池紧张时优先保主心跳，结构全量立即降级/停跑。
  - **历史方案/可选优化**：原「对外 ISO Z/对内 Unix 秒、5 分钟回看窗口、updated_time > sinceISO 拉增量」仅当**确认 FB 支持 updated_time filtering** 时再启用；**当前版本不依赖该能力**。structure_sync_status 的 last_sync_updated_ts 可仍记录本轮 max(updated_time)（可选），但不作为 FB filtering 的依赖。
- **展示策略**：基于查库，不增加 FB 列表调用。**展示过滤与 q 的组合逻辑（写死）**：① q 为空：只返回 ACTIVE；`include_paused=1` 时再加 PAUSED。② q 非空：放宽到 6 类状态；`include_paused` 仍表示「至少包含 PAUSED」，不需另开 ALL。**本期选用：A 安全优先**（q 非空仍排除 DELETED/ARCHIVED；验收不包含「能搜到已归档/删除」）；B 留待后续任务。

### 4.5.1 结构同步优先级策略（P0/P1/P2）

- **P0（最高）统一心跳**：15min 跑 Today/滑动窗口/归档/触发规则；任何结构同步不得抢占 P0。
- **P1 Piggyback**：在 Today 热同步发现 spend>0 的新广告时，按需补齐 structure_ads（缺失才补）；**结构写库用的 resolveObjectsByIds 同一轮只执行一次**；**尽量复用 Today 同步里已拿到的 name/status**，只对「缺口」补查；伪增量只补 diffIds。
- **P1 伪增量 + 每小时结构全量**：伪增量在心跳后置阶段**只对 diffIds** 做 resolveObjectsByIds（activeAdIds 不重复调）；每小时结构全量轮转默认 6 账户、可上调 12，**结构全量并发固定 1**，**has_full_synced=0 优先铺表、count=0 且 has_full_synced=1 时全量修复**，必须后置、可跳过、让路 P0；**usage 高时本小时直接跳过结构任务**。
- **P2 手动刷新**：运营兜底开关（最高优先级体验），重型全量/分页路径；日常新鲜度主要靠伪增量 + 低频轮转全量。
- **数据一致性 SLO**：新建广告产生 spend>0 后在同轮/下一轮可搜到；若需立刻配规则，可点一次「刷新列表/手动同步结构」兜底。

### 4.6 合并同类项：Batching / Piggybacking / Deduping

- 数据同步层（UnifiedSyncJob）：统一以“统一心跳 + 滑动窗口”方式调度所有同步与回补任务，禁止为 Today / Yesterday 分别起独立 Cron；统一的同步入口根据心跳时间与账户时区决定本轮使用的 time_range（Today、last_3d、last_7d、last_14d），最大化复用同一次 API 请求。
- 规则执行层（RuleEngineDispatcher）：在每轮规则扫描时，先按账户和目标层级一次性从 `ad_snapshots`/`daily_stats` 拉取最新指标，缓存在内存中，再将同一份数据依次通过多条规则的条件数组进行判断，避免“每条规则查一次 DB”。
- 指令执行层（ActionExecutor + Dedup）：规则评估完成后先生成完整的 Action Plan，再按 (ad_id, action_type) 维度做去重与优先级仲裁，同一广告只保留最高优先级且不重复的动作，避免对同一对象多次调用相同 API，减少写入限流与报错。

---

## 5. 规则配置层设计（M3）

### 5.1 规则模型（数据库层 + API 层）

在现有 `rules` 相关表/Schema 基础上补充以下字段（字段名可调整）：

- 目标范围：
  - `target_level`：`'ad' | 'adset' | 'campaign'`
  - `target_ids`：JSON 数组，存放 ad/adset/campaign ID 列表。
- 条件配置：
  - `conditions`：JSON 数组
    - 每个条件：`{ metric, operator, value, time_window }`
    - `metric`：如 `cpc`, `spend`, `purchases`, `roas` 等。
    - `operator`：`lt, lte, gt, gte, eq, ne`。
    - `time_window`：`'today' | 'yesterday' | 'last_3_days' | 'lifetime'`。
  - `logic_operator`：`'AND' | 'OR'`，决定使用 `.every()` 还是 `.some()`。
- 其他属性：
  - `timezone_name`：账户时区（如 `Asia/Shanghai`）。
  - `is_active`：规则是否启用。
  - `is_simulation`：是否 Dry Run 模式。
  - `owner_id`：规则创建者，确保「谁设的规则谁管」。

### 5.2 时区与时间窗口处理

- 引入 Luxon 或同类库，在后端统一处理时间：
  - 禁止直接使用 `new Date()` 进行「今日」「昨日」判定。
  - 通过 `timezone_name` 和当前 UTC 时间，计算账户当地的自然日边界。
- 对不同 `time_window` 的处理：
  - `today`：当天 00:00–23:59:59。
  - `yesterday`：往前一天。
  - `last_3_days`：当前自然日往前推 3 天。
  - `lifetime`：可映射为「从广告创建日到当前」或 FB 的 lifetime 统计。

### 5.2.1 指标口径与规则引擎比较语义（比值类 + 坏 vs 空）

- **比值类指标语义**（分母为 0 时记为 null，不可比较）：
  - `cpc`：仅当 `link_clicks > 0` 时有意义；`link_clicks = 0` 时为 null。
  - `ucpc`：仅当 `unique_link_clicks > 0` 时有意义；否则为 null。
  - `cpa`：仅当 `purchases > 0` 时有意义；否则为 null。
  - `roas`：仅当 `spend > 0` 时有意义；否则为 null。
- **规则引擎比较规则**：任意 **null** 与数值做 `gt/gte/lt/lte/eq` 比较，结果均为 **false**（避免用空值误杀/误触发）；不得用 spend 等去「伪造」cpc。
- **「坏 vs 空」产品口径**（AdsPolar 落地）：
  - **贵点击**：`link_clicks > 0 AND cpc > 阈值` → pause_ad（点击贵才关）。
  - **空耗（Zero Click Spend）**：`spend > 阈值 AND link_clicks = 0` → pause_ad（有花费无点击）。
  - **空转化（Zero Purchase Spend）**：`spend > 阈值 AND purchases = 0` → pause_ad（有花费无转化）。

### 5.3 前端规则配置与 SOP 模板

- 级联选择流（前端）：
  - 账户 -> 广告系列 -> 广告组 -> 广告，最终将选中对象的 ID 写入 `target_ids`。
  - 只允许选择同一层级的对象。
- SOP 模板化：
  - 提供预设 JSON 模板，例如：
    - 止损：`spend > 20 && purchases < 1`
    - 扩量：`purchases > 5 && cpa < 10`
    - **空耗**：`spend > X AND link_clicks = 0` → pause_ad
    - **贵点击**：`link_clicks > 0 AND cpc > Y` → pause_ad
    - **空转化**：`spend > Z AND purchases = 0` → pause_ad
  - 前端以「一键填空」方式展示，减少运营配置成本。
- 前端免责提示：
  - 在规则页或监控页显著位置提示：
    - 文案核心：在 FB 后台开启被系统关闭的广告前，请先在本系统暂停相关规则，否则会被再次自动关闭。

---

## 6. 动作执行层设计（M4）

### 6.1 动作模型与优先级

- 动作类型与优先级：
  - Level 1（最高）：`PAUSE`, `ARCHIVE`, `DELETE`
  - Level 2：`DECREASE_BUDGET`, `DECREASE_BID`
  - Level 3：`INCREASE_BUDGET`, `INCREASE_BID`
- 规则与动作关系：
  - 每条规则包含一个或多个动作（JSON 数组）。
  - 执行前，将所有匹配的规则结果按 `ad_id` 分组：
    - 同一 `ad_id` 在同一轮扫描中只保留优先级最高的一条动作，其他丢弃。

<!-- ### 6.2 Smart Mute（智能手动挂起）

- 数据结构：
  - 在 `ad_snapshots`（或单独表）中增加：
    - `mute_until`：DATETIME
    - `mute_reason`：VARCHAR
- 自动挂起规则：
  - 若 Ingestor 发现广告状态从非启用 -> 启用，可设置默认 2 小时优待期。
- 前端交互：
  - 当用户在监控大屏手动开启广告时：
    - 弹出挂起时长选择（1h / 4h / 次日 0 点 / 永久）。
- 引擎检查：
  - 在执行规则前，检查当前时间 `now` 是否小于 `mute_until`：
    - 若是，则跳过该广告的所有动作。 -->

### 6.3 预算护栏与 Pre-Flight 检查

- 预算护栏：
  - 规则配置中加入 `max_daily_budget`。
  - 对于加预算动作：
    - 新预算 = `min(当前预算 * (1 + 增幅), max_daily_budget)`。
- Pre-Flight 检查（定稿口径）：
  - **不新增**对每个广告的 GET；仅用本地 `ad_snapshots.status` 判断「目标已达成则 skipped」（如 pause 前已是 PAUSED/DISABLED/ARCHIVED）。
  - FB 返回「already in that state」/「duplicate」类错误时容错为 skipped 或 success，不记为失败。
- 异常与重试：
  - 对于临时性错误（网络、5xx）：
    - 支持最多 3 次指数退避重试（如 1s, 2s, 4s）。
  - 对于逻辑错误（权限、参数）：
    - 记录错误原因到 `automation_logs`，不重试。

---

## 7. 反馈与监控层设计（M5）

### 7.1 审计日志（automation_logs）

- 每次规则触发（包含 Dry Run）都写入一条记录：
  - 基本信息：广告名、负责人、规则名/ID。
  - 指标快照：当时消费、ROI、转化等。
  - 动作结果：成功/失败/跳过及原因。
  - API 原文：请求与响应体（可裁剪体积）。
- 提供查询 API：
  - 支持按 `account_id`, `rule_id`, `owner_id`, 时间区间等筛选。
  - 前端可做时间线视图。

### 7.2 IM 机器人通知与去噪

- 通知聚合策略：
  - 维护一个 60 秒内存缓冲队列。
  - 将这一时间段内的多个触发事件聚合成一条「简报」，包含：
    - 触发规则数/广告数。
    - 重点列出严重动作（暂停/删档）。
- 通知内容：
  - 集成钉钉/飞书 Webhook。
  - 消息包含广告名、动作、负责人等，利用特殊格式实现 @负责人。

### 7.3 系统健康看板

- 后端统计指标：
  - 各账户最后一次同步成功时间。
  - 规则引擎上一轮全量扫描耗时。
  - 当前动作队列积压任务数。
- 提供健康检查 API，如：
  - `GET /api/system/health`：返回上述指标以及 Token 锁定状态等。
- 前端可后续增加简单健康面板。

---

## 8. 测试与验收标准

### 8.1 测试范围

- 集成测试（Vitest + Supertest）：
  - 规则 CRUD + 权限隔离。
  - Data Ingestor 接口（可通过 mock FB API）。
  - 自动化执行入口（Dry Run 与实际执行）。
- 单元测试：
  - 条件判断与 AND/OR 组合逻辑。
  - 时间窗口与时区计算。
  - 动作优先级与冲突仲裁函数。

### 8.2 验收标准（可转化为 CI 检查）

- 功能验证：
  - 配置典型止损/扩量规则后，在模拟数据上能正确触发/不触发。
  - Dry Run 与真实执行模式行为符合预期。
- 性能与稳定性：
  - 在 N 个账户 * M 个广告规模下，数据同步与规则扫描时间可接受（由实际压测决定）。
  - Token 失效/代理异常时系统能快速「自我熔断」并告警。
- 测试覆盖率：
  - 关键业务模块覆盖率 >= 60%（中期目标）。
  - 进一步提升到 >= 80%（长期目标）。
- 冷数据落盘与时区一致性（补充）：
  - 同一广告同日多快照时，`daily_stats` 当日值等于“最后快照”的值（非 SUM）
  - 跨时区账户在“昨日”边界选择正确（含冷归档未完成真空期场景）；`daily_stats` 缺席时降级策略生效
- 应用日志与轮转（补充）：
  - 按日期生成分级日志；异常与拒绝可追踪；保留策略生效；敏感信息不暴露
- AdsPolar 修复验证（2026-01-27 新增）：
  - 写入清洗逻辑验证：确认僵尸数据被正确过滤
  - 归档查询 data_date 验证：确认使用 data_date 而非 synced_at
  - 验证脚本热数据差异验证：确认 ≤1% 差异被正确识别
  - SQL 综合验证：确认数据一致性和查询口径正确性
- **顺序2 结构同步自检**：主策略为伪增量（不依赖 FB updated_time filtering）；全量保底为每小时轮转、并发 1、P0 抢占；usage 高时结构任务本小时跳过。
