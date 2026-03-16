# FB Ad-Intelligence Server 任务清单（TASKS）

> 建议执行顺序：从「高价值、低耦合」的后端能力开始（数据层 → 规则层 → 动作层 → 反馈层），前端逐步跟进。
>
> **最新更新（2026-03-16）**：① **做法 A：开启动态禁手动目标与排除搜索**：依据 `.cursor/plans/做法a_开启动态禁手动目标与排除搜索_66a27693.plan.md`。后端有 scope 时 union 仅用 dynamicSet；前端开启动态时关闭 2s 防抖与「加载更多」写 targetIds，目标区仅展示「当前匹配 N 个对象」，排除区独立搜索框与 filteredExcludeScopeItems、全选并集；新建/编辑清空 excludeScopeSearch。② **动态匹配数展示与搜索精准化 + 排除区 ID 搜索**：依据 `.cursor/plans/动态匹配数展示与搜索精准化_49bd6f7d.plan.md`。开启动态后防抖 watch 仅更新 matchedCount；目标区/排除区搜索改为 q+limit=50 服务端单页；排除区单账户下支持按广告 ID 搜索（isIdSearch + resolveObjectsByIds 合并）。窗口总结见 `项目开发过程/项目总结-2026-03-16-做法A开启动态禁手动目标与排除搜索.md` 与 `项目开发过程/项目总结-2026-03-16-动态匹配数展示与搜索精准化及排除区ID搜索.md`。
>
> **此前进度（2026-03-13）**：**24小时制时间段选择与UI优化 + 执行时间校验修复**：依据 `.cursor/plans/24小时制时间段选择与ui优化_56fa7594.plan.md`。① 新增 `TimePicker24.vue`（时/分双 select，纯 24 小时）；RuleManager 指定时间段改为两行「开始/结束时间」+ TimePicker24，说明文案单独成行；跨日展示「开始–次日 结束」。② 执行时间段后端：`isInExecutionWindow` 对 MySQL/Drizzle 返回的 JSON 字符串做 `JSON.parse`，修复「配置 20:00–04:00 却在 11:48 仍执行」的根因；单测 `executionWindow.test.js` 增加 JSON 字符串用例；SQL 验证 `rule_execution_summaries.skip_reason=outside_execution_window` 与 `rule_ad_execution_state.last_status=outside_window` 与预期一致。窗口总结见 `项目开发过程/项目总结-2026-03-13-24小时制时间段选择与执行时间验证.md`。可选后续：`executeSingleRule` 增加执行时间段校验使手动「运行此规则」也遵守时间段。
>
> **此前进度（2026-03-13）**：**动态筛选防误判与审计增强**：① **1.5 ID 归一化显式约定**：新增 `docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md`，明确保存/预览路径经 syncTargetByAccount、normalizeCompositeId 归一化；rulesService、dynamicScopeService 相关处补充注释。② **2.1/2.2 历史表计数维度**：迁移 040 为 `rule_matched_objects_history` 增加 `manual_count`、`dynamic_count`（INT NULL，幂等脚本）；`calculateMatchedAdIdsForRule` 返回 dynamicCount/manualCount；`refreshDynamicTargetsForRulesInAccount` 写历史时传入两列。验收：重算后新插入历史行 manual_count/dynamic_count 有值；trigger_type 区分 manual/rule_saved。窗口总结见 `项目开发过程/项目总结-2026-03-13-动态筛选防误判与审计增强.md`。
>
> **此前进度（2026-03-12）**：**历史数据与审计落地方案**：依据 `.cursor/plans/历史数据与审计落地方案_b874db26.plan.md`。① 迁移 037/038/039 建表 rule_history、rule_matched_objects_history、structure_ads_history；② ruleHistoryService + rulesService/dynamicScopeService 写入 rule_history（CREATE/UPDATE/TOGGLE/DELETE/SYSTEM_REFRESH）；deleteRule 同一事务内 SELECT→INSERT 历史→DELETE 快照与规则；③ dynamicScopeService 在 refresh 内 DELETE 前读快照、与 finalAdIds diff，仅变化时写 rule_matched_objects_history（双特征+大列表窄化 checksum）；④ structureSyncService 全账户 Map 预加载、循环内仅内存对比、变更推队列，队列上限 5000、满则丢弃并 Warn，四处写 structure_ads 路径均接历史；优雅停机前 flushHistoryQueue(10s)；⑤ cronService 每日 04:30 历史表清理（分批 DELETE LIMIT 10000、批间 sleep 500ms），可选 ENABLE_HISTORY_CLEANUP、HISTORY_RETENTION_DAYS_*；单次执行脚本 `node server/scripts/run-history-cleanup.js`。问题与解决：MySQL 预编译语句 LIMIT 不可用占位符 → 改为 SQL 内联常量；脚本保留期 0 被 `||` 当未设置 → 仅测试时可用 0，生产用默认 30/60 天。窗口总结见 `项目开发过程/项目总结-2026-03-12-历史数据与审计落地方案.md`。
>
> **此前进度（2026-03-11）**：**规则管理页负责人筛选（方案 B + 联表）**：① 后端 schema 新增 users/owners 最小只读表定义；rulesService.getUserRules 改为 rules→users→owners 联表、select 显式扁平化、仅 isAdmin 且 ownerIds 非空时按负责人过滤；GET /api/rules 解析 ownerIds 并传入。② 前端 RuleManager：仅管理员显示负责人自定义多选下拉（触发器 + 浮层 + 自定义复选框、「清除筛选 (全选)」、点击外部关闭）；loadRules 带 ownerIds；卡片展示负责人；setup return 补全 ownerFilterOpen/ownerFilterDisplayValue 等 5 项修复「not defined on instance」。③ 规则测试 targetIds 改为复合 ID 格式（方案 A），18 个用例通过；新增 `docs/规则管理负责人筛选_验证与测试.md`。窗口总结见 `项目开发过程/项目总结-2026-03-11-规则管理负责人筛选与前端UI优化.md`。
>
> **此前进度（2026-03-11）**：**动态规则 UX 与快照一致性修复**：① **方案「动态规则_ux_与列表性能优化」已闭环**：优化 A（[同步] 按钮、syncJustDoneMessage、syncConfigFromMatch）与优化 B（GET /api/rules 附带 matched_count、规则卡片「当前生效 N 个对象」、rule_matched_objects.rule_id 索引）此前已落地，本窗口确认验收要点满足。② **编辑弹窗「规则配置」与「当前匹配」一致**：打开编辑时对动态规则拉取 GET /api/rules/:id 后，除 matchedCount/invalidIds 外，用接口返回的 target_ids 覆盖 ruleForm.targetIds，并调用 resolveSelectedTargetIds 刷新标签，避免列表陈旧导致「规则配置共 M 个」滞后于「当前匹配 N 个」。③ **重算时清理多余账户快照**：`refreshDynamicTargetsForRule` 在按当前 target_account_ids 刷新各账户快照后，执行 `DELETE FROM rule_matched_objects WHERE rule_id = ? AND account_id NOT IN (当前账户列表)`，避免目标账户缩小后残留旧账户行导致 matched_count 虚高（如规则 603 仅 3 账户却显示 113 对象）。④ 抽取 `resolveSelectedTargetIds(rawIds)` 复用；临时数据修正 SQL 已提供。窗口总结见 `项目开发过程/项目总结-2026-03-11-动态规则UX与快照一致性修复.md`。
>
> **最新更新（2026-03-07）**：**动态筛选多账户闭环（M3.5 + M4.x）完成并验收通过**：① 修复策略 B（`ERROR_OVERSIZE` 保留旧快照）：动态刷新改为 `NORMAL` 规则按 `rule_id + account_id` 原子替换，`ERROR_*` 仅更新状态不清空快照；② 单条执行路径统一到 Dispatcher（`executeSingleRule` 改走 `loadDataForAccount + evaluateRuleWithCache`），确保 `use_dynamic_scope=1` 时严格按 `rule_matched_objects(rule_id, account_id)` 取目标；③ 前后端打通动态筛选配置：规则页新增动态开关（默认开）、上限、状态展示、手动重算 TriggerC、排除名单 UI 与回显，执行语义对齐 `final = (动态 ∪ 手动) - 排除`；④ 多账户动态刷新闭环：TriggerB 保存后按规则涉及账户逐个防抖刷新，TriggerC 传 `ruleId` 自动刷新该规则全部目标账户并返回 `accountResults` 汇总；⑤ `op/operator` 双字段兼容、`act_xxx:id` 目标按账户隔离解析；⑥ 删除规则联动清理 `rule_matched_objects`，避免孤儿快照；⑦ 新增/扩展自动化测试：`ruleEngineDispatcher.test.js`（快照优先 + act:id 隔离）、`dynamicScopeService.helpers.test.js`（多账户账户解析与目标隔离）、`rules.test.js`（删规则联动清快照）。本窗口验证覆盖 TriggerB/TriggerC 多账户、A 超限 B 正常、执行与快照一致，全部通过。窗口总结见 `项目开发过程/项目总结-2026-03-07-动态筛选多账户闭环与项目收尾.md`。
>
> **此前进度（2026-03-07）**：**Track2 极速结构同步 + 全局 FB 限流 + 脏结构刷新**：① 在 `server/index.js` 实现统一三边 Batch 内核 `unifiedStructureBatch(accountId, { sinceSec, limit })`，一次请求拉取 `campaigns/adsets/ads`，支持 Unix 秒 / ISO8601 双过滤、边级别错误解析与「单 edge 回补 + ISO 回退」；② 在 `structureSyncService.js` 新增 Track2 快速同步链路：`fastSyncStructureForAccount` 与 `collectFastSyncDataForAccount` 负责单账户 Batch + 软分页补页（仅对返回 `after` 的 edge 用 `getStructurePage` 继续拉，页数上限可配置），`applyMergedFastSyncPayload` 将多账户结果合并去重并对 `structure_campaigns/structure_adsets/structure_ads` 做分块批量 upsert（默认 chunk≈300 行），同时按账户标记 `fast_dirty`；③ `structure_sync_status` 通过迁移 032/033 新增 `last_fast_sync_ts`、`last_fast_filter_since_sec`、`fast_dirty/fast_dirty_marked_at/fast_dirty_cleared_at` 列，Track2 成功后推进专用水位并在规则执行前由 `refreshStructureIfDirtyBeforeRules` 做一次「脏结构刷新」；④ `cronService.js` 增加 Track2 Fast Sync 定时任务（默认 `7,27,52 * * * *`，accounts 由白名单控制、并发 `TRACK2_FAST_SYNC_CONCURRENCY`、窗口 `sinceSec = max(last_fast_sync_sec - bufferSec, now - 3d)`，buffer 默认 4 小时，可配；Token 熔断或 `x-business-use-case-usage` 过高时本轮跳过），Track1 结构轮转改为可选复用 unified batch 内核；⑤ 在 FB 客户端 `FacebookMarketingAPI.makeRequest` 上方引入全局请求队列与优先级闸门：并发上限 `FB_GLOBAL_REQUEST_CONCURRENCY`（默认 10）、优先级顺序 `action > today > track2 > cold`、排队超时 `FB_GLOBAL_QUEUE_TIMEOUT_MS`，所有对 Facebook 的请求（包含 Today 同步、Track1/Track2 结构同步、规则动作）统一经过该队列，解决多任务叠加时的配额抢占与「止损规则被饿死」风险。详细过程与日志示例见 `项目开发过程/项目总结-2026-03-07-Track2极速结构同步与全局限流.md`。
>
> **此前进度（2026-03-04）**：**时区统一与执行日志显示**：① 数据库连接池统一为 Single Source of Truth（`server/db/drizzle.js` 复用 `connection.js` 的 pool，不再自建 pool）；② `server/db/connection.js` 的 createPool 增加 `timezone: '+00:00'`，与 `SET time_zone = '+00:00'` 配合，保证 mysql2 读写 Date 均为 UTC；③ 执行日志 API 用 `toUTCISO()` 统一返回 `triggered_at`/`created_at` 为带 Z 的 ISO 字符串，前端 `parseUTC` 对无 Z 字符串补 Z 后按 UTC 转北京展示；④ 冷却 debug 日志增加 `lastAtUtc` + `lastAtBj`；⑤ 文档 `docs/0时区转换解决方案.md` 已补充「已落地规范」与 SQL 查询说明（北京会话下勿对 `triggered_at` 再做 CONVERT_TZ）。验收：执行日志前端时间与本地北京时间一致；SQL（北京会话）`SELECT triggered_at` 与前端一致。历史数据未迁移。本窗口总结见 `项目开发过程/项目总结-2026-03-04-时区统一与执行日志及连接池.md`。下一窗口可继续 Step 4 体验与完整性、4.2 IM 机器人。
>
> **此前进度（2026-03-02）**：ROAS 规则判断一律用本地计算；ruleDataService 单日 ROAS 仅用 purchase_value/spend；验证 SQL 与执行结果已通过。本窗口总结见 `项目开发过程/项目总结-2026-03-02-ROAS本地计算与验证及窗口总结.md`。
>
> **此前进度（2026-02-28）**：监控范围条件「创建时间段」已落地并验证；结构同步近 3 天改造、定时 5,35,55 每次 5 账户、刷新列表仅单选；执行频率与执行时间方案七阶段已完成。
>
> **此前进度（2026-02-27）**：§2.5.3 采纳项已落地并验收通过；结构镜像三张表新增 created_time（迁移 029）；本窗口总结见 `项目开发过程/项目总结-2026-02-27-采纳项落地验收与教学及下一步.md`。

**推荐开发顺序（按依赖与验收最短路径）**：Step 0 数据口径（today spend>0 + status=effective_status）→ Step 1 pause_ad 真闭环（3.3+3.7，Pre-Flight 本地 status、非 Dry Run 真实 POST、already-state 容错）→ Step 2 审计可复盘（4.1 最小字段）→ Step 3 Piggyback 补齐 structure_ads（1.2，失败不影响主链路）→ Step 4 体验与完整性（结构增量/定时同步、选择器优化等）。先保证数据可信，再保证能真关广告，再保证日志可解释，最后优化选择与同步体验。
>
> **本窗口执行方案（2026-03-09）**：依据 `.cursor/plans/fb-api-optimizations-v3_8fa0e467.plan.md`（FB API 三项关键优化落地方案 v3）。三项优化及实施顺序：① **优化二** Insights 热数据源头过滤（FB 端 spend>0 过滤、空结果健壮处理、本地兜底、`DISABLE_SPEND_FILTERING` 开关）；② **优化一** 规则执行 Batch POST（按账户收集动作、分片≤50、预算去重合并与覆盖日志、`batchRequests` 顺序拼接、`ENABLE_ACTION_BATCH` 开关）；③ **优化三** Track2 弱化伪增量（Track2 账户不跑伪增量，非 Track2 保留伪增量）。**实施顺序**：先优化二 → 再优化一（分阶段）→ 最后优化三。每完成一项需验收后再进入下一项。

---

## 本窗口执行方案：FB API 三项关键优化（fb-api-optimizations-v3，2026-03-09）

