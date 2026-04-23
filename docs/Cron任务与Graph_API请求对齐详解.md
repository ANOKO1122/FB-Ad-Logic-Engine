# Facebook 广告数据同步：定时任务与 Graph API 调用说明

**文档用途**：面向技术/运维/产品对接方，说明本系统在 **Cron 定时任务** 中如何从 **Facebook Graph API（Marketing API）** 拉取数据，以及每条管道对应的 **HTTP 形态、Insights 字段、结构边分页** 与 **环境变量**。  
**API 版本**：`v24.0`  
**基础地址**：`https://graph.facebook.com/v24.0`  
**鉴权**：请求均携带 `access_token`（部署侧通常为环境变量 `FACEBOOK_ACCESS_TOKEN`）。

---

## 一、读者如何阅读本文

| 若你关心… | 建议阅读 |
|-----------|----------|
| 每多久跑一次、跑什么 | 第二节「任务总览表」 |
| 报表/花费/转化从哪来 | 第三节「Insights」、第四节「滑动窗口」 |
| 广告系列/组/创意结构从哪来 | 第五节「结构同步」 |
| 账户列表从哪来 | 第六节 |
| 限流、开关、配额相关 | 第八节「环境变量」 |

---

## 二、定时任务与数据管道总览

系统在服务启动时注册 Cron（实现见 `server/services/cronService.js` 的 `startCronJob`）。与 **从 Facebook 拉取数据** 强相关的任务如下（不含仅删库、不调 Graph 的清理任务）。

| Cron | 名称（业务含义） | 核心逻辑 | Graph 侧数据类型 |
|------|------------------|----------|------------------|
| `*/15 * * * *` | **统一心跳** | 按账户时区决定同步「今日」或「近 N 天」滑动窗口；写入快照与按日统计 | 账户级 Insights、广告级 Batch Insights、`/?ids=` 批量解析 |
| `7,27,52 * * * *` | **Track2 快速结构同步**（可关） | 近窗内 Campaign / Adset / Ad 增量，支持合并写库 | Batch 三边 + 游标分页 |
| `0 * * * *` | **广告账户列表** | 与 BM 可见账户对齐，更新库中名称、发现新账户 | `GET /me/adaccounts` |
| `12 * * * *` | **Track1 结构轮转**（近 3 天） | 每轮少量账户补全结构镜像 | 与 Track2 类似或 legacy 全路径 |

**补充**：`* * * * *` **每分钟规则** 的主目标是规则匹配与执行；可能因「结构变脏预刷新」等**偶发**读 Graph，**不属于**上表「批量报表/结构同步主管道」，对接报表口径时可单独约定是否计入。

---

## 三、全局机制（与所有请求相关）

### 3.1 请求调度与优先级

所有 Graph 调用经统一封装与队列：**优先级**大致为 `action`（规则动作）> `today`（今日热数据）> `track2`（结构）> `cold`（冷数据）。  
**并发**由 `FB_GLOBAL_REQUEST_CONCURRENCY`（默认 10）限制；单请求排队过久会超时失败（`FB_GLOBAL_QUEUE_TIMEOUT_MS`）。

### 3.2 Insights 的 spend>0 过滤

默认在 **Facebook 端** 对 Insights 附加过滤：`spend` **大于 0**（减少响应体积）。  
设置环境变量 `DISABLE_SPEND_FILTERING=1` 可关闭服务端 filtering，但业务侧仍会 **本地再过滤 spend>0**，避免写入零花费噪声数据。

---

## 四、统一心跳：今日路径（`syncAccountTodayStats`）

**典型场景**：账户在本地为「白天」且本轮为「今日、不滑窗」时，对每个活跃账户执行。

### 4.1 账户时区（按需 1 次）

- **请求**：`GET /{act_广告账户ID}?fields=timezone_name`  
- **说明**：若数据库已有可靠时区，可不再请求，减少调用。

### 4.2 账户级广告 Insights（Insights First）

- **请求**：`GET /{act_xxx}/insights`  
- **要点**：`level=ad`，`date_preset=today`，`use_account_attribution_setting=true`，并（默认）带 spend>0 的 `filtering`。  
- **fields（完整集）**：  
  `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,cpc,cpm,inline_link_clicks,unique_inline_link_clicks,actions,action_values,unique_actions,cost_per_action_type,purchase_roas,website_purchase_roas`  
  若 Graph 报部分字段无效，会 **自动降级** 为略短的字段集再试。  
- **分页**：按 `paging.next` 完整链接翻页，直到无下一页。  
- **业务含义**：先拿到「今日有花费」的广告维度指标，再落库（经写入队列）。

### 4.3 批量解析广告对象（同轮一次）

- **请求**：`GET /?ids=id1,id2,...&fields=...`（每批最多约 50 个 id）  
- **fields**：  
  `id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time`  
- **业务含义**：补齐 `campaign_id` / `adset_id`、状态等，避免 Insights 行缺层级信息。

### 4.4 Piggyback（可选）

若本轮已有结构缓存仍不足以写 `structure_ads`，会对 **缺口广告 id** 再调用一次 `/?ids=`（字段与结构模块 `ADS_FIELDS` 一致），**尽力而为**，失败不阻断主链路。

