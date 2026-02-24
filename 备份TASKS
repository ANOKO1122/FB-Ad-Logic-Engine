# FB Ad-Intelligence Server 任务清单（TASKS）

> 建议执行顺序：从「高价值、低耦合」的后端能力开始（数据层 → 规则层 → 动作层 → 反馈层），前端逐步跟进。
> 
> **最新更新**：2026-01-22 - 已完成归档完整性检查修复、ROW_NUMBER排序稳定性增强、观测性增强、诊断脚本优化。核心改进：完整性检查机制（expectedCount vs archivedCount）、自动补齐缺失数据、跳过原因分类统计、诊断脚本优化（识别多次归档）。详见 `项目开发过程/项目总结-2026-01-22-归档完整性检查修复与验证.md`

---

## 0. 基础架构与测试（如已完成可直接勾选）

- [ ] 后端：确认已经实现 `server/app.js` 与 `server/server.js` 的架构分离，并更新 `package.json` 的启动脚本。
- [ ] 测试：确保 `vitest.config.js` 存在且 `npm test` 能在不占用实际端口的情况下跑通基本健康检查测试（`server/tests/health.test.js`）。
- [ ] 后端：接入集中化应用日志与轮转（Winston + winston-daily-rotate-file）
  - [ ] 创建统一 logger（JSON 格式；开发模式 console 彩色输出；生产写文件）
  - [ ] 文件按天切割：combined-YYYY-MM-DD.log、error-YYYY-MM-DD.log、exceptions-YYYY-MM-DD.log、rejections-YYYY-MM-DD.log
  - [ ] 设置保留策略：仅保留最近 14 天（可开启压缩）
  - [ ] 捕获未处理异常与未处理 Promise 拒绝（集中记录）
  - [ ] 关键模块替换 console.* 为分级日志：server 启动、cronService、ingestorService、API 路由、频率与熔断
  - [ ] 验收：日志按日期生成、分级记录可检索、14 天保留与清理策略生效

---

## 1. 数据架构层（M2）

### 1.1 数据表设计与迁移

- [x] 后端/DB：在 `server/db/schema.js` 中定义 `ad_snapshots` 表（参照 DEV_PLAN 中的字段建议），并生成/执行对应迁移脚本。
- [x] 后端/DB：定义 `daily_stats` 表，用于存储历史聚合数据，并生成/执行迁移。
- [x] 后端/DB：定义 `automation_logs` 表，用于存储规则执行审计日志，并生成/执行迁移。
- [ ] 后端/DB：检查/更新所有 ID 字段（Account/Ad/Rule 等）为 `VARCHAR(50)`，避免使用 `BIGINT`。

### 1.2 Data Ingestor 实现

- [x] 后端：在 `server/services` 下新增数据同步服务（例如 `ingestorService.js`），提供：
  - `syncAccountTodayStats(accountId)`
  - `syncAllAccountsTodayStats()`
- [x] 后端：在 Ingestor 中实现 20-Batch 聚合：
  - 使用自实现 `chunkArray` 对广告 ID 列表按 20 个一组切分。
  - 按 Facebook Batch API 规范构造请求并发送。
- [x] 后端：在 Batch 请求中显式请求字段（围绕 10 个字段与其计算所需的原始计数）：`ad_id, ad_name, adset_id, spend, cpc, purchase_roas, actions, action_values, cost_per_action_type, cost_per_unique_link_click, cost_per_unique_inline_link_click, inline_link_clicks, unique_inline_link_clicks`，并将时间范围锁定为 today（快照）或 yesterday（归档），强制加上 `use_account_attribution_setting=true`。注意：`purchase_roas` 返回数组格式，需要提取；`roas` 不是有效字段名。
- [x] 后端：为每次同步生成 `sync_session_id`，将全部写入 `ad_snapshots` 的该字段，并记录同步完成时间。
- [x] 后端：实现数据字段提取逻辑（10 个核心字段：状态、花费、成效(购买)、CPA、ROAS、CPC、uCPC、加购费、结账费、支付费，以及区间计算所需的原始计数）。
- [x] 后端：实现获取广告状态的逻辑（从 `/ads` API 获取并合并到 insights 数据中）。

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

### 1.4 滑动窗口与冷热数据策略