> 方案全文：`.cursor/plans/fb-api-optimizations-v3_8fa0e467.plan.md`。本窗口按以下顺序落地并验收。

- [x] **优化二：Insights 热数据源头过滤（spend>0）**  
  `FacebookMarketingAPI` 统一过滤配置；`getAdInsights` / `syncAccountTodayStats` 启用 FB 端 filtering；滑动窗口 `fetchInsightsInBatches` 追加 filtering；空结果 `data: []` 健壮处理；本地过滤兜底 + `DISABLE_SPEND_FILTERING` 开关。
- [x] **优化一：规则执行 Batch POST**  
  `batchRequests`（分片≤50、顺序拼接）；动作收集与预算去重合并（`PendingAction`、覆盖日志）；`ENABLE_ACTION_BATCH` 开关；先暂停/启用再预算分阶段上线。
- [x] **优化三：Track2 弱化伪增量**  
  `isTrack2EnabledForAccount`；`unifiedHeartbeatSync` 仅对非 Track2 账户执行 `runPseudoIncrementForAccount`；概要日志（Track2 覆盖数、伪增量账户数）；Piggyback 不改动。

---

## 动态规则 UX 与快照一致性（2026-03-11，方案 `.cursor/plans/动态规则_ux_与列表性能优化_c2f7ceda.plan.md`）

> 方案目标：编辑弹窗「规则配置/当前匹配」不一致时提供 [同步] 与引导；列表接口为动态规则附带 matched_count 并在卡片展示「当前生效 N 个对象」。以下为方案验收与本窗口补充修复。

- [x] **优化 A（同步按钮与引导）**  
  当 `ruleForm.useDynamicScope && ruleForm.matchedCount != null && ruleForm.matchedCount !== ruleForm.targetIds.length` 时显示高亮 [同步] 按钮；`syncConfigFromMatch()` 调用 `previewDynamicScope` 更新 `ruleForm.targetIds` 并设置 `syncJustDoneMessage`「配置已更新，请点击【保存规则】以使更改永久生效」；关闭弹窗或保存后清空提示。（RuleManager.vue：showSyncButton、btn-sync-highlight、syncJustDoneMessage）
- [x] **优化 B（列表 matched_count 与「当前生效 N 个对象」）**  
  GET /api/rules 对 `use_dynamic_scope=1` 的规则执行 `SELECT rule_id, COUNT(*) FROM rule_matched_objects WHERE rule_id IN (...) GROUP BY rule_id` 并写回 `matched_count`；规则卡片在 `r.useDynamicScope && r.matchedCount != null` 时展示「当前生效 {{ r.matchedCount }} 个对象」；依赖迁移 035 的 `idx_rule(rule_id)` 索引。（server/routes/rules.js；RuleManager.vue 卡片区）
- [x] **编辑弹窗用详情同步 targetIds（本窗口）**  
  打开编辑时若为动态规则，拉取 GET /api/rules/:id 后除 `matchedCount`、`invalidIds` 外，用 `data.rule.target_ids`/`targetIds` 覆盖 `ruleForm.targetIds`，并调用 `resolveSelectedTargetIds(nextTargetIds)` 刷新已选对象标签，使「规则配置共 N 个」与「当前匹配 N 个」一致。（RuleManager.vue：openEditRule 内详情 then、resolveSelectedTargetIds）
- [x] **重算时删除已不在目标账户的快照行（本窗口）**  
  `refreshDynamicTargetsForRule` 在按 `accountIds` 循环刷新各账户快照之后，执行 `DELETE FROM rule_matched_objects WHERE rule_id = ? AND account_id NOT IN (当前 accountIds)`，避免目标账户从多改少后 matched_count 仍包含历史账户对象。（server/services/dynamicScopeService.js）

---

## 规则管理页负责人筛选（2026-03-11，方案 `.cursor/plans/规则管理负责人筛选_83cd8fe0.plan.md`）

> 方案目标：管理员在规则列表页按负责人多选筛选规则；列表一次联表带出负责人信息；前端仅管理员显示负责人筛选与卡片负责人。

- [x] **后端 Schema**  
  在 `server/db/schema.js` 中新增 `users`、`owners` 最小只读表定义（id、owner_id→ownerId；id、owner_name→ownerName），供联表。
- [x] **后端 Service**  
  `getUserRules` 改为 from(rules).leftJoin(users).leftJoin(owners)；select 显式扁平化（getTableColumns(rules) + ownerId/ownerName）；仅当 isAdmin 且 ownerIds 非空时 inArray(users.ownerId, ownerIds)。
- [x] **后端 Route**  
  GET /api/rules 解析 req.query.ownerIds 为数字数组并传入 options.ownerIds；不传或空表示不按负责人过滤。
- [x] **前端**  
  仅管理员显示负责人自定义多选下拉（触发器 + 浮层 + 自定义复选框、「清除筛选 (全选)」、点击外部关闭）；loadRules 带 ownerIds；normalizeRule 映射 ownerId/ownerName；卡片展示「负责人: xxx」；setup return 补全 5 项。
- [x] **测试与文档**  
  规则测试 targetIds 改为复合 ID 格式（方案 A），18 个用例通过；新增 `docs/规则管理负责人筛选_验证与测试.md`。

---

## 做法 A：开启动态禁手动目标与排除搜索（2026-03-16，已完成）

> 方案：`.cursor/plans/做法a_开启动态禁手动目标与排除搜索_66a27693.plan.md`。开启动态时后端仅用 dynamicSet，前端禁手动目标、排除名单加搜索；关闭动态恢复 2s 防抖与目标区完整操作。

- [x] **后端** 有 scope 时 union 仅 dynamicSet（scopeOnlyForUnion）。
- [x] **前端** 开启动态时关闭 2s 防抖与加载更多写 targetIds；目标区仅展示当前匹配数；排除区独立搜索+filteredExcludeScopeItems+全选并集；新建/编辑时清空 excludeScopeSearch。
- [x] **文档** access-permissions-keycloak-review 做法 A 缺口标记已修复。窗口总结见 `项目开发过程/项目总结-2026-03-16-做法A开启动态禁手动目标与排除搜索.md`。

---

## 动态匹配数展示与搜索精准化（2026-03-16，已完成）

> 方案：`.cursor/plans/动态匹配数展示与搜索精准化_49bd6f7d.plan.md`。开启动态后防抖仅更新匹配数展示；目标区/排除区搜索统一为 q+limit=50 服务端单页；排除区支持按广告 ID 搜索（单账户）。

- [x] **阶段 A — 动态匹配数展示**  
  防抖 watch（3s）依赖 scopeConditionRows/selectedAccountIds/targetLevel/excludeTargetIds/maxDynamicMatches/useDynamicScope；开启动态且条件合法时调 previewDynamicScope，仅写 ruleForm.matchedCount，不写 targetIds。
- [x] **阶段 B — 目标区搜索**  
  SCOPE_SEARCH_LIMIT=50；refreshScopeItems 有关键词时 limit=50、after=null，成功后 scopePagingAfter=null（搜索模式无加载更多）；无关键词保持 limit=500 与 after。
- [x] **阶段 C — 排除区搜索**  
  excludeScopeItems、excludeScopeLoading、excludeRequestId；refreshExcludeScopeItems（仅 excludeScopeSearch 非空时请求，q+limit=50）；filteredExcludeScopeItems（有关键词用 excludeScopeItems，无关键词用 scopeItems）；excludeScopeSearch 防抖 watch；excludeAreaLoading；新建/编辑、清空账户时清空 excludeScopeItems。
- [x] **排除区 ID 搜索（补充）**  
  单账户且关键词满足 `/^\d{10,}$/` 时，与列表请求并行调用 resolveObjectsByIds，合并非 missing 且未在列表中的项并补 account_id；多账户与目标区一致不做 ID 解析合并。根因：后端 q 只按 name 过滤，排除区原无 isIdSearch+resolve。

窗口总结见 `项目开发过程/项目总结-2026-03-16-动态匹配数展示与搜索精准化及排除区ID搜索.md`。

---

## 动态筛选防误判与审计增强（2026-03-13，方案 `.cursor/plans/动态筛选防误判与审计增强_10f402f2.plan.md`）

> 目标：在 v2 基础上纳入观测性（历史表 manual_count/dynamic_count）与一致性（保存/预览 ID 归一化显式约定），便于排障与配置表源头洁净。

- [x] **1.5 ID 归一化显式约定**  
  新增 `docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md`，明确保存规则经 syncTargetByAccount、执行/预览经 normalizeCompositeId；Code Review 清单；rulesService、dynamicScopeService 相关处补充注释。
- [x] **2.1/2.2 历史表 manual_count / dynamic_count**  
  迁移 040 幂等增加 manual_count、dynamic_count（INT NULL）；calculateMatchedAdIdsForRule 返回两计数；refreshDynamicTargetsForRulesInAccount 写历史时传入；验收：重算后新行两列有值，trigger_type 区分 manual/rule_saved。

---

## 历史数据与审计（2026-03-12，方案 `.cursor/plans/历史数据与审计落地方案_b874db26.plan.md`）

> 目标：规则谁改过/改成什么、动态快照变动、结构表 name/status 变更可审计；Change-Only 写入；保留期 rule_history 60 天、rule_matched_objects_history 30 天、structure_ads_history 60 天；定时清理分批 DELETE + sleep。

- [x] **步骤 1：建表**  
  迁移 037_create_rule_history.sql、038_create_rule_matched_objects_history.sql、039_create_structure_ads_history.sql；索引 (rule_id, changed_at)/(rule_id, refreshed_at, account_id)/(account_id, ad_id, changed_at) 等。
- [x] **步骤 2：rule_history 写入**  
  ruleHistoryService.insertRuleHistory；createRule/updateRule/deleteRule/toggle 成功后写入（CREATE/UPDATE/DELETE/TOGGLE）；deleteRule 同一事务内 SELECT→INSERT rule_history(DELETE)→DELETE rule_matched_objects→DELETE rules→commit；dynamicScopeService 两处 UPDATE rules 后 SYSTEM_REFRESH。
- [x] **步骤 3：dynamicScopeService SYSTEM_REFRESH**  
  已合入步骤 2，target_ids/target_by_account 与 dynamic_scope_status 更新后写 rule_history。
- [x] **步骤 4：rule_matched_objects_history**  
  refreshDynamicTargetsForRulesInAccount 内 DELETE 前读当前快照，与 finalAdIds diff；仅 added_count 或 removed_count>0 时 INSERT；object_count>500 时 snapshot 前 100 + object_ids_checksum(MD5)。
- [x] **步骤 4 补充（2026-03-13）：manual_count / dynamic_count**  
  迁移 040 增加 manual_count、dynamic_count（INT NULL）；calculateMatchedAdIdsForRule 返回两计数；写历史时传入，便于排障区分「筛选异常」与「手动勾选变化」。见 `docs/动态筛选防误判与审计增强_ID归一化与审计计数约定.md`。
- [x] **步骤 5：structure_ads_history**  
  structureSyncService 队列（上限 5000）、loadStructureAdsMapForAccount 预加载、四处写 structure_ads 路径（doStructureAdsUpsertAndStatus、piggyback、pseudo_increment、applyMergedFastSyncPayload）内存对比后 push；定时 flush、优雅停机 flushHistoryQueue(10s)。
- [x] **步骤 6：历史表定时清理**  
  cronService 每日 04:30（`30 4 * * *`）；runNightlyHistoryCleanup 三表分批 DELETE LIMIT 10000、批间 sleep(500ms)；ENABLE_HISTORY_CLEANUP、HISTORY_RETENTION_DAYS_MATCHED/ADS/RULE 环境变量；单次脚本 `server/scripts/run-history-cleanup.js`。

---

## 0. 基础架构与测试（如已完成可直接勾选）

- [x] 后端：确认已经实现 `server/app.js` 与 `server/server.js` 的架构分离，并更新 `package.json` 的启动脚本。（app.js 仅 Express 配置，server.js 负责 dotenv + 启动 + cron；package.json 含 dev:server/start: node server/server.js）
- [x] 测试：确保 `vitest.config.js` 存在且 `npm test` 能在不占用实际端口的情况下跑通基本健康检查测试（`server/tests/health.test.js`）。（health.test.js 使用 supertest 测 GET /api/health，不占端口）
- [x] 后端：接入集中化应用日志与轮转（Winston + winston-daily-rotate-file）（2026-02-10 已落地）
  - [x] 创建统一 logger（开发：console 彩色；生产：双写 = 终端 + 文件，JSON 格式）
  - [x] 文件按天切割：combined-YYYY-MM-DD.log、error-YYYY-MM-DD.log、exceptions-YYYY-MM-DD.log、rejections-YYYY-MM-DD.log
  - [x] 设置保留策略：仅保留最近 14 天（可开启压缩）
  - [x] 捕获未处理异常与未处理 Promise 拒绝（集中记录）
  - [x] 关键模块替换 console.* 为分级日志：server、cronService、ingestorService、structureSyncService、rateLimitService、socks5、index、db、actionExecutor、ruleData、routes、authJwt
  - [x] 验收：日志按日期生成、分级可检索、14 天保留；日常开发 `npm run dev:server`（仅终端），需留档时 `npm run dev:server:logs`（终端+文件）

---

## 1. 数据架构层（M2）

### 1.1 数据表设计与迁移

- [x] 后端/DB：在 `server/db/schema.js` 中定义 `ad_snapshots` 表（参照 DEV_PLAN 中的字段建议），并生成/执行对应迁移脚本。
- [x] 后端/DB：定义 `daily_stats` 表，用于存储历史聚合数据，并生成/执行迁移。
- [x] 后端/DB：定义 `automation_logs` 表，用于存储规则执行审计日志，并生成/执行迁移。
- [x] 后端/DB：新增 `daily_archive_status` 表（作为同步/归档任务注册表），包含 `account_id`、`target_date`、`status`(PENDING/ARCHIVED/FINALIZED)、`updated_at`、`last_error` 字段，并生成/执行迁移；创建唯一索引 `uk_account_date(account_id, target_date)`，为后续滑动窗口归档提供状态基础。（schema.js 已定义 dailyArchiveStatus；迁移 009 文件存在，若为空需按 schema 建表；ingestorService 已使用该表做状态流转）
- [x] 后端/DB：检查/更新所有 ID 字段（Account/Ad/Rule 等）为 `VARCHAR(50)`，避免使用 `BIGINT`。（2026-02-12 盘点完成：15 列均为 varchar(50)，无需迁移；文档 `docs/ID字段_VARCHAR50_盘点.md`）

### 1.2 Data Ingestor 实现

- [x] 后端：在 `server/services` 下新增数据同步服务（例如 `ingestorService.js`），提供：
  - `syncAccountTodayStats(accountId)`
  - `syncAllAccountsTodayStats()`
- [x] 后端：在 Ingestor 中实现 20-Batch 聚合：
  - 使用自实现 `chunkArray` 对广告 ID 列表按 20 个一组切分。
  - 按 Facebook Batch API 规范构造请求并发送。
