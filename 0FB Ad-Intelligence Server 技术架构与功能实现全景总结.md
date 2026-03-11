FB Ad-Intelligence Server 技术架构与演进全景总结（技术白皮书）
一、项目总体定位与演进阶段
1.1 项目定位
产品形态：本地运行的 Facebook Marketing API 智能监控与自动化规则系统。
目标用户：跨境电商小团队内部运营/投手 + 技术。
核心能力：
多账户、多用户隔离；谁的账户谁管理。
7x24 小时无人值守，规则自动触发广告暂停/恢复/增减预算。
行为可审计：每一次自动决策都有日志和复盘证据。
规则逻辑可视化：前端规则管理、模板、动态筛选。
1.2 技术栈与架构
后端：
Node.js + Express
MySQL 8 + Drizzle ORM（+ 原生 SQL）
node-cron 定时任务
Winston 日志 + 按天轮转
前端：
Vue 3 + Vite
Vue Router
（部分页面）Pinia / 组件内状态
测试与运维：
Vitest + Supertest + pytest（部分 Python 验证脚本）
Thunder Client / curl 脚本 / 手工 SQL 验证
SOCKS5/HTTP 代理、自适应限流、全局 FB 请求队列
1.3 阶段划分（按 DEV_PLAN）
Phase 1：稳定性与透明化（完成）
Phase 2：多用户隔离架构（完成）
Phase 3：规则重心下沉与 7x24h 自动化（当前主战场）
M2：数据架构层（采集 + 同步 + 归档）≈ 完成
M3：规则配置层（模型 + 配置 + 监控范围）≈ 完成
M4：动作执行层（仲裁 + 预算护栏 + Pre-Flight + 冷却）≈ 完成
M5：反馈与监控层（日志 + 健康 + IM 机器人）基础完成
Phase 4：前端布局与体验（Monitor/RuleManager/AdminTemplates 重构，已完成）
Phase 5：审计、模拟、安全实战（陆续推进）
二、数据架构层（M2）：从原始数据到冷热分层与结构镜像
2.1 核心数据表设计
ad_snapshots（热数据：Today）
粒度：账户 + 广告 + 自然日（按账户时区）今日快照。
唯一约束：uk_account_ad_date(account_id, ad_id, data_date)。
核心字段：
维度：account_id, ad_id, ad_name, status(effective_status), owner_id, data_date, timezone_name, sync_session_id, synced_at
原始计数：
spend, purchases, link_clicks, unique_link_clicks, purchase_value
add_to_cart_count, initiate_checkout_count, add_payment_info_count
比值类（只在冷数据落盘或读侧计算，不在 snapshots 持久化派生值）：
cpc / ucpc / cpa / roas / 各种成本类（add_to_cart_cost、checkout_cost、payment_cost）
业务字段：mute_until, mute_reason, is_simulation
语义：
今日每次同步覆盖同一 (account, ad, data_date) 一行，保证“最后快照”语义。
只写 spend>0 的广告（僵尸数据在写入队列过滤）。
daily_stats（冷数据：历史按日聚合）
粒度：账户 + 广告 + 自然日。
索引：uk_account_ad_date(account_id, ad_id, date) + idx_account_date_ad(account_id, data_date, ad_id)。
字段：
原始计数：spend, purchases, link_clicks, unique_link_clicks, purchase_value, add_to_cart_count, initiate_checkout_count, add_payment_info_count
比值类（方案 A）：
cpc/roas/ucpc/cpa… 仅存 API 兜底或 null，读侧统一由总分子/总分母重算。
结构字段：ad_set_id, campaign_id, actions(JSON), timezone_name
落盘口径：
当日最后快照 落盘，而不是多个快照 SUM。
日期字段使用 insight.date_start || insight.date，对应“事件发生日”。
automation_logs（执行审计日志）
记录每次规则执行的动作：
run_id, rule_id, ad_id, account_id, owner_id, is_simulation
metrics_snapshot(JSON)：执行瞬间的指标快照
action_type, action_payload(JSON)
api_request, api_response
status(success/fail/skipped), skip_reason, error_message
triggered_at (UTC TIMESTAMP), created_at
daily_archive_status（归档状态/任务注册表）
驱动冷数据归档的状态机：
(account_id, target_date) 唯一，状态：PENDING/ARCHIVED/FINALIZED/ERROR。
配合统一心跳 + 账户本地 02:00/12:00 实现双窗口归档。
结构镜像表：structure_ads / structure_adsets / structure_campaigns
分别镜像广告 / 广告组 / 广告系列结构，作为“选择器”与目标解析的数据源。
字段：
id, account_id, name, effective_status, status, configured_status, updated_time, created_time, last_synced_at, adset_id/campaign_id
作用：
规则配置界面的结构选择器（不再穿透调 FB）。
规则目标解析（campaign/adset 级别 → ad_id）。
监控范围条件（包含“创建时间段”）。
动态筛选快照表：rule_matched_objects
字段：rule_id, account_id, object_id(ad_id), object_type, created_at
索引：UNIQUE(rule_id, account_id, object_id)、idx_account_rule(account_id, rule_id)。
作为动态筛选快照，执行层从此表读取目标广告。
冷却状态表：rule_ad_execution_state
主键：(rule_id, scope_key)，scope_key 如 ad:adId / budget_adset:adsetId / budget_campaign:campaignId。
字段：last_executed_at (UTC), last_status。
用于广告级/预算级冷却控制。
2.2 Data Ingestor：批量拉取 + 滑动窗口 + 频率自愈
今日热数据同步（Today Sync）
服务：ingestorService.syncAccountTodayStats / syncAllAccountsTodayStats
流程：
从 Facebook /ads 与 /insights API 中按账户批量获取 Today 数据，使用 Batch API（20 子请求一批）。
字段集（Route 1 已补齐 ROI 核心字段）：
ad_id, ad_name, adset_id, campaign_id, spend, actions, action_values, cost_per_action_type, purchase_roas, website_purchase_roas, cost_per_unique_link_click, cost_per_unique_inline_link_click, inline_link_clicks, unique_inline_link_clicks。
数据清洗：
仅保留 spend>0 或有展示/点击/购买的记录。
parseActions 精确匹配 offsite_conversion.fb_pixel_purchase，严格防“7 倍成效”问题。
写库：
写入 ad_snapshots：带 data_date（账户时区自然日）、sync_session_id、synced_at。
Piggyback：顺带补齐 structure_ads，避免 Today 同步与结构同步重复调 FB。
滑动窗口 + 冷数据归档
滑动窗口：
每 15 分钟统一心跳，根据账户时区决定 today / last_3d / last_7d / last_14d 窗口。
冷路径归档：
账户本地时间 ≥02:00 → 昨日归档 ARCHIVED；
账户本地时间 ≥12:00 → 深度对账 FINALIZED。
冷数据落盘：
从 ad_snapshots 中按 data_date 聚合 当日最后快照 落入 daily_stats。
回退策略（MySQL 8 ROW_NUMBER 优先，非 8 用 max(synced_at) 连接法）统一在 queryLastSnapshotCompatible，并有观测字段记录是否走了兼容路径。
API 频率自适应与自愈
解析头 x-business-use-case-usage，根据使用率分档 sleep。
处理 estimated_time_to_regain_access（注意单位是分钟，转换为毫秒 + 安全缓冲）。
超时保护：fetchWithTimeout 45s。
Token 熔断器：连续 3 次 190 错误锁定系统并报警。
结构同步：Piggyback + 伪增量 + 全量轮转
Piggyback：
Today 热同步后，对新增/缺失广告调用 resolveObjectsByIds 填充 structure_ads。
同轮心跳（Today + Piggyback + 伪增量）保证对 activeAdIds 的 resolve 只发生 一次。
伪增量（写死算法）：
recentActiveIds：最近 24 小时内 ACTIVE 且 last_synced_at 在窗口内的广告；
diffIds = recentActiveIds − activeAdIds；每轮至多 200 个，优先最久未同步。
仅对 diffIds 走 resolve，避免全表扫描。
近 3 天结构轮转（Track1）：
每 20 分钟 :05/:35/:55，每次 5 账户；仅拉最近 3 天 updated_time ≥ since，失败回退 ISO8601。
手动刷新结构：
POST /api/sync/structure，账户级锁 + 2 分钟冷却，只对单账户立即全量同步。
所有结构同步任务均以 structure_sync_status 状态表为基准，包含 has_full_synced, last_full_count, last_filter_since_sec, last_success_at, last_fast_sync_ts, fast_dirty 等字段，驱动优先级和回退。
三、规则配置层（M3）：模型、时间窗口、监控范围与动态筛选
3.1 规则数据模型（DB + API）
表：rules，字段扩展：
目标范围：
target_level: 'ad' | 'adset' | 'campaign'
target_ids: JSON 数组
target_by_account: JSON { accountId: [adId1, ...] }（多账户精细目标）
条件配置：
conditions: JSON v2（DNF 结构）
DNF 线性表达：前端 whenLines + whenTimeWindow + whenCustomRange；后端存 conditions.version=2, groups:[...]。
逻辑与时间：
logic_operator: 'AND' | 'OR'（v1 兼容）
timezone_name: 账户时区
execution_interval_minutes: 冷却间隔（广告级）
execution_time_windows: JSON，描述每日可执行时间段
动态筛选：
use_dynamic_scope(bool)
scope_filters JSON（level/status/创建时间段等）
exclude_ids JSON（混合 ad/adset/campaign）
max_dynamic_matches INT
dynamic_scope_status, dynamic_scope_error_msg, dynamic_scope_updated_at
其他：
is_simulation（Dry Run）
owner_id（规则所有者）
3.2 RuleDataService：时间窗口与指标口径
时间窗口：
today / yesterday / last_3_days / last_7_days / lifetime；基于 account_mappings.timezone_name 与 Luxon 计算自然日边界。
路由：
today → ad_snapshots（last snapshot）
yesterday / last_3_days / last_7_days → daily_stats + 合并 ad_snapshots（今天）时使用总分子/总分母聚合。
冷归档真空期：昨日数据未落盘时，从 ad_snapshots 的“昨日最后快照”兜底。
读侧 ROAS 方案 A：
单日 calculateSingleDayMetrics：
spend=0 → roas=null（不可比较）
value>0 → roas = value/spend
否则若 API roas>0 → roas = API 值
其余 → roas=0（“有花费无转化”的坏情况）
多日 aggregateMultiDayMetrics：
roas = SUM(purchase_value)/SUM(spend)
不再 AVG 单日 roas，避免辛普森悖论。
比值类指标统一语义：
cpc / ucpc / cpa / roas 在分母为 0 时为 null（不可比较）；规则引擎对 null 与数值比较结果一律为 false。
产品层拆分“坏 vs 空”：
空耗：spend > X AND link_clicks = 0
贵点击：link_clicks > 0 AND cpc > Y
空转化：spend > Z AND purchases = 0
3.3 监控范围条件与多账户结构选择
结构选择器（ads/adsets/campaigns）：
后端：GET /api/structure/:level（已转向查 structure_*，不调 FB）。
状态过滤：
q 为空：只返回 ACTIVE；include_paused=1 加 PAUSED。
q 非空：放宽至 6 类状态（ACTIVE/PAUSED/PENDING_REVIEW/DISAPPROVED/IN_PROCESS/WITH_ISSUES），仍不含 DELETED/ARCHIVED（本期选 A 安全优先）。
多账户结构查询 /api/structure/objects/multi：
支持多个账户 id，分别从 structure_* 查数据，并加 meta：
per_account_limit：每账户返回条数上限
has_more：是否还有更多数据可翻页
account_ids 上限：非管理员默认 ≤20，管理员可放宽（如 50）。
首轮并发：p-limit(4) 以提升首屏加载体验。
监控范围条件（RuleManager 配置）：
字段：
名称 类：name_contains / name_not_contains
状态 等于/不等于：scope_status_filter / scope_status_exclude
创建时间段：scope_created_within_hours（24/48/72 + 自定义 1–720 小时）
实现：
后端 structureSyncService 的 list methods 接收上述参数构建 WHERE：
固定顺序：account_id + effective_status（可索引） + 名称条件 + 创建时间。
渐进减少扫描行数，避免名称类条件在大表上直接模糊扫描。
前端 RuleManager 将多行条件折算为最窄窗口（创建时间段取 min 小时）并传参；applyScopeConditionsToCurrentList 针对 created_within 行视为“后端已过滤”。
“创建时间段”字段落地：
三张结构表都持久化 created_time（ISO8601），支持精确 N 小时以内对象筛选。
3.4 条件组 DNF 与前端条件编辑
后端：
conditionsValidator 校验 v2 DNF 结构：
version=2, groups: [{ conditions: [...], time_window }]
time_window 组内统一，不允许空组。
前端 RuleManager：
使用线性列表 whenLines（首行 join=null，后续 join=AND/OR）。
支持多条件 AND/OR、不同 metric/operator/value/time_window。
模板（止损/扩量/空耗）全部改成输出 v2 JSON。
非 JSON 模式（v1）的 OR 条件可自动转为 v2 groups。
验收文档：
docs/DNF验证_手把手步骤.md + Thunder Client 集合，覆盖：
time_window 不一致 → 400
v2 空组 → 400
v1 OR → 正常匹配
v2 多组 AND/OR → 正常。
四、动作执行层（M4）：仲裁、幂等、预检与冷却
4.1 按广告仲裁（Arbitration by AdId）
入口：cronService.executeRulesForAccount
从 ruleDataService 一次性读取该账户的指标数据。
调 RuleEngineDispatcher.loadDataForAccount + evaluateRuleWithCache，获得 Array<{rule, matchedAds}>。
每条规则内只保留“最狠一条动作”（单规则多动作压缩为一条 candidate）。
仲裁规则：
同一账号 + 同一轮（run_id）下，对每个 ad_id 汇总所有 candidate，按动作优先级表决：
pause_ad(1) > activate_ad(2) > decrease_budget(3) > increase_budget(4) > set_budget(5)
同优先级同动作类型，赢家为 ruleId 最小者（稳定 tie-break）。
仲裁输出：Map<adId, { winnerRule, winnerAction, matchedAd, suppressedRules }>。
结果：
同一广告同一轮只执行一条动作，避免冲突/重复。
4.2 预算幂等与单位统一（分）
单位：
内部预算全部使用“分”（最小货币单位），与 FB daily_budget 读/写保持一致。
幂等：
调度层在执行前预计算 newBudgetCents = computeNewBudgetCentsOnce(currentBudgetCents, action)，保存 _resolvedBudgetCents。
执行层若看到 _resolvedBudgetCents，不再额外 GET 当前预算；避免重试时重复相加。
预算护栏：
增加预算：
若当前已经高于 max_daily_budget → 不动，skip_reason=above_max_cap。
否则 new = min(current + delta, max_daily_budget)。
减少预算：
若当前 ≤ min_daily_budget → 不动，skip_reason=below_min_floor。
否则 new = max(current - delta, min_daily_budget, MIN_BUDGET_CENTS)。
set_budget：
只上调不下调：当前 ≥ target → 不动，skip_reason=budget_already_at_target。
单测：
budgetUnitCents.test.js + budgetPreFlightReason.test.js 覆盖上限/下限/只上调/跳过原因。
4.3 Pre-Flight（不新增 FB GET）与 Smart Mute
Pre-Flight 原则：
不新增 per-ad GET，只用本地 ad_snapshots.status 判定“目标已达成”：
pause_ad：status 为 PAUSED/DISABLED/ARCHIVED… → skipped。
activate_ad：status 为 ACTIVE 及可激活状态，ARCHIVED 直接 skipped。
FB 返回已在该状态（already-in-that-state / duplicate）错误时，将失败转为 skipped 或 success，并带上 apiResponse。
Smart Mute：
mute_until/mute_reason 存在且 now < mute_until，跳过该广告所有动作（含预算），skip_reason=muted。
执行路径中已移除 Smart Mute 行为（只保留字段与清理脚本），防止隐藏逻辑影响可解释性。
4.4 冷却模型与 scope_key
冷却表 rule_ad_execution_state：
主键从 (rule_id, ad_id) 改为 (rule_id, scope_key)：
ad:adId：广告级冷却（适用于 pause/activate）。
budget_adset:adsetId / budget_campaign:campaignId：预算级冷却。
执行层返回 cooldownKey，调度层写：
(ruleId, cooldownKey) 一条；
若 cooldownKey 不是 ad:，再写一条 (ruleId, ad:adId)，保证广告级频率限制生效。
冷却时间计算：
DB 层：TIMESTAMPDIFF(MINUTE, last_executed_at, UTC_TIMESTAMP())。
日志：输出 lastAtUtc + lastAtBj + diffMin，方便用北京时区理解。
五、动态筛选（Dynamic Scope）：快照化与多账户闭环
5.1 动态筛选数据模型与策略 B
规则开启 use_dynamic_scope=1 时：
动态匹配结果预先写入 rule_matched_objects：
按 (rule_id, account_id) 分区，object_id 为 ad_id。
dynamic_scope_status / dynamic_scope_error_msg 记录状态：
NORMAL / ERROR_OVERSIZE / ERROR_FILTER_INVALID / ERROR_REFRESH_FAILED。
策略 B（Oversize 保留旧快照）：
多账户刷新时，仅对 NORMAL 的规则做“按 rule_id + account_id 原子替换”（事务内 delete+insert）。
对 ERROR_* 规则：只更新状态字段，不清空旧快照，确保执行层仍能用上一版快照。
行为公式：
finalAdIds = (dynamicMatchedAdIds ∪ manualTargetIds) - excludeIds。
5.2 多账户动态刷新闭环（Trigger A/B/C）
Trigger A（结构脏检查后自动刷新）：
Track2/Today 同步标记 fast_dirty 的账户，在规则执行前 refreshStructureIfDirtyBeforeRules() 刷结构 + 动态范围。
Trigger B（规则保存后异步刷新）：
保存/更新规则后，解析该规则涉及的所有账户（target_by_account > target_account_ids > account_id）。
对每个账户分别防抖刷新动态筛选结果。
Trigger C（手动重算接口）：
POST /api/rules/dynamic-scope/refresh 支持：
只传 ruleId → 刷新该规则下全部账户，并返回 accountResults 汇总。
传 ruleId+accountId → 刷新指定账户（兼容旧用法）。
5.3 多账户隔离与删除联动
手工目标 targetIds 支持 act_xxx:id 格式：
解析时按当前账户 scope 过滤，只使用本账户的 id，避免跨账户串值。
删除规则：
在事务内同时删除 rules 和对应 rule_matched_objects 行，避免出现“孤儿快照”。
六、Track1/Track2 结构同步与全局限流
6.1 统一 Batch 内核与 Track2 极速同步
FacebookMarketingAPI.unifiedStructureBatch(accountId, {sinceSec, limit})
一次 Batch 请求拉取 campaigns/adsets/ads 三条 edge，fields 明确包括 id/name/status/effective_status/updated_time/created_time 及层级 id。
错误处理：
单个 edge 报错时，先用 Unix 秒 filtering，失败再回退 ISO8601。
关键 edge（adsets/ads）始终检查 error 字段，若失败则整个账户 Fast Sync 视为失败。
Track2 Fast Sync：
Cron: 7,27,52 * * * *，白名单账户 + p-limit 控制账户并发。
窗口：sinceSec = max(last_fast_sync_sec - bufferSec, nowSec - 3d)，bufferSec 默认 4h。
对所有成功账户的结果合并去重后，用 chunked bulk upsert 写入三张结构表，对有变化的账户打 fast_dirty=1。
6.2 全局 FB 请求限流队列
全局队列：
环境变量：
FB_GLOBAL_REQUEST_CONCURRENCY（总并发上限，建议 10）
FB_GLOBAL_QUEUE_TIMEOUT_MS（队列等待超时）
所有 Facebook 请求按优先级排队：
action > today > track2 > cold
日志：
priority=action 的请求会打印等待时间 wait_ms，确认止损动作不会被结构任务饿死。
七、反馈与监控层（M5）：审计、摘要、健康与日志
7.1 执行审计与规则执行摘要
automation_logs：
记录每次广告级动作执行的全过程（指标快照、动作、API 请求/响应、status、skip_reason、is_simulation）。
与 rule_execution_summaries 通过 run_id 关联。
rule_execution_summaries：
每规则每轮一行摘要：run_id, rule_id, account_id/multi, user_id, owner_id, matched_count, executed_count, failed_count, skipped_count, status, skip_reason/skip_details, evaluated_at。
索引覆盖常见查询：按 run_id、accountId、ruleId、ownerId、status、skip_reason。
接口：
GET /api/rule-execution-summaries / .../stats：
仅 admin 可见；
支持多维筛选 + 分页；
skip_details JSON 安全解析（兼容对象/字符串/Buffer）。
7.2 健康检查与系统状态
GET /api/system/health：
Admin：所有账户最后同步时间、最近规则扫描耗时、动作队列积压、Token 熔断状态等。
普通用户：只看到自己 owner_id 下账户与相关状态。
src/views/SystemStatus.vue：
展示统一心跳、冷归档、结构同步、规则执行、队列状态。
7.3 Winston 日志与轮转
server/utils/logger.js：
开发环境：Console 彩色输出。
生产（或 npm run dev:server:logs）：
双写：Console + 文件 logs/combined-YYYY-MM-DD.log 等。
error, exceptions, rejections 各自轮转；14 天保留；gzip 压缩。
所有关键模块（ingestorService, cronService, structureSyncService, socks5, actionExecutorService, ruleDataService, routes, authJwt, db）已替换为 logger。
时区统一：
MySQL 连接池 timezone: '+00:00' + SET time_zone='+00:00'。
执行日志 triggered_at / 冷却 last_executed_at 存 UTC，前端统一用 formatDateTimeBeijing 展示北京时区。
八、前端模块：监控、规则、模板、日志与系统状态
8.1 监控大屏（Dashboard.vue）
按账户/层级展示广告列表、核心指标（spend/purchases/ROAS/CPC/UCPC/CPA）。
支持时间范围切换（today/yesterday/last_7_days/last_30_days）。
支持刷新、状态过滤、分页。
UI 采用 MainLayout + 卡片式白底设计。
8.2 规则管理（RuleManager.vue）
功能：
规则列表、创建/编辑/删除、启用/禁用、Dry Run、单条执行。
目标配置（账户 → 层级 → 多选结构对象，支持搜索）。
条件编辑（线性列表 + AND/OR + 时间窗口）。
执动作编辑（pause/activate/increase/decrease/set_budget + 预算护栏）。
动态筛选配置（useDynamicScope、scopeFilters、maxDynamicMatches、excludeIds）。
监控范围条件（状态等于/不等于、名称包含/不包含、创建时间段）。
体验：
模板按钮（止损/扩量/空耗）一键填充 v2 JSON 条件。
顶部醒目 disclaimer：在 FB 后台恢复广告前，请先在本系统暂停相关规则。
预算动作编辑 UI 精简，防止“无意义字段”干扰。
8.3 模板管理（AdminTemplates.vue）
管理规则模板（名称、描述、条件、动作）。
UI 设计：
白底卡片，条件区浅蓝、动作区浅绿，创建新模板卡片。
编辑弹窗分区清晰，支持与 RuleManager 类似的条件与动作编辑。
逻辑：
单动作设计（模板内不再支持多动作堆叠）。
预算上限标签清晰可见。
8.4 日志与系统状态前端
Logs.vue：
基于 automation_logs 显示每次执行细节（时间、规则、账户、广告、动作、结果、原因）。
时间统一北京时区。
SystemStatus.vue：
展示统一心跳、归档状态、队列长度、Token 状态等。
九、时间线总览（按项目总结）
2026-01-07：多用户隔离、初版监控与规则、前端布局基础完成。
01-15 ～ 01-22：数据架构 M2：Ingestor、滑动窗口、冷数据归档、完整性检查、时区与窗口修复。
01-27 ～ 01-30：规则管理后台完成、规则执行摘要（系统层可观测）、权限隔离最后一块拼图、M4 动作执行层方案定稿与 Vitest 验证。
02-02 ～ 02-07：顺序1/顺序2 口径与 DNF、模板 v2、代理重试与并发控制。
02-10 ～ 02-14：Winston 日志、ROAS 方案 A、Route1 字段补齐、campaign/adset 补齐、target_by_account 多账户优化。
02-24 ～ 02-28：采纳清单与监控范围完善、执行频率与执行时间全方案、结构同步近 3 天与定时前端、「创建时间段」监控条件落地。
03-02 ～ 03-04：ROAS 本地计算统一、预算 cooldown + Pre-Flight 重构、时区统一与执行日志显示。
03-07：Track2 极速结构同步 + 全局限流 + fast_dirty 闭环、动态筛选多账户闭环（TriggerB/C + 多账户隔离 + 策略B 完整实现）。
这份文档你可以作为对外的技术白皮书 / 架构总览，既讲“现在长什么样”，也体现从 1 月到 3 月的演进路径。