- [x] 后端/DB：在 Ingestor 中实现滑动窗口同步（Today + Past 7 Days），使用 `ON DUPLICATE KEY UPDATE` 更新过去一周数据。
- [x] 后端：实现定时任务（在 `server/services/cronService.js` 或类似文件中）：
  - 每 10 分钟执行一次「热数据」Today 同步。
  - 每 10 分钟检查一次冷数据归档（高频检查 + 账户本地 06:00 窗口）。
  - 每 30 分钟执行一次滑动窗口同步（修复归因延迟）。
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
- [x] 后端：落盘与查询均使用账户 `timezone_name` 计算"昨日"自然日边界；高频检查（每 10 分钟）+ 账户本地 06:00 窗口；无数据时降级到 `ad_snapshots` 的"昨日最后快照"
- [x] 后端/DB：冷数据归档幂等与并发控制（2026-01-21）：
  - COUNT(*) 检查：快速跳过已归档记录。
  - GET_LOCK：防止多实例并发归档。
  - 唯一索引 `uk_account_ad_date(account_id, ad_id, date)`：数据库层幂等。
  - ON DUPLICATE KEY UPDATE：自动更新已存在记录（包含 `timezone_name` 更新）。
- [x] 后端/DB：归档完整性检查修复（2026-01-22）：
  - 将"已归档跳过"改为"完整性检查"（expectedCount vs archivedCount）。
  - 只有已归档且完整才跳过，否则继续归档补齐。
  - 增强 ROW_NUMBER 排序稳定性（添加 `id DESC` 作为 tie-breaker）。
  - 增强观测性（跳过原因分类统计：已归档且完整、已归档但不完整、锁占用、窗口未到、无效账户、异常失败）。
  - 手动归档改为强制模式（绕过时区窗口和跳过检查）。
- [x] 后端/DB：`daily_stats` 写入 6 个原始计数字段与 `ad_set_id`，与 `ad_snapshots` 字段口径一致；同时写入 10 个核心字段的单日值（`cpc`、`roas`、`ucpc`、`cpa`、`add_to_cart_cost`、`checkout_cost`、`payment_cost` 等），API 缺失时以原始计数兜底计算入库
- [x] 后端/DB：移除 CTR/CPM 相关处理与字段引用，统一围绕 10 个核心字段与原始计数
- [x] 后端/DB：`ad_snapshots` 今日入库 10 个核心字段（比值/成本类直接存 API 值）；其中 `cpa` 今日按 `spend/purchases` 计算；同时入库区间计算所需原始计数（link_clicks、unique_link_clicks、purchase_value、add_to_cart_count、initiate_checkout_count、add_payment_info_count）
- [x] 后端：调整 CPA 计算口径：不使用 `cost_per_action_type` 的 purchase 成本，统一按 `spend/purchases` 计算（今日与区间）
- [x] 索引：确认/增加 `idx_account_synced`、`idx_ad_synced`、`idx_ad_synced_desc` 提升检索性能；创建唯一索引 `uk_account_ad_date(account_id, ad_id, date)` 确保幂等更新
- [x] 测试：构造同一广告同日多快照样例，验证 `daily_stats` 当日值等于"最后快照"的值；跨时区边界验证；降级查询误差控制在约 0.7%-1%

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

- [ ] 前端：在规则管理页面（例如 `src/views/RuleManager.vue`）中，增加级联选择控件（账户 -> 广告系列 -> 广告组 -> 广告），最终填充 `target_ids`。
- [ ] 前端：在规则编辑界面中，支持配置多个条件（metric/operator/value/time_window），并选择逻辑运算符（AND/OR）。
- [ ] 前端：增加预设 JSON 模板（止损、扩量）快捷按钮，点击后自动填充典型规则组合。
- [ ] 前端：在显著位置增加免责提示文案，提醒用户在 FB 后台手动开启被系统关闭的广告前，应先在本系统暂停相关规则。
- [ ] 前端：规则管理接入后端规则 API（/api/rules CRUD + toggle），替换本地 localStorage 实现。
- [ ] 前端：规则编辑新增 Dry Run（is_simulation）开关，并持久化到后端字段。
- [ ] 前端：规则编辑新增目标层级 target_level 与目标IDs（先支持手动输入，占位级联选择）。
- [ ] 前端：规则编辑“作用对象”改为可选（账户 -> 层级 -> 多选列表，支持搜索）。
- [ ] 前端：触发条件时间窗口支持 Today/Yesterday/Last 3 Days/Lifetime（每条条件可独立设置）。

---

## 3. 动作执行层（M4）

### 3.1 动作模型与优先级实现

- [ ] 后端/DB：定义动作配置结构（可存储在 `rules.actions` JSON 字段内），包括 `action_type` 和参数（如预算增幅百分比等）。
- [ ] 后端：在规则执行入口中，收集同一轮扫描中所有「满足条件的规则」生成待执行动作列表。
- [ ] 后端：按 `ad_id` 对动作进行分组，对每个广告：
  - 根据预设优先级（PAUSE/ARCHIVE/DELETE > DECREASE_* > INCREASE_*）选择最高优先级动作。
  - 丢弃同一广告其他动作。
- [ ] 测试：为动作优先级与冲突仲裁逻辑编写单元测试。

<!-- ### 3.2 Smart Mute（智能挂起）与状态检查