- [x] 后端：在 Batch 请求中显式请求字段（围绕 10 个字段与其计算所需的原始计数）：`ad_id, ad_name, adset_id, spend, actions, action_values, purchase_roas, website_purchase_roas, cost_per_action_type, cost_per_unique_link_click, cost_per_unique_inline_link_click, inline_link_clicks, unique_inline_link_clicks`，并将时间范围锁定为 today（快照）或 yesterday（归档），强制加上 `use_account_attribution_setting=true`。注意：不请求 cpc（方案A 不持久化派生值）；purchase_roas、website_purchase_roas 作为 API 兜底来源。（2026-02-11 已更新）
- [x] **Route 1（Insights First）字段完整性**：`server/index.js` 的 `getAdInsights()` 补齐 ROI 核心字段（action_values、cost_per_action_type、purchase_roas、website_purchase_roas），mapItem 透传；降级 fallbackFields 保留 ROI 核心字段。解决 Today 心跳走 Route 1 时 purchase_value 必为 0 的根因。验收：SQL `cnt_bad=0`（purchases>0 且 purchase_value=0 的广告数为 0）。（2026-02-11 已落地）
- [x] 后端：为每次同步生成 `sync_session_id`，将全部写入 `ad_snapshots` 的该字段，并记录同步完成时间。
- [x] 后端：实现数据字段提取逻辑（10 个核心字段：状态、花费、成效(购买)、CPA、ROAS、CPC、uCPC、加购费、结账费、支付费，以及区间计算所需的原始计数）。
- [x] 后端：实现获取广告状态的逻辑（从 `/ads` API 获取并合并到 insights 数据中）。
- [x] **数据口径（下一阶段优先级）**：today 热数据只写入 spend>0 的广告到 `ad_snapshots`；同步时过滤 spend=0 的记录，日志打印过滤前后数量；验收：DB 中不存在 spend=0 的 today 快照。（2026-02-07 验收通过）
- [x] **status 来源**：`ad_snapshots.status` 写入 FB 的 `effective_status`（用于前端选择器默认过滤与执行前本地 Pre-Flight）；验收：status 与 FB 广告后台一致，ACTIVE/PAUSED 等可正确驱动 Pre-Flight 与选择器。（2026-02-07 验收通过）
- [x] **后端（P1 Piggyback）**：在每次 Today 热同步拿到 spend>0 的 ad_id 列表后，做 structure_ads「缺失/空名」补齐（DB diff → resolveObjectsByIds → upsert structure_ads）。**定稿口径**：Piggyback 视为伪增量的「实现入口」——**结构写库用的 resolveObjectsByIds 同一轮心跳内只执行一次**（由 Piggyback 承担 activeAdIds 的补齐）；伪增量任务只补 diffIds，不得对 activeAdIds 再调。**开发规则（防 Today 同步与 Piggyback 重复调 FB）**：Today 同步里已为 statusMap 等拿到的 ad 的 name/effective_status 等，Piggyback 写 structure_ads 时**直接复用**，不再重复 resolveObjectsByIds；**只对「缺口」**（DB 缺失或空名且本轮未拿到）补查。验收：新广告一旦产生 spend>0，在同一轮或下一轮心跳后可在选择器按 name/id 搜到；日志打印本轮缺失 id 数与实际补齐数；正常情况下每轮补齐为 0~少量，不显著增加 API 调用。（2026-02-05 已落地并验证）
- [x] **后端（P0 不被打扰）**：Piggyback 必须 best-effort，可跳过/可失败不影响 Today 热同步与规则触发链路。验收：模拟 resolveObjectsByIds 失败/超时，热同步与规则仍正常完成；仅记录 warning，不导致整轮心跳失败。
- [x] **数据一致性口径**：FB 新建广告在下次热同步后可搜到；若运营立即要配规则，提供「刷新列表/手动同步结构」兜底。验收：按文档步骤演示：新建广告→产生 spend→选择器可搜到；若未出现，触发一次手动刷新后出现。（后端 2.4 + 前端刷新列表按钮均已接，2026-02-07）
- **优先级口径**：P0 热同步与规则触发不可被结构同步抢占；P1 Piggyback（本段）、P1 低频增量与 P2 手动兜底见 1.2.1。

- **顺序2/下一阶段优先级（结构镜像 + 同步）**  
  **验收口径**：选择器列表加载/搜索/翻页**不应穿透调用 FB**，FB 只在「同步结构」时调用。**落地顺序**：先 2.4（手动同步）→ 再 2.2（选择器查库）。
- [x] **结构镜像表 structure_ads**：已建表并验收（迁移 `014_create_structure_ads.sql`，含 uk_account_ad、idx_account_effective_status、idx_account_name）。验收：同账户下按 name/ad_id/effective_status 查询可走索引。
- [x] **结构镜像表 structure_campaigns / structure_adsets**：已由迁移 023/024 实现；listStructureCampaignsFromDb、listStructureAdsetsFromDb 及 GET /api/structure/:level 三层查库已落地。
- [x] **结构镜像表收集创建时间 created_time**：三张表（structure_ads、structure_adsets、structure_campaigns）新增字段 `created_time`（VARCHAR(80)，存 FB 返回的 ISO8601）；迁移 `029_add_created_time_to_structure_tables.sql`。全量结构同步、Piggyback、伪增量及 Today 同步的 STRUCTURE_FIELDS/ADS_FIELDS/CAMPAIGNS_FIELDS/ADSETS_FIELDS 均含 `created_time`，写入时落库。**已用于监控范围条件「创建时间段」**：列表接口支持 scope_created_within_hours 过滤，前端 RuleManager 可选「近 24/48/72 小时」或自定义小时（见 2.5.3 创建时间段项）。（2026-02-28 创建时间段已落地）
- [x] **结构同步近 3 天改造（2026-02-28）**：按 `docs/0结构同步任务改造—执行方案.md`：getStructurePage 映射增加 created_time；syncAccountStructureAds 对 campaigns/adsets/ads 只拉 updated_time >= since（since = 当前时间减 3 天），filtering value 优先 Unix 秒、单 edge 报错自动回退 ISO8601；doStructureAdsUpsertAndStatus 传 isFullRun: false；structure_sync_status 增加 last_filter_since_sec（迁移 030）；轮转命名/日志统一「近3天」。验收见 `docs/结构同步近3天_测试与验证指南.md`。
- [x] **元数据同步（定时）**：**由「结构轮转（近 3 天）」承接**，不再单独起 30–60min 定时任务（避免双全量并行、配额被抽干）。campaigns/adsets/ads 均只拉 updated_time >= 3 天前；定时为每 20 分钟 :05/:35/:55（Cron: 5,35,55 * * * *），每次最多 5 账户。验收：跑完一轮后 structure_* 有近 3 天数据，created_time/updated_time 落库；日志为「结构轮转-近3天」。（2026-02-28 已落地）
- [x] **新对象补全（跟随 today spend 同步）**：当 today insights 发现新 ad_id 时，补齐该广告元数据并 upsert 到 `structure_ads`（并尽量补齐关联 adset/campaign）。验收：新建广告一旦开始花费后，在选择器里能被 q 搜到（不依赖 FB 实时接口）。（由 Piggyback 承接，已落地）
- [x] **手动刷新（强制同步结构）**：新增「强制同步该账户结构」的后端入口，供 UI「刷新列表」按钮调用。约束：带账户级锁 + 冷却期（例如 2 分钟，避免狂点）。验收：FB 新建/改名对象，点一次刷新后可在选择器里搜到。**落地方案**：`docs/顺序2_2.4_手动同步结构_落地方案.md`（先做 2.4 再做 2.2）。**定位**：手动刷新仍是最高优先级兜底（锁+冷却），但它是「重型全量/分页」路径；日常新鲜度主要靠**伪增量 + 低频轮转全量**。（后端 POST /api/sync/structure + 前端「刷新列表」均已接，2026-02-07）**前端（2026-02-28）**：「刷新列表」仅在选择**一个**广告账户时可点击；多选时按钮禁用并提示「仅在选择一个广告账户时可刷新列表」。

- **结构同步增量化（顺序2 优化）**
  - **前提铁证**：`/act_xxx/ads` 的 filtering(updated_time > sinceISO) 在现网**不可靠**（SQL 已证伪），**禁止**再把它作为增量同步主策略或依赖其节省调用/减少返回集合。
  - **增量主策略 = 伪增量（本地差异驱动按需补全）**：不依赖 FB updated_time filtering；每 15 分钟统一心跳之后（或心跳后置阶段）对每个账户做「按需补全」，不碰全表。
  - **首次全量（Bootstrap）与轮转优先级（写死）**：① 任何账户 **has_full_synced=0** 时，轮转任务**必须优先处理该账户**（先铺表再谈伪增量）。② 若结构表本地 `COUNT(*)=0` 且 **has_full_synced=1**（异常态），本次**直接全量修复**并重置 last_full_count。③ **判定已铺表的最低标准**：**has_full_synced=1 且 last_full_count>0** 才算真正完成过一次可用的全量铺表；has_full_synced=1 但 last_full_count 为空/0 时调度应视为未铺表并优先处理。避免未铺表账户只跑伪增量导致选择器永远缺数据。
  - 首次同步（必须）：每个账户第一次跑一次真全量分页同步 `/act_xxx/ads`（6 类状态）→ upsert structure_ads；写入 structure_sync_status：has_full_synced=1、last_full_count=COUNT(*)、last_full_success_at=NOW()、last_success_at=NOW()。
  - **伪增量与 Piggyback 关系（写死，防重复调用）**：**activeAdIds 的补全由 Piggyback 完成**；伪增量**只补差异集合 diffIds**。**硬约束**：同一轮心跳内，**activeAdIds 的 resolveObjectsByIds 只能执行一次**（由 Piggyback 承担）；伪增量任务**只对 diffIds** 调用 resolveObjectsByIds，不得对 activeAdIds 再调。
  - **伪增量算法（写死可执行口径）**：
    - **输入**：主心跳产出的 **activeAdIds**（本轮 Insights spend>0，已由 Piggyback 在本轮完成补齐，伪增量不再处理）。
    - **状态差异检测集合 diffIds**：recentActiveIds − activeAdIds。**recentActiveIds 取数口径（写死）**：`SELECT ad_id FROM structure_ads WHERE account_id=? AND effective_status='ACTIVE' AND last_synced_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR`（时间窗口可选用 6h/12h/24h，项目选一写死）。**每账户每轮差异上限**：**maxDiffIds=200**（超过上限按 **last_synced_at 最新优先** 取前 200），保证差异检测不退化成全表轮询。
    - **调用**：**仅对 diffIds** 调用 **resolveObjectsByIds**（fields: id, name, effective_status, status, configured_status, updated_time, created_time），只 upsert 这批 id 到 structure_ads；若 diffIds 为空则本轮伪增量不调 FB。
    - **游标（可选）**：structure_sync_status.last_sync_updated_ts 可记录本轮返回的 max(updated_time)，**不再作为 FB filtering 的依赖**。
  - 全量保底（方案 C）：见 1.2.1「每小时结构全量轮转」；结构全量并发**固定 1**，P0 抢占，usage 高时本小时跳过。
  - 限流与并发：手动刷新每账户 2 分钟冷却（已有）；结构全量见 1.2.1。
  - **落地方向（与文档对齐）**：当前实现若仍含 `filtering: updated_time GREATER_THAN sinceISO` 的增量分支（如 `structureSyncService.js`），应改为「按需补全（resolveObjectsByIds）」；或将 updated_time filtering 降级为「可选实验，不参与默认路径」，否则文档口径与实现冲突，问题会继续复现。
  - **验收口径**：
    - 伪增量一轮 **touched_rows** 应远小于全表（≈ 活跃数 + 差异抽查数），**不允许**再出现「mode=incremental 但 touched_rows=全表」的现象。
    - 手动暂停 ACTIVE 广告后，下一轮伪增量能把本地 structure_ads 状态更新为 PAUSED。
    - 日志有本轮补齐 id 数、耗时、失败原因。

- **选择器本地展示过滤（顺序2 优化）**
  - **展示过滤与 q 的组合逻辑（写死）**：① **q 为空**：只返回 ACTIVE；若 `include_paused=1` 则再加 PAUSED。② **q 非空**：放宽到 6 类状态（ACTIVE/PAUSED/PENDING_REVIEW/DISAPPROVED/IN_PROCESS/WITH_ISSUES）；`include_paused` 仍表示「至少包含 PAUSED」，不需另开 ALL。**本期选用：A 安全优先**——q 非空仍排除 DELETED/ARCHIVED（运营不可搜到归档/删除）；B（q 非空可含 ARCHIVED/DELETED + 前端醒目标识）留待后续任务。
  - 后端参数：`include_paused=1`；分页仍 limit + after；只查库不调 FB。
  - 验收：默认列表明显变短（仅 ACTIVE）；勾选后能看到 PAUSED；输入 q 能搜到目标（6 类状态内）；全程 0 FB 列表调用。**验收不包含**「能搜到已归档/删除广告」。

### 1.2.1 结构镜像（structure_ads）与选择器数据源（顺序2）

- [x] **后端（P1 伪增量）**：每 15 分钟统一心跳之后（或心跳后置阶段），对每个账户只对 **diffIds** 做 resolveObjectsByIds 按需补全（activeAdIds 由 Piggyback 承担，同一轮只调一次）；不依赖 FB updated_time filtering。验收见上文「结构同步增量化」。（2026-02-05 已落地并验证，含 1h 降频+旋转、NULL 自愈）
- [x] **后端（P1 每小时结构全量轮转）**：结构轮转（近 3 天）：**每 20 分钟** :05/:35/:55（Cron: 5,35,55 * * * *），**每次最多 5 个账户**；允许**动态上调到 12**（opts.maxAccounts）。**结构全量并发固定 1**。**轮转优先级（写死）**：has_full_synced=0 或 has_full_synced=1 且 last_full_count=0（未铺表）的账户必须优先处理；本地 count=0 且 has_full_synced=1 时本次直接全量修复并重置 last_full_count。同步策略为「近 3 天」：campaigns/adsets/ads 只拉 updated_time >= since（since = 当前时间减 3 天），filtering value 优先 Unix 秒，单 edge 报错回退 ISO。**本条承接「元数据同步（定时）」**。（2026-02-28 已改为近 3 天 + 5,35,55 + 5 账户）
- [x] **后端（P1 强制让路）**：结构全量必须为 P1 后台任务：**永远让路 P0**（主心跳/归档/回补）；撞上就跳过或延后，不抢资源。定时结构同步必须挂在统一心跳的「后置阶段」（等本轮账户热同步全部结束后再尝试），不与热同步并行。**usage 高时本小时直接跳过结构任务**。验收：先完成热同步（及规则触发），再开始结构同步；usage 高时结构全量本小时不跑。
- [x] **后端（P2 兜底）**：保留手动刷新结构（已有账户锁+冷却+分页）作为最高优先级兜底；P1 定时结构同步不可影响 P2 手动触发。验收：在 P1 正在运行或预算已满时，手动刷新仍可用（或明确返回「锁忙+retry_after」），运营能理解并重试。（2.4 冷却已改为 structure_sync_status.last_success_at，不被 Piggyback 误伤）
- **实现策略与验收口径**：structure_sync_status + 伪增量（Insights + 本地差异 + resolveObjectsByIds）+ 每小时全量轮转（默认 6、可上调 12、并发 1）+ 退避（x-business-use-case-usage 紧张时优先保主心跳，结构全量立即降级/停跑）；验收见「结构同步增量化」。

