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

- Phase 1：稳定性与透明化 —— 已完成，用于支撑后续迭代。
- Phase 2：多用户隔离架构 —— 已完成，规则应继续遵守 owner 维度隔离。
- Phase 3：规则重心下沉与 7x24h 自动化 —— 进行中，是本计划的主要施工范围。
- Phase 4：前端布局优化 —— 已完成，可在后续做小幅改进。
- Phase 5：审计、模拟与安全实战 —— 规划中，对应《自动化优化方案》的第 4 部分。

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

### M3：规则配置层（Rule Engine 配置与时区对齐）

落地「二、规则配置层」：

- 规则模型包含：目标对象、条件数组（AND/OR）、时间窗口、账户时区。
- 支持 Today / Yesterday / Last 3 Days / 累计至今。
- 保证只对 `effective_status === 'ACTIVE'` 的对象生效。
- 提供 JSON 模板化 SOP 与前端免责提示。

### M4：动作执行层（冲突仲裁与安全护栏）

落地「三、动作执行层」：

- 实现动作优先级体系（暂停 > 降预算 > 加预算等）。
- 同一广告同一轮扫描只执行优先级最高的动作。
- 支持 Smart Mute（手动/自动挂起），预算上限护栏。
- 引入 Pre-Flight Check 和重试策略。

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
  - 主键：`id`（自增或雪花）、唯一索引：`ad_id + sync_session_id`
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
    - 元信息：`sync_session_id`(VARCHAR)、`synced_at`(DATETIME)、`timezone_name`(VARCHAR)
    - 自动化相关：`mute_until`(DATETIME)、`mute_reason`(VARCHAR)、`is_simulation`(BOOL 可选)
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

### 4.2 Data Ingestor 批量同步流程

- 入口：在后端（建议 `server/services/cronService.js` 或新建 `ingestorService.js`）提供：
  - `syncAccountTodayStats(accountId)`：同步单账户 Today 数据。
  - `syncAllAccountsTodayStats()`：同步当前系统内所有账户的 Today 数据。
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
- 日志与告警接入（补充）：
  - 在占用率高与熔断触发时写入 warn/error 级日志；将告警事件纳入“应用日志与轮转”的验收范围
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
  - 热数据（Today）：每 10 分钟轮询，用于规则触发。
  - 冷数据（历史）：每天 06:00（账户时区）将昨天数据落盘到 `daily_stats`，报表查询优先读取此表。
- 冷数据落盘口径（补充细化）：
  - 当日值取“每广告最后快照”，不可对快照 SUM（详见《方案B+优化版》三章）
  - 实现方式：
    - MySQL 8.0+：使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)` 取 `rn=1`
    - 非 8.0：使用“最大时间戳连接法”（先取 MAX(synced_at)，再连接原表）
  - 索引与性能：确认/增加 `idx_account_synced`、`idx_ad_synced`、`idx_ad_synced_desc`
  - 06:00 边界降级：若 `daily_stats` 暂不可用，按账户时区降级到 `ad_snapshots` 的“昨日最后快照”，误差约 0.7%–1%
  - 单日比值入库与迟到回补：
    - 昨日批量洞察：按 `date_preset=yesterday` 拉取 `cpc, roas, inline_link_clicks, unique_inline_link_clicks, actions, action_values, cost_per_action_type, cost_per_unique_link_click, cost_per_unique_inline_link_click`
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

### 5.3 前端规则配置与 SOP 模板

- 级联选择流（前端）：
  - 账户 -> 广告系列 -> 广告组 -> 广告，最终将选中对象的 ID 写入 `target_ids`。
  - 只允许选择同一层级的对象。
- SOP 模板化：
  - 提供预设 JSON 模板，例如：
    - 止损：`spend > 20 && purchases < 1`
    - 扩量：`purchases > 5 && cpa < 10`
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
- Pre-Flight 检查：
  - 在执行 `PAUSE` 等动作前：
    - 调用一次轻量级 GET 查询广告当前状态。
    - 若已被运营手动关闭，记录为 `status = skipped`，不再调用修改接口。
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
  - 跨时区账户在“昨日”边界选择正确（含 06:00 前后场景）；`daily_stats` 缺席时降级策略生效
- 应用日志与轮转（补充）：
  - 按日期生成分级日志；异常与拒绝可追踪；保留策略生效；敏感信息不暴露