---

## 五、统一心跳：滑动窗口路径（`syncAccountSlidingWindow`）

**典型场景**：夜间回补 `last_7d` / `last_14d`，或白天整点回补 `last_3d` 等（由 `unifiedHeartbeatSync` 内按时区与小时策略决定）。

### 5.1 活跃广告从哪里来

**不**先调用 `act_xxx/ads` 全量拉列表。活跃 `ad_id` 来自 **本地库**：近 N 天在 `daily_stats` 或 `ad_snapshots` 中 **spend>0** 的去重集合，以控制配额。

### 5.2 广告状态

- **请求**：`GET /?ids=...&fields=id,name,effective_status,status,configured_status`

### 5.3 今日快照：Batch Insights

- **请求**：`POST /`（Graph **Batch**），`batch` 为最多 **50** 条子请求。  
- **每条子请求**：`GET {ad_id}/insights?fields=...&date_preset=today&use_account_attribution_setting=true&filtering=...`  
- **fields**：  
  `ad_id,ad_name,adset_id,spend,actions,action_values,unique_actions,cost_per_action_type,cost_per_unique_link_click,cost_per_unique_inline_link_click,inline_link_clicks,unique_inline_link_clicks,purchase_roas,website_purchase_roas`  
- **说明**：批次间可根据响应头 `x-business-use-case-usage` 做动态休眠。

### 5.4 历史按日：Batch + `time_increment=1`

- **子请求形态**：`{ad_id}/insights?fields=同上&time_increment=1&since=YYYY-MM-DD&until=YYYY-MM-DD&use_account_attribution_setting=true`  
- **日期**：在账户时区下计算；滑动窗口里 **按日部分通常截止到昨天**，与「今日」快照分工，用于 **`daily_stats`** 与归因修正。

---

## 六、结构同步：Track2 与 Track1 轮转

用于维护 **Campaign / Adset / Ad** 结构镜像（与 Insights 管道独立，但共享客户端封装）。

### 6.1 三边字段（代码常量）

- **Campaigns**：`id,name,effective_status,status,updated_time,created_time`  
- **Adsets**：`id,name,effective_status,status,campaign_id,updated_time,created_time`  
- **Ads**：`id,name,effective_status,status,configured_status,adset_id,campaign_id,updated_time,created_time`

### 6.2 第一跳：统一 Batch（三边各一页）

- **请求**：`POST /`，`batch` 内含三条相对路径：  
  `{act}/campaigns`、`{act}/adsets`、`{act}/ads`  
- **公共参数**：`fields` 见上；`limit` 默认 500（上限 500）；  
  `filtering`：`updated_time` **大于** 某时间戳（Unix 秒为主，失败时可能尝试 ISO 字符串回补）。

### 6.3 软分页（游标）

若某一 edge 仍有多页，则对 `campaigns` / `adsets` / `ads` 分别：  
`GET /{act}/{edge}?...&after=<cursor>`，页间 **约 1.2s** 间隔，且每 edge 最多翻 **若干页**（默认可通过环境变量配置，且有硬上限），避免长任务占满配额。

### 6.4 Track2 合并写库

开启合并模式时：多账户先 **只采集** 再 **批量 Upsert**，合并阶段 **不再发 Graph**。

---

## 七、广告账户列表（每小时）

- **请求**：`GET /me/adaccounts?fields=id,name,account_id&limit=200`  
- **分页**：使用 `paging.next` 直到结束。  
- **业务**：更新已存在账户名称；**新账户**通常仅记录日志，需在后台人工录入并绑定负责人（避免无主数据）。

---

## 八、环境变量速查（影响行为）

| 变量 | 作用 |
|------|------|
| `FACEBOOK_ACCESS_TOKEN` | 全局鉴权 |
| `DISABLE_SPEND_FILTERING` | 关闭 Insights 服务端 spend 过滤 |
| `ENABLE_TRACK2_FAST_SYNC` | 是否跑 Track2 Cron |
| `TRACK2_FAST_SYNC_*` | 白名单、并发、每页条数、软分页上限、时间缓冲、使用率阈值、是否合并 Upsert 等 |
| `ENABLE_UNIFIED_STRUCTURE_BATCH` | 结构轮转是否走统一 Batch 快路径 |
| `PAUSE_STRUCTURE_SYNC` | 暂停每小时结构轮转 |
| `FB_GLOBAL_REQUEST_CONCURRENCY` / `FB_GLOBAL_QUEUE_TIMEOUT_MS` | 全局并发与排队超时 |

---

## 九、修订与免责

- 本文内容与当前代码中 **Graph 版本、`fields` 字符串、Cron 表达式** 对齐；升级 API 版本或改字段后，应以仓库源码为准更新本文。  
- Facebook 侧字段可用性可能因账户、权限、对象类型略有差异；代码中已对部分 Insights 字段做了 **降级重试**。

---

**源码索引（内部维护）**：`cronService.js`（调度）、`ingestorService.js`（Insights 与滑动窗口）、`structureSyncService.js`（结构与 Piggyback）、`accountSyncService.js`（账户列表）、`server/index.js`（`FacebookMarketingAPI`）。