### 1.3 API 频率自适应与自愈

- [x] 后端：解析响应头 `x-business-use-case-usage`（若存在），并尝试 JSON 解析。
- [x] 后端：基于使用率实现动态休眠策略：
  - 使用率 < 50%：休眠 500ms。
  - 使用率 50%–85%：休眠 2s。
  - 使用率 > 85%：休眠 10s，并记录警报事件。
- [x] 后端：封装 `fetchWithTimeout` 或对现有 HTTP 客户端增加超时控制（45 秒），使用 `Promise.race` 或原生超时配置防止请求卡死。
- [x] 后端：实现 Token 智能熔断：
  - 维护连续失败计数 `failureCount`（专门针对 190 错误）。
  - 当计数达到 3 时，设置 `isSystemLocked = true`，停止后续同步任务并抛出统一错误。
- [x] 后端：实现受控并发模式（并发度 = 6）：（2026-02-07 已落地，CONCURRENT_LIMIT=6，缓解代理瞬时压力）
  - 在所有"按账户遍历"的任务中（Today 热同步、冷路径双窗口归档、last_7d / last_14d 回补等），统一采用受控并发模式。
  - 限制同一时刻并发运行的账户任务数量为 6。
  - 可以使用 `p-limit(6)` 或自实现并发池。
  - 明确要求"不要再完全串行，也不要一次性全并发"。
  - 受控并发 + Header 自适应休眠策略一起工作，使用率高时可以通过延长 sleep 或临时降低并发度继续保护配额。
- [x] 测试：并发 + 限流的验证：
  - 在本地/测试环境构造约 36 个账户的场景。
  - 验证在"并发度 = 6 + Header 自适应休眠策略"下：
    - 整体同步时间明显优于串行。
    - 不会出现严重限流或大量 429 错误。
  - （2026-02-12：concurrentLimit.test.js 单测通过；verify-concurrent-limit.js 验证脚本；docs/1.3_并发限流验证.md；真实 36 账户 429 检查见文档）

### 1.4 滑动窗口与冷热数据策略

- [x] 后端/DB：在 Ingestor 中实现滑动窗口同步（Today + Past 7 Days），使用 `ON DUPLICATE KEY UPDATE` 更新过去一周数据。
- [x] 后端：现网定时任务（`server/services/cronService.js`）：
  - Today 同步：每 10 分钟（Cron: `*/10 * * * *`）。
  - 冷数据归档：每天 12:00（Cron: `0 12 * * *`，`forceAll=true` 延迟归档）。
  - 历史回补：每 30 分钟一次（last_7d 覆盖）。
- [x] 后端：目标定时任务（与《FB Ad-Intelligence 系统改善方案（最终版）》对齐）：
  - 统一心跳：每 15 分钟（Cron: `*/15 * * * *`），内部根据当前心跳时间与账户本地时间决定本轮执行的窗口（Today、last_3d、last_7d、last_14d），不再额外起第二条 Cron。（cronService 已用 `*/15` 调 unifiedHeartbeatSync）
  - 冷路径双窗口归档：在统一心跳内每 15 分钟巡检（滑动阈值），按账户 `timezone_name` 判断：账户本地时间 ≥02:00 对昨日执行初步归档（ARCHIVED）、本地时间 ≥12:00 对昨日执行深度对账覆盖（FINALIZED），错过可补跑（依赖归档状态表）。（ingestorService.checkAndExecuteArchive + daily_archive_status 已实现）
  - 真空期兜底：冷归档未完成前，对昨日查询自动降级使用 `ad_snapshots` 中昨日最后快照（基于 `data_date` 字段），不再在 00:15 单独跑冷回溯任务。（ruleDataService 的 yesterday 在 06:00 前降级到 ad_snapshots；ingestorService 归档查询使用 data_date）
- [x] 后端：滑动窗口语义修复（2026-01-21）：
  - `today` 数据只写入 `ad_snapshots`（只包含 today 数据）。
  - 过去 N 天的按日数据更新到 `daily_stats`（使用 `time_increment=1` 拉取按日数据）。
  - 修复语义污染：`today` 查询只返回 today 的真实数据，不包含 `last_7d` 聚合值。
- [x] 后端：时区自动更新机制（2026-01-21）：
  - 每次数据同步时自动从 Facebook API 获取最新时区。
  - 如果时区不一致，自动更新 `account_mappings.timezone_name`。
  - 历史时区刷新工具：`refresh-timezone-history.js`。
- [x] 测试：为 Data Ingestor 的核心逻辑编写集成测试或单元测试，尤其是滑动窗口覆盖逻辑。

### 1.5 冷数据落盘口径修正（当日最后快照）