- [ ] 后端/DB：在 `ad_snapshots` 或专用表中增加 `mute_until` 和 `mute_reason` 字段。
- [ ] 后端：在规则执行前增加检查逻辑：
  - 若当前时间早于 `mute_until`，直接跳过该广告的所有动作。
- [ ] 前端：在监控大屏中，当用户手动开启广告时：
  - 弹窗询问挂起时长（1h/4h/次日 0 点/永久），并将结果写入后台。
- [ ] 后端：在 Data Ingestor 中检测广告从非启用到启用的状态变化时，自动为该广告设置默认的挂起时长（如 2 小时）。 -->

### 3.3 预算护栏与 Pre-Flight 检查

- [ ] 后端：在加预算类动作中要求提供 `max_daily_budget` 参数。
- [ ] 后端：计算新预算时，强制使用 `min(新预算, max_daily_budget)`。
- [ ] 后端：在执行暂停/归档/删除等动作前，增加一次轻量级 GET 查询当前广告状态：
  - 若已关闭，则记录为「跳过」，不再发送修改请求。
- [ ] 后端：实现动作队列的重试机制：
  - 针对临时性错误允许最多 3 次重试，并采用指数退避。
- [ ] 测试：为 Pre-Flight 检查及重试逻辑编写测试用例。

---

## 4. 反馈与监控层（M5）

### 4.1 审计日志与 Dry Run

- [ ] 后端/DB：确保 `automation_logs` 表结构具备存储：
  - 触发瞬间指标快照（JSON）
  - 动作信息
  - API 请求/响应
  - 状态与错误信息
- [ ] 后端：在规则执行路径中接入日志记录：
  - 无论成功/失败/跳过，都写入一条审计日志。
- [ ] 后端：支持 `is_simulation`（Dry Run 模式）：
  - 当开启时，只记录日志与通知，不触发真实 API 调用。
- [ ] 测试：为 Dry Run 模式行为编写测试，确保不会调用实际修改广告状态的 API。

### 4.2 IM 机器人与报警去噪

- [ ] 后端：实现 IM 通知模块（例如 `server/services/notificationService.js`），封装钉钉调用。
- [ ] 后端：在内存中维护一个 60 秒缓冲区，对规则触发记录进行聚合处理：
  - 每 60 秒生成一条汇总通知，包含核心统计和重点列出严重动作。
- [ ] 后端：在 Token 熔断、API 使用率过高、同步异常等场景中调用通知模块发送告警。
- [ ] 测试：对通知聚合逻辑做基础单元测试（例如在模拟时间推进下，验证聚合结果）。

### 4.3 系统健康看板 API

- [ ] 后端：实现 `GET /api/system/health` 等健康接口，返回：
  - 各账户最后一次同步成功时间。
  - 上一轮规则引擎全量扫描耗时。
  - 当前动作队列积压数量。
  - Token 锁定状态等。
- [ ] 前端：在 Dashboard 或新页面增加系统健康视图，展示上述关键指标。
- [ ] 测试：为健康检查 API 编写简单测试，验证返回字段与状态码。

### 4.4 应用日志与轮转（Winston）

- [ ] 后端：按“0. 基础架构与测试”的日志任务完成接入
- [ ] 后端：在频率与熔断场景写入 warn/error 日志，并预留 IM 通知接入点
- [ ] 验收：日志文件按日期生成、分级记录、异常与拒绝可追踪、保留策略生效

---

## 5. 测试与质量保障

- [ ] 测试：为 Data Ingestor、规则评估、动作执行、日志记录、通知模块分别编写核心测试用例。
- [ ] 测试：在 `vitest.config.js` 中保证覆盖率统计范围包含 `server/services` 与 `server/db` 等关键目录。
- [ ] 测试：目标测试覆盖率分阶段提升：
  - 阶段一：覆盖率 ≥ 60%。
  - 阶段二：覆盖率 ≥ 80%。

---

## 6. 验收 Checklist（最终上线前）

- [ ] 在测试环境中模拟典型运营场景（止损、扩量），验证规则触发与执行结果与预期一致。
- [ ] 在代理异常、Token 失效等异常场景下，系统能自动熔断并及时通知。
- [ ] 审计日志可完整还原任意一次规则执行的「前因后果」。
- [ ] Dry Run 模式下，所有对广告的变更都不会实发，仅记录日志与通知。
- [ ] 性能与稳定性满足预期规模（结合实际账户/广告数量评估）。
- [ ] 冷数据落盘口径正确：同日多快照时 `daily_stats` 当日值等于“最后快照”的值（非 SUM），跨时区边界正确
- [ ] 应用日志与轮转：日志文件按日期生成、分级记录、异常与拒绝接管、14 天保留策略生效；敏感信息不暴露（例如不打印 Token 前缀）