- [x] 后端/DB：修正冷数据落盘为"当日最后快照"而非 SUM
  - [x] MySQL 8.0+：使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)`，取 `rn = 1`
  - [x] 非 8.0 兼容：使用"最大时间戳连接法"（先取 MAX(synced_at)，再连接原表取该时间点的完整字段）
- [x] 后端：落盘与查询均使用账户 `timezone_name` 计算"昨日"自然日边界；现网冷归档为 12:00 延迟归档；无数据时可降级到 `ad_snapshots` 的"昨日最后快照"（展示层尽力而为）
- [x] 后端/DB：冷数据归档幂等与并发控制（2026-01-21）：
  - COUNT(*) 检查：快速跳过已归档记录。
  - GET_LOCK：防止多实例并发归档，**必须使用 mysql2 的 `pool.getConnection()` 获取专用连接，在同一连接上执行 `SELECT GET_LOCK(...)` 与 `SELECT RELEASE_LOCK(...)`；禁止直接使用 `pool.execute('SELECT GET_LOCK...')`，避免锁绑定在短暂连接上导致泄漏或误用（对齐 v4.9 🔴 紧急修复）。
  - 唯一索引 `uk_account_ad_date(account_id, ad_id, date)`：数据库层幂等。
  - ON DUPLICATE KEY UPDATE：自动更新已存在记录（包含 `timezone_name` 更新）。
- [x] 后端/DB：归档完整性检查修复（2026-01-22）：
  - 将"已归档跳过"改为"完整性检查"（expectedCount vs archivedCount）。
  - 只有已归档且完整才跳过，否则继续归档补齐。
  - 增强 ROW_NUMBER 排序稳定性（添加 `id DESC` 作为 tie-breaker）。
  - 增强观测性（跳过原因分类统计：已归档且完整、已归档但不完整、锁占用、窗口未到、无效账户、异常失败）。
  - 手动归档改为强制模式（绕过时区窗口和跳过检查）。
- [x] 后端/DB：**方案 A 写库口径**（2026-02-11 已落地）：ad_snapshots / daily_stats 不持久化派生 cpc/ucpc/roas（一律 null）；roas 仅存 API 兜底（purchase_roas / website_purchase_roas）或 null；只存分子/分母（spend、purchase_value、link_clicks 等）。updateDailyStatsFromInsights、archiveDailyStats、saveSnapshotsToDbInternal 三条路径统一。
- [x] 后端/DB：`daily_stats` 写入 6 个原始计数字段与 `ad_set_id`；cpc/roas 按方案 A 仅存 API 兜底或 null
- [x] 后端/DB：移除 CTR/CPM 相关处理与字段引用，统一围绕 10 个核心字段与原始计数
- [x] 后端/DB：`ad_snapshots` 今日入库分子/分母与原始计数；cpc/ucpc/roas 按方案 A 仅存 API 兜底或 null（其中 cpa 今日仍按 `spend/purchases` 计算）
- [x] 后端：调整 CPA 计算口径：不使用 `cost_per_action_type` 的 purchase 成本，统一按 `spend/purchases` 计算（今日与区间）
- [x] 后端：**日期口径**（2026-02-12）：updateDailyStatsFromInsights 写入 daily_stats 的日期字段改为 `insight.date_start || insight.date`，与「事件发生自然日」一致。
- [x] 后端：**回退健壮性**（2026-02-12）：archiveDailyStats 中计算 targetDateStart/End 后定义 startTime/endTime，回退分支调用 queryLastSnapshotCompatible(accountId, dateStr, startTime, endTime)，避免未定义变量崩溃。
- [x] 后端：**冷数据 cpc/roas 单日兜底**（2026-02-12）：archiveDailyStats 的 values 映射中，cpc 在 link_clicks>0 且 spend>0 时为 spend/link_clicks 否则 null；roas 优先 API 昨日值，否则 purchase_value>0 且 spend>0 时为 purchase_value/spend 否则 null；修复冷数据落盘 purchaseValue 未定义 bug（使用 row.purchase_value）。
- [x] 后端：**强制重跑归档**（2026-02-12）：archiveAllAccountsDailyStats 在 forceAll=true 时不再因「已归档且完整」跳过，执行归档便于回填 cpc/roas；手动归档脚本 `server/scripts/manual-archive.js` 调用 manualArchive()。
- [x] 后端：**回退口径对齐**（2026-02-12）：queryLastSnapshotCompatible 先按 data_date=targetDateStr 取最后快照，若无结果再按 synced_at 范围兜底并打 warn（含 accountId、dateStr、ads 数）；返回 { rows, mode: 'data_date'|'synced_at', ads }；archiveDailyStats 回退分支传入 dateStr 并向上返回 compat。
- [x] 后端：**回退观测**（2026-02-12）：archiveAllAccountsDailyStats 汇总日志增加「回退观测」：兼容方案账户数、synced_at 兜底账户数、synced_at 兜底广告数；统一心跳每账户打「拉取 spend>0 / 写入 ad_snapshots」及「同步完成但无数据更新」便于排查。
- [x] 索引：确认/增加 `idx_account_synced`、`idx_ad_synced`、`idx_ad_synced_desc` 提升检索性能；创建唯一索引 `uk_account_ad_date(account_id, ad_id, date)` 确保幂等更新；**迁移 017**（2026-02-12）：幂等添加 `idx_account_date_ad(account_id, data_date, ad_id)`（`server/db/migrations/017_add_idx_account_date_ad_idempotent.sql`，存储过程内 CONCAT 使用纯 ASCII 避免 1271）。
- [x] 测试：构造同一广告同日多快照样例，验证 `daily_stats` 当日值等于"最后快照"的值；跨时区边界验证；降级查询误差控制在约 0.7%-1%；**归档回退单测**（2026-02-12）：archiveFallback.test.js（data_date 优先 + synced_at 兜底 + compat + warn）、archiveAllAccountsDailyStats.metrics.test.js（回退观测汇总），与 ingestorService 相关共 10 条通过；验证步骤见 `docs/archive_date_start_and_cpc_roas_验证.md`。

### 1.6 归档状态表与任务注册表

- [x] 后端：在冷数据归档流程中接入状态流转：按账户+日期从 `daily_archive_status` 读取当前状态，驱动 PENDING→ARCHIVED→FINALIZED 的幂等更新与补跑；人工手动归档时也更新该表（表结构已在 1.1 节创建）。（ingestorService：getArchiveStatus、executeArchive 写 daily_archive_status；checkAndExecuteArchive 按 02:00/12:00 驱动）
- [x] 后端：归档巡检任务基于 `daily_archive_status` 查询“今天谁的昨天还未 ARCHIVED/FINALIZED”，结合账户本地时间 ≥02:00/≥12:00 决定执行初步归档或深度对账。（unifiedHeartbeatSync 内每账户调 checkAndExecuteArchive）
- [x] 测试：构造跨时区、多次失败重试场景，验证状态表驱动下不会重复归档同一 (account_id, date)，且能在恢复后自动补齐缺失数据。（2026-02-12：dailyArchiveStatus.test.js 4 用例通过，含 ARCHIVED/FINALIZED 跳过、status=null 执行归档、跨时区 targetDateStr 隔离）

### 1.7 热数据快照与清理

- [x] 后端/DB：为 `ad_snapshots` 新增 `data_date` 字段（DATE，不为空），并创建唯一索引 `uk_account_ad_date(account_id, ad_id, data_date)`；现有基于 `sync_session_id` 的唯一约束调整为普通索引。（迁移 010_add_data_date_to_ad_snapshots.sql 已实现；schema 有 dataDate）
- [x] 后端：统一写入逻辑：所有同步任务中，按照账户 `timezone_name` 计算当前自然日 `data_date`，将 `data_date` 等于“今日”的记录写入/覆盖 `ad_snapshots`，`data_date` 小于今日的记录写入 `daily_stats`（分层落盘，禁止丢弃 today 部分）。（ingestorService 写入 ad_snapshots 时带 data_date；冷归档写 daily_stats）
- [x] 后端：新增 `ad_snapshots` 清理任务（建议每日本地时间 04:00 触发），删除 `synced_at < NOW() - INTERVAL 2 DAY` 的历史快照，保持热表轻量。（2026-02-12：cleanupAdSnapshots + Cron 0 4 * * * + manualCleanupAdSnapshots + manual-cleanup-ad-snapshots.js）
- [x] 测试：验证 `ad_snapshots` 在多次覆盖写后仍然只保留每个 (account_id, ad_id, data_date) 一条记录；验证清理任务只删除超过 2 天的数据且不影响昨日真空期兜底查询。（2026-02-12：cleanupAdSnapshots.test.js 3 用例通过，含 DELETE 条件、deleted=0、失败返回）

---

## 2. 规则配置层（M3）

### 2.1 规则数据模型扩展

- [x] 后端/DB：扩展现有 `rules` 表/Schema，增加：
  - `target_level`（ad/adset/campaign）
  - `target_ids`（JSON）
  - `conditions`（JSON 数组）
  - `logic_operator`（AND/OR）
  - `timezone_name`
  - `is_simulation`
- [x] 后端：更新规则创建/更新 API，使其支持上述字段的读写，并做基本参数校验。
- [x] 后端：实现规则 CRUD 完整功能（创建、查询、更新、删除、启用/禁用）。（2026-01-27）
- [x] 后端：实现规则账户绑定与权限校验（普通用户只能绑定自己负责的账户）。（2026-01-27）
- [x] 后端：实现规则执行框架（AdsPolar 事件驱动、账户级锁、冷却期机制）。（2026-01-27）
- [x] 测试：为规则 API 增加测试用例，覆盖新字段写入与读取。

### 2.2 时区与时间窗口逻辑

- [x] 后端：引入时间库（如 Luxon），在规则执行路径中统一使用该库处理时间和时区。
- [x] 后端：实现时间窗口解析逻辑：
  - today / yesterday / last_3_days / lifetime 对应的起止时间计算，基于 `timezone_name`。
- [x] 后端：在规则引擎的指标查询中，使用时间窗口参数从 `ad_snapshots` 或 `daily_stats` 中筛选数据。（已完成：阶段4 - 创建规则数据查询服务）
- [x] 后端：增强 RuleEngine 类，支持从数据库查询数据、AND/OR 逻辑、target_level/target_ids 筛选、时间窗口。（已完成：阶段5 - 增强 RuleEngine）
- [x] 后端：修复时区不一致问题（数据同步时区 vs 账户时区）。（已完成：2026-01-20 - 时区配置方案实施完成）
- [x] 测试：为时间窗口计算逻辑编写单元测试，验证不同时区与日期边界情况下的正确性。

### 2.3 前端规则配置改造

- **2.3 条件组 DNF（2026-02-07 已闭环）**
  - [x] 后端 v2 conditions 校验与执行（conditionsValidator、RuleEngine、rules 路由）
  - [x] 4 步集成验收：验证 3 time_window 不一致→400、验证 4 v2 空组→400、验证 1 v1 OR、验证 2 v2 DNF
  - [x] Thunder Client 集合 `docs/Thunder_Client_DNF验证集合.json`、手把手步骤 `docs/DNF验证_手把手步骤.md`
- **2.3.1 触发条件线性列表（方案B）**：详见 `docs/2.3.1_触发条件_线性列表_方案B.md`
  - [x] **阶段 1**：转换函数 linesToV2Groups / v2ToLines / v1ToLines + 初始化逻辑（whenLines、whenTimeWindow、whenCustomRange；空列表自动补 1 行；首行 join=null）
  - [x] **阶段 2**：UI 改造 — 顶部全局 time_window + custom_range；移除 logicOperator；线性条件列表，第 2 行起 AND/OR 下拉
  - [x] **阶段 3**：保存用 linesToV2Groups 输出 v2；openEditRule 用 v2ToLines/v1ToLines 回填。验收：按 `docs/2.3.1_阶段3_保存回填验收步骤.md`（验收 1+2 通过，含 OR 回填、v2 两 group 结构正确）。
  - [x] **阶段 4**：applyTemplate 填充 whenLines + whenTimeWindow；无 v2 JSON 模式（模板已确认通过）。
- **顺序2 选择器（主线）**
- [x] **选择器改为查库（2.2）**：后端 `GET /api/structure/ads` 仅查 `structure_ads`，支持 `q` + `limit` + `after` + `include_paused`，返回 `paging.after`（基于 id 的稳定游标）。默认过滤：q 为空仅 ACTIVE，include_paused=1 加 PAUSED；q 非空为 6 类状态仍排除 DELETED/ARCHIVED。验收：见 `docs/顺序2_2.2_选择器查库_验收步骤.md`；非 admin 他人 account 仍 403；服务端日志 `[2.2] ... from structure_ads only, no FB request` 证明 0 FB 列表调用。
- [x] **resolve 回显查库**：`GET /api/structure/resolve` 优先从 structure_ads 按 ids 查；DB miss 返回 `{ id, missing: true }`，不穿透 FB。UI 显示「id (未同步)」+ 黄底 tag；可通过「刷新列表」补齐。（2026-02-07）
- [x] **刷新列表按钮**：前端「刷新列表」改为调用 `POST /api/sync/structure`，成功后 reload 列表；429/409 时提示冷却/锁占用。（2026-02-07）验收：FB 新建/改名对象点刷新后可搜到。
- [x] **三层结构镜像（2026-02-13）**：structure_campaigns + structure_adsets 表（迁移 023/024）；syncAccountStructureAds 同锁/冷却下分页拉 campaigns→adsets→ads；`GET /api/structure/:level` 三层均查库、0 FB 列表调用；`GET /api/structure/resolve` 支持 campaign/adset/ad 三类（返回 type 字段）。验收：见 `docs/结构镜像_三层查库_验收步骤.md`。
- [x] **前端状态筛选 include_paused（2026-02-13）**：RuleManager.vue 将 scopeIncludePaused、onScopeStatusChange 纳入 setup return；onScopeStatusChange 调用 refreshScopeItems；facebookApi.getStructureObjects 增加 include_paused 参数并传给后端。验收：控制台无 scopeIncludePaused 报错；切换「包含暂停」后列表正确；请求带 include_paused。
- [x] **结构索引方案 B（2026-02-13）**：structureSyncService.listStructureObjectsFromDb(accountId, { type, q, limit, after, include_paused })；GET /api/structure/objects（须注册在 /api/structure/:level 之前）；facebookApi.getStructureObjectsUnified(type, accountId, opts)；统一返回 id/type/name/campaign_id/adset_id/effective_status/account_id。验收：见 `docs/结构索引_方案B_统一接口说明.md`。

- **顺序2 实施约束/自检（落地时必守）**
  - **after 游标语义**：改成查库后 `paging.after` 须为可用的游标，约定为「base64(JSON)」或「最后一条的 (name,id)」等稳定游标；**禁止用 OFFSET 分页**（大表会抖、越翻越慢）。
  - **resolve 同 ID 多类型边界**：前端 resolve 当前只传 ids 不传 level。落地时二选一：① 后端按 ads/adsets/campaigns union 查并返回 `type` 字段；② 前端 resolve 调用改为带 `level`。否则同 id 可能命中多表、难以判断，建议一次性规范。
  - **effective_status vs status 口径**：选择器默认过滤**基于 effective_status**（更接近是否可投放/可操作）。结构镜像表里明确：**用于过滤的字段**与**用于展示的字段**，避免写了 status 但过滤用 effective_status 造成混乱。
  - **首次全量回填与可观测**：结构镜像表上线后必须有「首次全量同步」路径（否则 DB 空、选择器无数据）。实现时确保：系统启动后第一次同步能跑完；日志或健康接口能看见每账户 **last_synced_at + 数量 + 耗时 + 失败原因**。

- [x] 前端：在规则编辑界面中，支持配置多个条件（metric/operator/value/time_window），并选择逻辑运算符（AND/OR）。验收示例：能配置 `spend > 1.5 AND link_clicks = 0` 并触发执行；能配置 `link_clicks > 0 AND cpc > 0.8` 并触发执行。（2026-02-12 文档同步：2.3.1 阶段 2～3 已实现 whenLines 线性列表、AND/OR 下拉、添加/删除条件）验收示例：能配置 `spend > 1.5 AND link_clicks = 0` 并触发执行；能配置 `link_clicks > 0 AND cpc > 0.8` 并触发执行。（2026-02-12 文档同步：2.3.1 阶段 2～3 已实现 whenLines 线性列表、AND/OR 下拉、添加/删除条件）
- [x] 前端：增加预设 JSON 模板（止损、扩量、空耗）快捷按钮，点击后自动填充典型规则组合。（2026-02-07 已改为 v2 输出）
- [x] **3 个规则模板（stop_loss/scale_up/zero_click）**：已改为 v2 结构输出；① **止损（stop_loss）**：`spend > 20 AND roas < 0.5` (today) → pause_ad；② **扩量（scale_up）**：`roas > 2` (last_3_days) → increase_budget；③ **空耗（zero_click）**：`spend > 0.5 AND link_clicks = 0` (today) → pause_ad。验收：点模板后进入 JSON 模式，conditions 为 `{ version: 2, groups: [...] }`，保存后为 v2 规则。（2026-02-07）
- [x] **前端口径提示/防呆**：当用户选择 cpc/ucpc/cpa/roas 等比值指标且未同时配置对应分母条件（如 link_clicks > 0 / purchases > 0 / spend > 0）时，给出提示：「当点击为 0 时 CPC 为空，建议加条件 link_clicks > 0，或改用空耗模板（spend > X AND link_clicks = 0）」。验收：创建仅 `cpc > 0.8` 时 UI 会提示并推荐模板；可不强制阻断保存（或按产品决定是否阻断）。（2026-02-12：RuleManager 增加 ratioMetricTip 计算属性，条件区显示蓝色提示框 + 改用空耗模板按钮）

- **比值类指标 + 模板 实现对齐自检（落地时必守）**
  - **字段名对齐**：规则条件里的 metric 与后端给 RuleEngine 的数据字段**完全一致**（如 `link_clicks` / `unique_link_clicks` / `purchases` / `spend` / `cpc` / `ucpc` / `roas` / `cpa`）。重点检查 **link_clicks** 全链路同名，禁止 `inline_link_clicks`、`clicks`、`linkClicks` 混用。
  - **比较器语义对齐**：规则引擎对 **null/undefined** 的比较结果恒为 **false**（gt/gte/lt/lte/eq 全 false），且**不把 null 当 0**；确认没有任何地方做「spend 兜底成 cpc」等伪造比值逻辑。
  - [x] **ROAS 统一口径（方案 A，2026-03-02 定稿）**：规则判断**一律用本地计算**。单日：`ruleDataService.calculateSingleDayMetrics` 仅用 `purchase_value/spend`（spend=0→null，有花费无转化→0），**不再使用** DB/Facebook 的 roas 字段兜底；多日：`aggregateMultiDayMetrics` 已为总分子/总分母，与单日一致。parseActions 保守防双算、extractPurchaseValue 白名单扩展；Warn 限流（每 syncSessionId 1 条）。
  - **模板可验收性**：用**同一条广告**分别验证两条规则，证明「坏 vs 空」拆分落地：① **空耗**：`spend > 1.5 AND link_clicks = 0` 能触发 pause；② **贵点击**：`link_clicks > 0 AND cpc > 0.8` 能触发 pause。

- [x] 前端：在显著位置增加免责提示文案，提醒用户在 FB 后台手动开启被系统关闭的广告前，应先在本系统暂停相关规则。（RuleManager 顶部已有 disclaimer-banner）
- [x] 前端：规则管理接入后端规则 API（/api/rules CRUD + toggle）。（RuleManager 已使用 fetch('/api/rules') 做增删改查及 toggle，数据持久化到 DB；src/services/ruleEngine.js 的 localStorage 为遗留未引用）
- [x] 前端：规则编辑新增 Dry Run（is_simulation）开关，并持久化到后端字段。（RuleManager 已有开关，rules API 读写 isSimulation；rules.test.js 已覆盖）
- [x] 前端：规则编辑新增目标层级 target_level 与目标IDs。（RuleManager 已有 targetLevel=ad/adset/campaign、targetIds 多选，从 structure_ads 查库+搜索）
- [x] 前端：规则编辑“作用对象”改为可选（账户 -> 层级 -> 多选列表，支持搜索）。（同上，选择目标对象可多选+搜索）
- [x] 前端：触发条件时间窗口支持 Today/Yesterday/Last 3 Days/Lifetime。（whenTimeWindow 支持 today/yesterday/last_3_days/lifetime/custom_range）

### 2.4 规则执行层读操作合并（RuleEngineDispatcher）

- [x] 后端：新增 `RuleEngineDispatcher`（或在现有规则执行入口中抽象同名模块），在每次规则扫描时按账户与目标层级一次性调用 `ruleDataService` 拉取该账户下所有目标对象的最新指标数据，缓存到内存。（2026-02-11：`server/services/ruleEngineDispatcher.js`，`loadDataForAccount` + `evaluateRuleWithCache`；cronService 使用 dispatcher 合并读）
- [x] 后端：调整规则评估流程，禁止每条规则单独访问数据库；改为在内存中遍历同一份数据，依次套用多条规则（合并同类项，避免重复查询）。（同上：`collectAllMatchesForAccount` 先 `loadDataForAccount` 再逐规则 `evaluateRuleWithCache`）
- [x] 后端：为 `RuleEngineDispatcher` 增加基础观测指标（每轮扫描的数据库查询次数、命中规则数、平均评估耗时），写入应用日志，便于评估合并收益。（同上：本轮回询 数据K次、目标解析、规则数、命中规则数、评估耗时 打 info 日志）
- [x] 测试：构造一个账户下包含多条规则的场景，验证规则引擎在一轮扫描中只对每个账户/层级执行 1 次核心数据查询，且判定结果与逐条查询模式一致。（2026-02-11：`server/tests/ruleEngineDispatcher.test.js` 两用例通过）

### 2.5 广告系列层级与 CBO 预算支持（2026-02-12 已落地）

- [x] 后端/DB：`ad_snapshots` 增加 `campaign_id` 列（迁移 020）；Today 同步写入 campaign_id
- [x] 后端/DB：`daily_stats` 增加 `campaign_id` 列（迁移 021）；归档与按日写入带 campaign_id；回填历史（迁移 022）
- [x] 后端：规则引擎按 campaign_id 筛选目标广告；ruleDataService 查询与返回含 campaign_id；calculateSingleDayMetrics、aggregateMultiDayMetrics 带出 campaign_id
- [x] 后端：执行层 ABO/CBO 智能路由（getAdsetBudgetDetail 有预算走 ABO，无则走 CBO；updateAdsetBudget/updateCampaignBudget 用 POST body）
- [x] 后端：resolve 回显在 structure_ads 未命中时用 ad_snapshots 兜底 name
- [x] 前端：RuleManager 存在增减预算时展示 CBO 说明框
- [x] 验收：today + last_3_days + 广告系列 + CBO 增减预算执行成功；详见 `docs/规则管理_广告系列与CBO_整体验证清单.md`
- [x] **规则目标解析改造（2026-02-13）**：campaign/adset → ad_id 从 ad_snapshots 改为 **structure_ads**（ruleEngineDispatcher.js + index.js）；未指定 target 时「账户下全部广告」也从 structure_ads 查。验收：同一 campaign/adset 解析出的 ad_id 数量 ≥ 之前、规则不再 0 匹配；ad 级别规则不变。

### 2.5.1 campaign_id/ad_set_id 写入时补齐与历史回填（2026-02-13）

- [x] **写入时补齐**：ingestorService 新增 fillCampaignAdsetFromStructure(accountId, items)；同步 Today 入队前、updateDailyStatsFromInsights 写 daily_stats 前调用；从 structure_ads 补齐 item.adset_id/campaign_id；IN 查询按 500 分批。
- [x] **历史回填**：迁移 025_backfill_campaign_adset_from_structure.sql；ad_snapshots/daily_stats 最近 7 天、campaign_id 或 ad_set_id 为空（含空串）用 structure_ads 回填；SET 用 COALESCE(NULLIF(TRIM(...),''), a.xxx)；建议先单账号验收。
- [x] **验收口径**：见 `docs/验收口径_campaign_adset_补齐与回填.md`；规则管理清单第七节引用。

### 2.5.2 多账户规则 target_by_account 优化与验证（2026-02-14）

- [x] **evaluateRule 无目标账户不查全量**：当规则存在 `target_by_account` 且当前 `accountId` 不在其 key 中时，设 `targetAdIds = []`，不再对该账户查全量广告（server/index.js）。
- [x] **getRuleAccountIds / ruleAppliesToAccount 口径一致**：优先从 `target_by_account` 取账户列表；仅保留「value 为非空数组」的账户；空数组视为该规则不适用于该账户，不加锁、不执行（cronService.js）。
- [x] **objects/multi 响应 meta 增强**：GET /api/structure/objects/multi 在返回的 `meta` 中增加 `per_account_limit`、`has_more`，便于前端分页与每账户上限展示（server/index.js）。
- [x] **前端 refreshScopeItems**：在「仅启用」且列表加载完成后，从 `ruleForm.targetIds` 中移除不在当前 `scopeItems` 的 id，避免保留已关闭广告（RuleManager.vue）。
- [x] **验证文档**：`docs/Thunder_Client_小白验证步骤.md`（登录拿 token → GET objects/multi 带 Query 与 Authorization → 检查 meta.per_account_limit、meta.has_more）；可选验证空数组账户不执行（改 DB 后看后端日志）。

### 2.5.3 多账户 multi 优化与监控范围完善（2026-02-24 规划）

> 依据：`docs/采纳清单与具体修改说明.md`。防恢复守护不采纳；Smart Mute 保持现状，说明见 `docs/多账户与Mute与防恢复守护_说明.md`。  
> **2026-02-26**：五项已落地并验收通过，见 `docs/采纳项验证与测试指南.md`。  
> **相关文档**：`docs/采纳项落地_知识点与教学说明.md`（概念与实现要点）、`docs/采纳项代码核对与修改优化计划.md`（核对与修改清单）、`docs/下一步与可选完善.md`（下一阶段与可选优化）。

- [x] **multi 接口 account_ids 上限 + 管理员放宽**：在 `GET /api/structure/objects/multi` 得到 allowedIds 后校验 `allowedIds.length <= maxAccounts`（非管理员 20、管理员 50），超限返回 400、code: TOO_MANY_ACCOUNTS。
- [x] **multi 首轮 p-limit(4)**：首轮无 after 时用 p-limit(4) 并发调用 listStructureObjectsFromDb，按 index 顺序合并 perAccountAfter 与 allItems；依赖 `p-limit`（package.json 若无则添加）。
- [x] **名称类条件大表优化**：原则+索引确认+文档；在 structureSyncService 三个 list 方法 WHERE 构建处增加注释（先 account_id + effective_status，再 name 条件）；文档已注明名称包含/不包含大表较贵（见 `docs/监控范围条件_后端SQL过滤与优先展示方案.md`）。
- [x] **状态不等于（scope_status_exclude）**：后端 structureSyncService 三个 list 方法支持 `opts.scope_status_exclude`（逗号分隔），在 statusList 计算后过滤排除状态；listStructureObjectsFromDb 与单账户/multi 路由透传 `scope_status_exclude`；前端 RuleManager 新增 scopeStatusExcludeFilter，applyScopeConditions 根据状态行 operator 为 equals/not_equals 分别设置 scopeStatusFilter 与 scopeStatusExcludeFilter，列表请求带 scope_status_exclude。
- [x] **监控范围条件「创建时间段」**：按 `docs/0监控范围条件[创建时间段]—执行方案.md`：后端 structureSyncService 三 list + listStructureObjectsFromDb 支持 scope_created_within_hours（created_time >= 当前时间 − N 小时）；index.js 结构列表路由透传；前端 facebookApi getStructureObjects/getStructureObjectsMulti 传参；RuleManager 字段下拉增加「创建时间段」、操作符固定「包含」、值列 24/48/72 + 自定义 1–720 小时、校验与 applyScopeConditions/refreshScopeItems/loadMoreScopeItems 带参、多行取 min 小时。文档 `docs/监控范围条件_后端SQL过滤与优先展示方案.md` 已更新。验收：单账户/多账户、名称+创建时间段组合、SQL 核对通过。（2026-02-28 已落地）
- [x] **验收**：按采纳清单文档「五、验收要点」执行（上限 400、p-limit 首屏变快、状态不等于列表与 SQL 一致、名称类注释与文档）。

### 2.5.4 动态筛选多账户闭环（2026-03-07 完成）

> 目标：在“多选广告账户 + 手动筛选 + 动态筛选”场景下，确保刷新、快照、执行三层都按账户隔离且语义一致，最终口径固定为 `finalAdIds = (dynamicMatched ∪ manualTarget) - excludeIds`。

- [x] **策略 B 修复（oversize 保留旧快照）**：`dynamicScopeService` 从“按账户全删重建”改为“仅 `NORMAL` 规则按 `rule_id + account_id` 原子替换”；`ERROR_OVERSIZE/ERROR_FILTER_INVALID/ERROR_REFRESH_FAILED` 仅更新规则状态，不清快照。
- [x] **执行口径统一**：`executeSingleRule` 改走 Dispatcher（`loadDataForAccount + evaluateRuleWithCache`），与定时调度同口径读取 `rule_matched_objects(rule_id, account_id)`。
- [x] **前端闭环（RuleManager）**：新增动态筛选开关（默认开启）、动态上限、状态展示、TriggerC 手动重算按钮、排除名单配置与回显；规则卡片补充排除摘要并去掉技术型错误原文，保留运营可理解状态标签。
- [x] **多账户动态刷新闭环**：
  - TriggerB：规则保存后按规则涉及账户逐个防抖刷新；
  - TriggerC：传 `ruleId` 时自动解析并刷新该规则全部目标账户，返回 `accountResults` 汇总；
  - TriggerA：保持账户级入口不变（兼容既有调度路径）。
- [x] **多账户隔离修复**：动态计算手工目标支持 `targetIds` 的 `act_xxx:id` 解析，确保只使用当前账户目标，避免跨账户串值。
- [x] **删规则联动清快照**：删除规则时事务内同步删除 `rule_matched_objects`，避免孤儿数据。
- [x] **观测性增强**：动态刷新日志新增 `trigger` 与结构化汇总字段：`processed/normal/inserted/oversize/invalid/refresh_failed/duration_ms`。
- [x] **自动化测试补齐**：
  - `server/tests/ruleEngineDispatcher.test.js`：新增“快照优先覆盖 targetIds”与“act:id 账户隔离”用例；
  - `server/tests/dynamicScopeService.helpers.test.js`：新增规则目标账户解析与 scoped targetIds 解析用例；
  - `server/tests/rules.test.js`：新增“删除规则联动清快照”断言。
- [x] **手工验收结果（本窗口）**：
  - 场景 A：TriggerB 在多账户规则保存后，两个账户各出现一条防抖刷新日志；
  - 场景 B：TriggerC 仅传 `ruleId` 返回多账户 `accountResults` 汇总；
  - 场景 C：A 超限、B 正常时，账户级结果互不污染，规则级汇总状态为 `ERROR_OVERSIZE`；
  - 场景 D：执行与快照一致，单条执行不跨账户串目标。

### 2.6 执行频率与执行时间（适配方案）（2026-02-28 完成）

> 依据：`docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md`。规则执行由「每分钟 Cron」统一驱动，不再由数据同步心跳顺带触发；广告级冷却、允许执行时间段、单条执行保留，「立即运行所有规则」已移除。

- [x] **阶段一：迁移与 Schema**：rules 表新增 `execution_interval_minutes`（INT NULL DEFAULT 15）、`execution_time_windows`（JSON）；新建表 `rule_ad_execution_state`（rule_id, ad_id, last_executed_at, last_status）；迁移 027、028；schema.js 已同步。**后续**：迁移 031 将冷却表主键改为 (rule_id, scope_key)，见 §2.6.1。
- [x] **阶段二：心跳中移除规则触发**：unifiedHeartbeatSync 内移除 setImmediate 调用 executeRulesForAccount；规则执行仅由每分钟 Cron 驱动。
- [x] **阶段三：Cron 与 executeRulesForAccount 改造**：fromScheduler=true 时读写 rule_ad_execution_state、按 execution_interval_minutes 做广告级冷却；单条执行（executeSingleRule）不参与冷却表。
- [x] **阶段四：执行时间段与摘要**：isInExecutionWindow（北京时间）校验；不在时间段内记 skip_reason=outside_execution_window、更新冷却表避免重复触发。
- [x] **阶段五：移除 Smart Mute 执行路径**：actionExecutorService 内移除 mute_until 跳过逻辑；保留 mute_until/mute_reason 字段与 clear-ad-mute.js 脚本用于历史排查；smartMute.test.js 改为历史逻辑与格式兼容测试。
- [x] **阶段六：移除 execute-all**：删除 POST /rules/execute-all 路由；删除前端 executeAllRulesOffline；废弃接口 POST /api/execute-rules 文案改为「单条请用 POST /api/rules/:id/execute」；测试脚本文案更新。
- [x] **阶段七：API 与前端**：规则创建/更新/查询支持 execution_interval_minutes、execution_time_windows；前端编辑表单「5. 执行频率与执行时间」、列表卡片展示「执行频率」「执行时间」短文案；单条「运行此规则」保留。
- [x] **前端修复（保存后回显）**：RuleManager.vue 的 normalizeRule 补全 executionIntervalMinutes、executionTimeWindows，避免保存后再编辑恢复默认值。
- **API 约定**：规则更新使用 **PUT /api/rules/:id**，可只传需改字段（如执行间隔、执行时间段）；**不支持 PATCH 更新规则体**，PATCH 仅用于 `/api/rules/:id/toggle`。

### 2.6.2 24小时制时间段选择与UI优化（2026-03-13 完成）

> 依据 `.cursor/plans/24小时制时间段选择与ui优化_56fa7594.plan.md`。取消 AM/PM，统一 24 小时制，优化「允许执行时间」区块布局与风格。

- [x] **TimePicker24 组件**：`src/components/TimePicker24.vue`，时 0–23、分 0–59 双 select，modelValue 为 `"HH:mm"`，emit 补零；样式与项目 `.select` 一致。
- [x] **RuleManager 接入**：指定时间段时用两行「开始时间」「结束时间」各接 TimePicker24；说明文案单独成行（.execution-time-range / .execution-time-hint）。
- [x] **跨日展示**：formatExecutionTimeDisplay 对跨日时段显示「开始–次日 结束」（如 20:00–次日 05:00）。
- [x] **执行时间段后端修复**：`isInExecutionWindow` 对 `execution_time_windows` 为字符串时 JSON.parse，解决 Drizzle/MySQL JSON 列返回字符串导致始终视为全天的问题；单测与 SQL 验证（rule_execution_summaries / rule_ad_execution_state）通过。
- [ ] **可选**：`executeSingleRule` 增加执行时间段校验，使「运行此规则」也遵守 execution_time_windows。

### 2.6.1 预算冷却与 Pre-Flight 重构（scope_key + cooldownKey + 双写）（2026-03-02 前窗口完成）

> 依据：`.cursor/plans/budget-cooldown-and-prefight-refactor_e251157f.plan.md`。目标：统一冷却键抽象、预算「当前=目标」时 Pre-Flight 跳过、预算按目标节点冷却，且**执行频率（execution_interval_minutes）对预算动作真正生效**（避免冷却期内每分钟仍进执行层）。

- [x] **数据层（迁移 031）**：`rule_ad_execution_state` 新增 `scope_key`（VARCHAR(100) NOT NULL），主键从 `(rule_id, ad_id)` 改为 `(rule_id, scope_key)`；历史回填 `scope_key = CONCAT('ad:', ad_id)`；保留 `ad_id` 列作诊断（非 ad: 行可写空串）；Drizzle schema 已同步。
- [x] **冷却状态服务**：新增 `server/services/ruleExecutionStateService.js`，提供 `loadRuleAdExecutionState(ruleId, scopeKeys)`、`isCooldownDue(ruleId, scopeKey, intervalMin)`、`upsertRuleAdExecutionStateBatch(entries)`；cronService 与执行层复用。
- [x] **执行层 cooldownKey**：`actionExecutorService.executeActionsForAd` 对 pause_ad/activate_ad 设 `cooldownKey = "ad:" + adId`；对预算 ABO 设 `cooldownKey = "budget_adset:" + adsetId`、CBO 设 `cooldownKey = "budget_campaign:" + campaignId`；在返回的 results 中携带 `cooldownKey` 供调度层写冷却表。
- [x] **预算 Pre-Flight（当前=目标跳过）**：在 ABO/CBO 分支中，若非 Dry Run 且 `currentCents === newBudgetCents`，记 status=skipped、不调 FB API、仍写审计日志；所有 skipped（含 Pre-Flight、FB already in state）在冷却上按 success 占冷却。
- [x] **调度层双写（关键）**：`cronService.executeRulesForAccount` 在 fromScheduler 时，用执行层返回的 cooldownKey 写入一条 `(ruleId, scopeKey, lastStatus)`；**若 cooldownKey ≠ "ad:"+adId**，再额外写入一条 `(ruleId, "ad:"+adId, lastStatus)`。**修改前**：预算动作只写 `budget_campaign:`/`budget_adset:`，调度层过滤用的是 `scopeKey = "ad:"+adId`，查不到最近执行时间，导致冷却期内每分钟仍把该规则+广告送进执行。**修改后**：同时写入 ad: 冷却，下一轮 Cron 广告级过滤能正确挡住，15 分钟内不再重复执行。
- [x] **验收**：同一规则预算执行后，`SELECT rule_id, scope_key, ad_id, last_status, last_executed_at FROM rule_ad_execution_state` 可见该 rule_id 下既有 `budget_campaign:`/`budget_adset:` 也有 `ad:` 两条；15 分钟内 Cron 不再对该规则+该广告重复执行（日志不再每分钟出现 GET 预算/Pre-Flight）。
- [ ] **可选/待办**：单元测试与集成场景（Pre-Flight、scopeKey 冷却、多规则互不干扰）；执行层预算分支内 `isCooldownDue(ruleId, cooldownKey, intervalMin)` 精细冷却（决定单条手动执行是否也遵守冷却，可单独讨论）。

> **落地顺序**：步骤 1+6 → 步骤 2 → 步骤 3 → 步骤 4 → 步骤 5。**硬口径**：run_id 采用加列（automation_logs 增加 run_id 列）；冷却采用评估即冷却。Pre-Flight **不新增**对每个广告额外 GET FB，仅用本地快照 status + FB 返回的 already-in-that-state 容错。完整说明见 `docs/M4_动作执行层落地步骤.md`；**仅按本清单执行即可完成 M4 全部落地**。

### 3.0 开工前口径（动代码前必读）

- [x] 口径已落实：动作优先级 tie-break 写死——**pause_ad 优先于 activate_ad**（数字：pause_ad=1, activate_ad=2, decrease_budget=3, increase_budget=4）；每条规则内部只取「最狠一条 action」参与仲裁；同优先级同动作类型去重时赢家为 **ruleId 最小者**。（`server/utils/actionPriority.js` + `cronService.arbitrateByAdId`）
- [x] 口径已落实：**run_id 采用加列**——给 `automation_logs` 增加 `run_id` 列并迁移（`server/db/migrations/013_add_run_id_to_automation_logs.sql`）；执行动作时写入当前 runId（`actionExecutorService.executeActionsForAd`）；验收用 `SELECT run_id, ad_id, COUNT(*) ... GROUP BY run_id, ad_id` 断言每对 (run_id, ad_id) 最多 1 条。
- [x] 口径已落实：**冷却采用评估即冷却**——只要规则在本轮被评估就更新 `last_executed_at`；汇总前**按用户权限过滤**，仅把对该 account 有访问权的用户的规则纳入汇总，无权规则不调用 evaluateRule、只写 no_permission 摘要。（`cronService.executeRulesForAccount`）

### 3.1 步骤 1+6：按广告仲裁 + 摘要/冷却（已实现，待本机验收）

- [x] 后端/DB：`automation_logs` 表增加 `run_id` 列（VARCHAR(100)），迁移脚本见 `server/db/migrations/013_add_run_id_to_automation_logs.sql`；**若未执行过需先执行一次**。
- [x] 后端：`cronService.executeRulesForAccount` 已重构为「先按用户权限过滤 → 汇总该 account 下所有 cooled-down 规则（跨 user）→ 全量评估 → 按 ad_id 仲裁 → 再执行」；无权用户规则只写 no_permission 摘要并跳过。
- [x] 后端：已实现 `collectAllMatchesForAccount(ruleEngine, allRulesForAccount, lockedAccountId)`，返回 `Array<{ rule, matchedAds }>`。
- [x] 后端：仲裁前将每规则每 ad 压成「一条候选动作」（`pickSingleCandidateAction`）；已实现 `arbitrateByAdId(matchesPerRule)`，输出 `Map<ad_id, { winnerRule, winnerAction, matchedAd, suppressedRules }>`；每个 ad_id 固定用 winner 的 matchedAd，执行层始终用同一份。
- [x] 后端：`server/utils/actionPriority.js` 中 ACTION_PRIORITY：pause_ad=1, activate_ad=2, decrease_budget=3, increase_budget=4；同优先级赢家为 ruleId 最小者。
- [x] 后端：已实现 `writeSummariesAfterArbitration(...)`，按规则写摘要；支持同一规则一行内既有 executed_count/failed_count 又有 skip_details.suppressed_for_ads；被压制规则写 skip_reason=suppressed_by_priority、skip_details.suppressed_for_ads。
- [x] 后端：本轮被评估的规则（含被压制）均调用 `updateRuleLastExecutedAt`；摘要 skip_reason 已支持 `suppressed_by_priority`、`muted`。
- [x] 后端：`actionExecutorService.executeActionsForAd` 已支持 `actionsOverride`；执行时 matchedAd 来自仲裁输出（含 status、ad_set_id、mute_until、mute_reason）。
- [x] 验收：① 迁移 013 已执行、run_id 有值；② 同一 run_id 下同一 ad_id 在 automation_logs 仅一条记录（HAVING cnt>1 为空）；③ suppressed_by_priority 可查且 skip_details 含 suppressed_for_ads；④ 冷却与评估即冷却一致。（2026-02-10 本机 SQL 验收通过）

### 3.2 步骤 2：预算幂等（重试不二次叠加）（已实现，2026-02-10）

- [x] 后端：`actionExecutorService` 预算分支——若调用方传入「已算好的 newBudgetCents」（action 副本 `_resolvedBudgetCents`），不再调用 `api.getAdsetBudget`，直接用该值 POST；Dry Run 不调 GET/POST。
- [x] 后端：调用方（cronService）对预算类动作在执行前**预计算一次**：`resolveNewBudgetCentsForAction(api, adsetId, action)` → 传 `{ ...winnerAction, _resolvedBudgetCents }`；执行层收到后不再 GET。
- [x] 后端：已实现 `computeNewBudgetCentsOnce(currentBudgetCents, action)`（分、MIN_BUDGET_CENTS=100、max_daily_budget 护栏）；并导出 `resolveNewBudgetCentsForAction(api, adsetId, action)` 供 cron 预计算。
- [x] 验收：单测已覆盖；Dry Run 无 GET；真实增/减预算各一次、FB 后台确认、每轮 1 次 GET+1 次 POST，无重试重复增减。（2026-02-10 本机验证通过）

### 3.3 步骤 3：Pre-Flight（本地 status + FB already-state 容错）

- [x] 后端：Pre-Flight **不新增**对每个广告的 GET FB；仅用本地 `ad_snapshots.status` 判断「目标已达成则 skipped」，以及 FB 返回的「already in that state」类错误容错为 skipped/success。（actionExecutorService.js 已实现）
- [x] 后端：执行 pause_ad 前，若 `matchedAd.status` 属于「目标已达成」集合（**别只认 PAUSED**：含 PAUSED、DISABLED、ARCHIVED 等），直接记 status=skipped、不调 api.pauseAd（实现时注意 1）。
- [x] 后端：执行 activate_ad 前，仅对「可激活」状态尝试激活；若为 ARCHIVED 等不可激活状态，直接 skipped 并写原因（实现时注意 1）。
- [x] 后端：执行 pause_ad/activate_ad 时，catch FB 返回错误，若文案含 "already" / "duplicate" 或平台约定错误码，置 status=skipped 或 success，并写 apiResponse 说明。
- [x] 后端：`ruleDataService.queryAdSnapshots` 已选 status；`RuleEngine.evaluateRule` 构建 matchedAd 时把 `adData.status` 写入 matchedAd（若当前未带则补上）。
- [x] 验收：按 `docs/M4_3.3_PreFlight_验收步骤.md` 执行（场景一：本地 status=PAUSED 则 skipped、无 pauseAd）。本机 2026-02-11 通过。

### 3.4 步骤 4：Smart Mute 数据链路（已实现，2026-02-28 执行路径已移除）

- [x] 后端：`ruleDataService.queryAdSnapshots` 已选 `mute_until`, `mute_reason`；RuleEngine 构建 matchedAd 时已写入。
- [x] **2026-02-28 变更**：Smart Mute **执行路径已移除**（actionExecutorService 不再根据 mute_until 跳过执行）；**保留** mute_until/mute_reason 字段与 clear-ad-mute.js 脚本用于历史排查与只读展示；摘要层仍兼容 skip_reason=muted。详见 `docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md` 与 `docs/阶段五与阶段六_知识点与教学说明.md`。
- [x] 此前：actionExecutorService 入口检查 mute、cronService 仲裁循环过滤 mute 并写 ruleToMuted；单条规则全部因 mute 跳过时写 skip_reason=muted。（本机 2026-02-10 验收通过）

### 3.5 步骤 5：预算单位统一为「分」（已实现并验收，2026-02-10）

- [x] 后端：`actionExecutorService` 内 MIN_BUDGET_CENTS、computeNewBudgetCentsOnce、getAdsetBudget 返回/updateAdsetBudget 入参均为「分」；FB 封装层（server/index.js）**向 FB API 传「分」**（daily_budget 为账户最小货币单位），对上游暴露「分」。
- [x] 后端/约定：rules.actions[].max_daily_budget 单位为「分」；schema 注释已注明（server/db/schema.js）。**语义**：预算上限仅对「增加预算」有意义；减预算若需可后续加「预算下限」字段。
- [x] 文档/前端：后端预算一律「分」已落实；前端当前仅动作类型（增加/减少预算），无预算数值展示，后续若有展示需除以 100。
- [x] 验收：`npm test -- --run server/tests/budgetUnitCents.test.js` 20 用例通过；实盘增加预算 + 上限 → POST daily_budget=1050（分）→ 200 OK。（本机 2026-02-10 验收通过）

### 3.5.1 预算调整按值增减（value_unit=usd）（2026-02-13 已落地）

- [x] 后端：`actionExecutorService` 支持 `value_unit`：percent（默认）按百分比增减，usd 按固定美元增减；usd 时 value 为美元，`delta = Math.round(value*100)` 分；decrease+usd 下限护栏 >= MIN_BUDGET_CENTS。
- [x] 后端：`templateValidator` 扩展 actions 校验：value_unit 仅 percent|usd；usd 时 value 必填、0.01–9999、最多两位小数；percent 时 value 1–100 整数；`validateActions` 导出供 rules 路由复用。
- [x] 后端：rules 路由 POST/PUT 对 actions 调用 `validateActions`，避免脏数据写入。
- [x] 前端：RuleManager.vue、AdminTemplates.vue 执行动作区增加单位选择（百分比/固定金额）；percent 显示 %，usd 显示 $；预算上限（美元）两种模式均支持；actionLabel/formatBudgetValue 按 value_unit 展示。
- [x] 验收：`npm test -- --run server/tests/budgetUnitCents.test.js` 含 usd 用例通过；规则/模板新建编辑、保存、执行日志与审计日志含 value_unit。

### 3.5.2 预算直接设置为固定值（set_budget）（2026-02-13 已落地）

- [x] 后端：新增动作类型 `set_budget`，语义为「将预算直接设置为固定美元值」；`computeNewBudgetCentsOnce` 增加 set_budget 分支：`targetCents = Math.round(value*100)`，应用 MIN_BUDGET_CENTS 下限与 max_daily_budget 上限。
- [x] 后端：`resolveNewBudgetCentsForAction` 遇到 set_budget 不 GET 当前预算，直接计算返回（避免多余 FB 调用）。
- [x] 后端：`templateValidator` 增加 set_budget 校验：value_unit 仅允许 usd（拒绝 percent）；value 0.01–9999、最多两位小数。
- [x] 后端：cronService、actionPriority 纳入 set_budget（优先级 5）。
- [x] 前端：RuleManager.vue、AdminTemplates.vue 动作下拉增加「设置预算为固定值」；选择 set_budget 时单位固定 $、无 percent/usd 切换。
- [x] 验收：`npm test -- --run server/tests/budgetUnitCents.test.js` 含 set_budget 用例通过；规则/模板新建 set_budget、保存、执行日志显示「设置为 $30」。

### 3.5.3 预算动作护栏与前端精简（2026-03-04 完成）

- [x] 后端：在 `server/utils/templateValidator.js` 中为预算动作新增上下限字段口径：
  - `increase_budget` 仅允许 `max_daily_budget`（单位分，整数，`>=100`），禁止 `min_daily_budget`。
  - `decrease_budget` 仅允许 `min_daily_budget`（单位分，整数，`>=100`），禁止 `max_daily_budget`。
  - `set_budget` 禁止配置上下限字段；同一动作同时配置 max/min 直接视为无效配置。
  - 小于 100 分或非整数的上下限一律校验失败，前端给出明确错误提示。
- [x] 后端：完善 `server/services/actionExecutorService.js` 中 `computeNewBudgetCentsOnce` 预算语义：
  - `increase_budget`：若 `current > max_daily_budget`，本轮保持不动；否则按步长增量并以 `max_daily_budget` 封顶。
  - `decrease_budget`：若 `current <= min_daily_budget`，本轮保持不动；否则按步长减量并以 `min_daily_budget` 托底（同时不低于 `MIN_BUDGET_CENTS=100`）。
  - `set_budget`：仅上调不下调——当 `current >= target` 时保持不动，否则设置为目标值（应用全局最小预算与可选上限）。
- [x] 后端执行层：`executeActionsForAd` 预算 Pre-Flight 跳过原因细分：
  - `increase_budget` 在「当前 > 上限」场景下返回 `skip_reason=above_max_cap`。
  - `decrease_budget` 在「当前 <= 下限」场景下返回 `skip_reason=below_min_floor`。
  - 其它 `currentCents === newBudgetCents` 场景统一返回 `skip_reason=budget_already_at_target`。
  - 审计日志中的 `errorMessage`、`apiRequest/apiResponse` 带上上述 reason，便于排查。
- [x] 测试：补充预算护栏与 Pre-Flight 单元测试：
  - `server/tests/budgetUnitCents.test.js` 新增「超上限不动」「下限托底/下限以下不动」「set_budget 仅上调不下调」等用例。
  - `server/tests/templateValidator.test.js` 新增上下限组合与边界值校验用例。
  - 新增 `server/tests/budgetPreFlightReason.test.js`，验证 `above_max_cap` / `below_min_floor` / `budget_already_at_target` 三类跳过原因。
- [x] 前端：RuleManager.vue 动作编辑 UI 精简与字段归一：
  - `increase_budget` 仅显示「预算上限（美元，可选）」；`decrease_budget` 仅显示「预算下限（美元，可选）」；`set_budget` 不显示上下限输入。
  - 新增 `onMinBudgetInput`，负责「下限（美元）→ 分」转换；`onActionTypeChange` 在动作切换时清理无关字段（increase 清 min、decrease 清 max、set_budget 清上下限）。
  - `saveRule` 前端校验：上限/下限必须为整数分且 `>=100` 分；`actionsPayload` 仅对 increase 透传 `max_daily_budget`、对 decrease 透传 `min_daily_budget`，set_budget 不再透传上下限字段。
- [x] 前端：AdminTemplates.vue 同步口径改造（不改动模板文案与业务内容）：
  - 动作编辑区与 RuleManager 保持一致的显示与字段行为（increase 显示上限、decrease 显示下限、set 不显示上下限）。
  - 模板编辑仅对预算护栏字段做「按动作类型归一 + 无效值清理」，不修改用户自定义模板的文案与条件逻辑。

- [x] 运行时验证与 bug 修复：实盘 set_budget 规则在「当前预算 10 美元、目标固定值 7 美元」场景下发现预算仍被下调到 7 美元，排查确认根因是 cron 预计算 `resolveNewBudgetCentsForAction` 在 set_budget 分支固定以 `current=0` 调用 `computeNewBudgetCentsOnce` 得到 `_resolvedBudgetCents=target`，执行层 ABO 分支直接沿用该值，未能触发「只上调不下调」语义和 `current===new` 的 Pre-Flight skipped。已在执行层 ABO 路径对 set_budget 特殊处理：总是基于实时 `currentCents` 重新计算 newBudgetCents，从而当 `current>=target` 时返回 current、记为 `budget_already_at_target` 并跳过 FB API 调用，同时仍按成功占用冷却。

### 3.6 实现时注意（做的时候别漏）

- [x] **注意 1**：Pre-Flight 状态等价值——pause_ad 用集合 PAUSED/DISABLED/ARCHIVED 等；activate_ad 仅对可激活状态尝试，ARCHIVED 等直接 skipped，避免误执行/误跳过。（actionExecutorService 已实现；3.3 验收通过）
- [x] **注意 2**：预算幂等若用上下文缓存，actionSignature 包含 type、value、max_daily_budget 及护栏相关，同 key ⇒ 同目标值，避免误复用导致调错预算。（cron 预计算 _resolvedBudgetCents 一次传入，执行层不 GET）
- [x] **注意 3**：仲裁输出每个 ad_id 固定一个 matchedAd 来源，执行层始终用同一份，不在不同规则间混用，避免缺 ad_set_id/status/mute_* 导致失败或误执行。（arbitrateByAdId 约定已落实）

### 3.7 关闭广告规则闭环（下一阶段优先级）

- [x] **pause_ad 真实下发**：pause_ad 在非 Dry Run 下必须真实调用 Facebook API（POST）并成功暂停；验收：以真实广告后台变为 PAUSED 为准，且 automation_logs 与 rule_execution_summaries 有对应记录。（2026-02-06 验证通过）
- [x] **pause_ad Pre-Flight**：本地 status 已达成（PAUSED/DISABLED/ARCHIVED/…）则 skipped，不发 API；仅当 status 为 ACTIVE 等「可暂停」状态时才发 API；不新增 per-ad GET，与 3.3 口径一致。（actionExecutorService.js 已实现）

---

## 4. 反馈与监控层（M5）

### 4.1 审计日志与 Dry Run

- [x] **pause 动作审计必含字段（下一阶段优先级）**：pause 动作写入 automation_logs 时必须含 rule_id、ad_id、action_type、is_simulation、status、skip_reason 或错误信息、metrics_snapshot（至少含 spend/purchases/roas/cpa 中已有项）；验收：单条记录可复盘一次 pause 决策与结果。（2026-02-06 验收通过）
- [x] 后端/DB：确保 `automation_logs` 表结构具备存储：
  - 触发瞬间指标快照（JSON）
  - 动作信息
  - API 请求/响应
  - 状态与错误信息
- [x] 后端：在规则执行路径中接入日志记录：
  - 无论成功/失败/跳过，都写入一条审计日志。
- [x] 后端：支持 `is_simulation`（Dry Run 模式）：
  - 当开启时，只记录日志与通知，不触发真实 API 调用。
- [x] 测试：为 Dry Run 模式行为编写测试，确保不会调用实际修改广告状态的 API。
- [x] **审计可复盘验收（Step 2）**：按 `docs/Step2_审计可复盘_验收步骤.md` 执行三项（① 单条可复盘 ② 两表时间 0～10 秒 ③ 同 run 同 ad 仅一条）；本机验收通过。

### 4.1.1 规则执行摘要（系统层可观测性）（2026-01-28 完成）

- [x] 后端/DB：创建 `rule_execution_summaries` 表，包含 run_id、rule_id、account_id、user_id、owner_id、status、skip_reason、skip_details 等字段
- [x] 后端/DB：创建 7 个联合索引，覆盖常见查询场景
- [x] 后端：实现 `ruleExecutionSummaryService.js`，提供插入摘要、脱敏错误信息、生成 runId 功能
- [x] 后端：在 `cronService.js` 中覆盖所有分支记录摘要（user_not_found/no_permission/account_mismatch/no_match/error）
- [x] 后端：在 `ingestorService.js` 事件触发时生成 runId
- [x] 后端：实现摘要查询接口（`GET /api/rule-execution-summaries` 和 `/stats`），仅 admin 可见
- [x] 后端：修复 skip_details JSON 解析（兼容对象/字符串/Buffer）
  - [x] 兼容 MySQL JSON 列返回的三种情况：对象、字符串、Buffer
  - [x] 实现统一的解析逻辑，避免 JSON.parse 错误
- [x] 后端：修复 evaluated_at 时区转换（显式 UTC 转换）
  - [x] 在 `ruleExecutionSummaryService.js` 中显式将 Date 对象转换为 UTC 时间字符串
  - [x] 避免依赖进程时区，确保时间存储的一致性
- [x] **P1 统一时间字段/时区**：automation_logs.triggered_at 与 rule_execution_summaries.evaluated_at 同一 run_id 时间一致
  - [x] 将 triggered_at 写入改为显式 UTC 时间字符串（与 evaluated_at 同口径）
  - [x] 迁移 triggered_at 从 DATETIME 到 TIMESTAMP（`016_automation_logs_triggered_at_timestamp.sql`）
  - [x] 验收：同一 run_id 在两表时间差 ≤ 1 秒（需执行迁移后验证）（2026-02-10 验收通过）
- [x] **P0 today 同步补齐点击字段**：避免「字段缺失覆盖为 0」导致规则误判
  - [x] 当 API 未返回 inline_link_clicks 时，fallback 到 actions 中的 link_click 计数
  - [x] 增加 unique_actions 请求，unique_inline_link_clicks 缺失时 fallback
  - [x] 验收：FB 后台有点击的广告，规则判断不再因 link_clicks=0 误判（需同步后验证）（已验收通过）
- [x] 后端：优化 LIMIT/OFFSET SQL 参数绑定（方案外优化）
  - [x] 直接拼接整数，不使用占位符（mysql2 在某些情况下对 LIMIT/OFFSET 占位符支持有问题）
- [x] 后端：修复统计接口 WHERE 子句处理（方案外优化）
  - [x] 当 whereClause 为空时，正确拼接 `WHERE skip_reason IS NOT NULL`
  - [x] 避免 SQL 语法错误（缺少 WHERE）
- [x] 测试：SQL 验证摘要写入和 run_id 聚合
- [x] 测试：curl 验证查询接口和权限控制
- [x] 前端：统一时区显示为北京时区（UTC+8）
  - [x] 创建 `src/utils/dateTime.js` 工具模块
  - [x] 使用 Luxon 统一将后端返回的 UTC 时间转换为北京时区（UTC+8 / Asia/Shanghai）
  - [x] 更新 `Logs.vue` 和 `SystemStatus.vue` 使用统一时区工具
  - [x] 确保无论用户浏览器在哪个时区，前端都显示一致的北京时区
- [x] **时区统一（执行日志 + 冷却 + 连接池）（2026-03-04 完成）**
  - [x] **Single Source of Truth**：`server/db/drizzle.js` 不再自建 pool，改为 `import pool from './connection.js'`，Drizzle 与所有 raw SQL 共用同一连接池，读写均在 UTC 会话下执行。
  - [x] **connection.js**：createPool 增加 `timezone: '+00:00'`，与已有 `SET time_zone = '+00:00'` 配合，保证 mysql2 对 Date 的编解码按 UTC，避免执行日志写入/读取出现 8 小时偏差。
  - [x] **执行日志 API**：`server/routes/system.js` 列表与详情接口用 `toUTCISO(triggered_at)`/`toUTCISO(created_at)` 统一返回带 Z 的 UTC ISO 字符串；前端 `parseUTC` 对无 Z 字符串补 Z 后按 UTC 解析再转北京展示。
  - [x] **冷却 debug 日志**：`ruleExecutionStateService.isCooldownDue` 的 debug 日志同时输出 `lastAtUtc`（ISO 带 Z）和 `lastAtBj`（北京时间），便于与本地时间对照。
  - [x] **文档**：`docs/0时区转换解决方案.md` 已补充「已落地规范」「你遇到的两种情况说明」及 SQL 查询说明（北京会话下 `triggered_at` 已是北京时区，勿再 CONVERT_TZ）。
  - [x] **验收**：执行日志前端显示时间与本地北京时间一致；SQL（北京会话）`SELECT triggered_at` 与前端一致；历史数据未迁移（可选后续做）。

### 4.1.2 展示层权限修复与优化（2026-01-28 完成）

- [x] 后端：修复 summary 接口权限控制（使用 users.owner_id 过滤 automation_logs.owner_id）
- [x] 后端：修复详情接口权限控制（使用 users.owner_id 过滤 automation_logs.owner_id）
- [x] 后端：列表接口默认只返回 status=success（非 admin 强制只看 success）
- [x] 后端：include_all_status 参数只对 admin 生效
- [x] 测试：pytest 测试权限控制和展示层过滤（6 passed）

**方案外优化说明**：
- 前端时区统一为北京时区（UTC+8）已在 4.1.1 中完成，确保所有时间展示一致，无论用户浏览器在哪个时区。

### 4.1.3 权限隔离最后一块拼图与单条规则执行（2026-01-29 已完成）

**目标**：消除数据接口 IDOR、健康接口泄露全量账户、execute-all 越权；新增单条规则手动执行。

- [x] 后端：新增统一账户权限校验 `assertAccountAccess(user, accountId)`（admin 放行；非 admin 必须 account_mappings 匹配且 is_active=1，否则 403）
- [x] 后端：在 `/api/ads`、`/api/insights`、`/api/roi`、`/api/rule-data`、`/api/structure/:level` 入口处调用校验，通过后再查库/调 FB
- [x] 后端：`GET /api/system/health` 按角色裁剪——admin 返回所有账户；非 admin 只返回自己 owner_id 下的账户及待处理异常数
- [x] 后端：`POST /api/rules/execute-all` 方案B——非 admin 只跑自己 owner_id 的账户；admin 跑全部（manualExecute 支持传入 ownerId 过滤）
- [x] 前端：系统状态页移除「手动触发规则执行」按钮（触发点只保留规则页「立即运行所有规则」）
- [x] 后端：新增 `POST /api/rules/:id/execute`（权限与账户级锁、force、摘要/审计、lastExecutedAt；返回 rule_id、account_id、matched_count、executed_count、failed_count、status、run_id）
- [x] 前端：RuleManager 每张规则卡片底部新增「运行此规则」按钮，调用单条执行接口，弹窗提示结果
- [x] 验证：pytest `test_permission_isolation_api.py` 全部通过；普通用户 IDOR 返回 403、健康/execute-all/单条执行行为符合预期

**补充（同窗口完成）**：
- [x] 认证优先：`authJwt.js` 优先使用 `Authorization: Bearer`，再回退 cookie，避免 API/测试被浏览器残留 cookie 误判为 admin
- [x] 执行中状态与 409 拦截：`cronService.js` 使用全局 `runningCount`（executeAllRules/executeSingleRule 入口 +1、finally -1），`getCronStatus()` 返回 `isRunning: runningCount > 0`；executeAllRules 入口若 `runningCount > 0` 直接 return；路由据此返回 409/ALREADY_RUNNING，避免重复触发与竞态

### 4.2 IM 机器人与报警去噪

- [ ] 后端：实现 IM 通知模块（例如 `server/services/notificationService.js`），封装钉钉调用。
- [ ] 后端：在内存中维护一个 60 秒缓冲区，对规则触发记录进行聚合处理：
  - 每 60 秒生成一条汇总通知，包含核心统计和重点列出严重动作。
- [ ] 后端：在 Token 熔断、API 使用率过高、同步异常等场景中调用通知模块发送告警。
- [ ] 测试：对通知聚合逻辑做基础单元测试（例如在模拟时间推进下，验证聚合结果）。

### 4.3 系统健康看板 API

- [x] 后端：实现 `GET /api/system/health` 等健康接口，返回：
  - 各账户最后一次同步成功时间。
  - 上一轮规则引擎全量扫描耗时。
  - 当前动作队列积压数量。
  - Token 锁定状态等。
  （routes/system.js：GET /api/system/health，按角色裁剪；返回 last_sync_time、cron 状态、queue.pending_count、is_system_locked）
- [x] 前端：在 Dashboard 或新页面增加系统健康视图，展示上述关键指标。（SystemStatus.vue 已存在；4.1.1 已有时区统一）
- [x] 测试：为健康检查 API 编写简单测试，验证返回字段与状态码。（health.test.js 测 GET /api/health；systemHealth.test.js 测 GET /api/system/health 鉴权+响应结构，4 用例通过）

### 4.4 应用日志与轮转（Winston）（2026-02-10 已落地）

- [x] 后端：按“0. 基础架构与测试”的日志任务完成接入（双写：终端 + logs/ 文件，14 天保留）
- [x] 后端：在频率与熔断场景写入 warn/error 日志，并预留 IM 通知接入点
- [x] 验收：日志文件按日期生成、分级记录、异常与拒绝可追踪、保留策略生效；日常 `npm run dev:server`，留档时 `npm run dev:server:logs`

---

## 5. 测试与质量保障

- [x] 测试：为 Data Ingestor、规则评估、动作执行、日志记录、通知模块分别编写核心测试用例。（2026-02-12 文档同步：ingestorService、ruleEngine、ruleEngineDispatcher、ruleDataService、rules、actionExecutor、preFlight、smartMute、archiveFallback、dailyArchiveStatus、conditionsValidator 等单测已落地；仅通知模块待 4.2 实现后补充）
- [x] 测试：在 `vitest.config.js` 中保证覆盖率统计范围包含 `server/services` 与 `server/db` 等关键目录。（vitest.config.js 已配置 include: ['server/**/*.js']，覆盖 server/services、server/db）
- [ ] 测试：目标测试覆盖率分阶段提升：
  - 阶段一：覆盖率 ≥ 60%。
  - 阶段二：覆盖率 ≥ 80%。

### 5.1 AdsPolar 修复验证（2026-01-27 新增）

**背景**：数据架构层核心功能已实现，需要系统化验证确保功能正确性。

**验证准备工作**（2026-01-27 已完成）：
- [x] 创建验证执行步骤文档（`验证执行步骤.md`）
- [x] 创建验证脚本文件：
  - [x] `test-verify-sync.js` - 触发同步任务验证
  - [x] `test-verify-archive.js` - 触发归档任务验证
- [x] 创建 SQL 查询集合（`验证SQL查询.sql`）
- [x] 创建验证任务清单（`下一个窗口验证和测试清单.md`）
- [x] 更新验证命令文档（`验证命令.md`）

**待执行验证**（2026-02-10 已执行并通过）：
- [x] 步骤1：验证写入清洗逻辑
  - [x] 执行 `node test-verify-sync.js`，观察清洗日志
  - [x] 执行 SQL 查询，确认没有新的僵尸数据
- [x] 步骤2：验证归档查询使用 data_date
  - [x] 执行 `node test-verify-archive.js`，检查归档日志
  - [x] 执行 SQL 查询，确认 data_date 正确使用
- [x] 步骤3：验证脚本接受 1% 热数据差异
  - [x] 执行 `node server/scripts/verify-spend-ads-completeness.js`
  - [x] 确认遗漏率 ≤ 1% 被正确识别为热数据差异
- [x] 步骤4：SQL 综合验证
  - [x] 执行 `验证SQL查询.sql` 中的所有查询
  - [x] 确认数据一致性和查询口径正确性
- [x] 更新验证检查清单（在 `验证命令.md` 中）

---

## 6. 验收 Checklist（最终上线前）

- [ ] 在测试环境中模拟典型运营场景（止损、扩量），验证规则触发与执行结果与预期一致。
- [ ] 在代理异常、Token 失效等异常场景下，系统能自动熔断并及时通知。
- [ ] 审计日志可完整还原任意一次规则执行的「前因后果」。
- [ ] Dry Run 模式下，所有对广告的变更都不会实发，仅记录日志与通知。
- [ ] 性能与稳定性满足预期规模（结合实际账户/广告数量评估）。
- [ ] 冷数据落盘口径正确：同日多快照时 `daily_stats` 当日值等于“最后快照”的值（非 SUM），跨时区边界正确
- [ ] UNION 查询与唯一索引一致性：`ad_snapshots` 与 `daily_stats` 参与联合查询的字段名/类型完全一致（统一使用 `date`/`data_date` 口径），`ad_snapshots` 配置 `uk_account_ad_date(account_id, ad_id, data_date)` 唯一索引，相关 SQL 在集成测试中通过验证。
- [x] 应用日志与轮转：日志文件按日期生成、分级记录、异常与拒绝接管、14 天保留策略生效；敏感信息不暴露（Token 仅前 10 位）；Winston 双写已落地（2026-02-10）