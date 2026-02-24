# 规则管理：广告系列与 CBO — 全面检查与遗漏分析

基于「广告系列层级支持 + CBO 预算 + 未同步回显」本次所有修改的检查结果与已知限制。

---

## 一、本次修改清单（已覆盖）

| 类别 | 文件/位置 | 变更要点 |
|------|-----------|----------|
| 库表 | `server/db/migrations/020_add_campaign_id_to_ad_snapshots.sql` | ad_snapshots 增加 campaign_id |
| 写入 | `server/services/ingestorService.js` | Today 同步写入 campaign_id（insight + structure 兜底）；INSERT/UPDATE 含 campaign_id |
| 规则数据 | `server/services/ruleDataService.js` | queryAdSnapshots SELECT/返回 campaign_id；**calculateSingleDayMetrics 返回对象增加 campaign_id**；**aggregateMultiDayMetrics 结果增加 campaign_id**（多天窗口时从任一天取） |
| 规则引擎 | `server/index.js` | evaluateRule / evaluateRuleWithData 的 matchedAds 含 campaign_id；resolveTargetAdIds 按 campaign_id 筛选；updateAdsetBudget 用 POST body；getCampaignBudget / getCampaignBudgetDetail / updateCampaignBudget；getAdsetBudgetDetail |
| 执行层 | `server/services/actionExecutorService.js` | increase_budget/decrease_budget 智能路由（ABO 调 adset，CBO 调 campaign）；CBO 使用 matchedAd.campaign_id |
| 回显 | `server/services/structureSyncService.js` | resolveStructureAdsByIds 在 structure_ads 未命中时用 ad_snapshots 兜底 name |
| 前端 | `src/views/RuleManager.vue` | 存在「增加/减少预算」时展示 CBO 说明框（hasBudgetAction + .cbo-hint） |
| 单测 | `server/tests/actionExecutorBudgetIdempotent.test.js`、`preFlight.test.js` | getAdsetBudgetDetail mock |

---

## 二、已修复的遗漏

1. **calculateSingleDayMetrics 未带出 campaign_id**  
   - 现象：规则数据经此函数后 campaign_id 被丢弃，执行层报「CBO 广告系列但无 campaign_id」。  
   - 修复：在返回对象中增加 `campaign_id: dailyStats.campaign_id ?? null`。

2. **多天窗口下 campaign_id 丢失**  
   - 现象：time_window 为 last_7_days 等时，数据来自「历史 daily_stats + 今天 ad_snapshots」合并后聚合，aggregateMultiDayMetrics 只从 days[0] 取基本信息，未带 campaign_id。  
   - 修复：在 aggregateMultiDayMetrics 中增加 `campaign_id`，取值逻辑为：任一天有则用（优先保留 today 带来的 campaign_id），否则 null。

---

## 三、已知限制与建议

1. **daily_stats 表无 campaign_id**  
   - 当前 daily_stats 未增加 campaign_id 列，归档/历史数据也不写该字段。  
   - 影响与改前改后对比见下节「daily_stats 是否加 campaign_id」。

2. **日志中的预算数值核对**  
   - 日志示例：`当前预算: 3000 分，新预算: 1500 分`，若规则为「增加 10%」，则正确结果应为 3300 分；1500 对应的是「减少 50%」。  
   - 建议：确认规则配置为「增加预算 10%」还是「减少预算 50%」；若确为增加 10% 却得到 1500，需排查 getCampaignBudgetDetail 返回单位或 computeNewBudgetCentsOnce 入参。

3. **TLS 连接错误与回退**  
   - 日志中可能出现 `❌ TLS连接错误` 后紧跟 `✅ JSON解析成功（由TLS错误回退路径完成）`，多为代理/长连接下的正常回退，业务已解析到响应。若出现真实请求失败，再单独排查网络/代理。

---

## 四、daily_stats 是否加 campaign_id：影响与改前改后对比

### 4.1 什么时候会用到 daily_stats（不带 today）？

- **yesterday**：时间窗口选「昨日」且当前时间已过归档点（如 06:00 后），数据**只**从 daily_stats 查，不会用 ad_snapshots。
- **last_7_days / last_30_days**：历史段从 daily_stats 查，今天段从 ad_snapshots 查，再合并聚合。此时今天段带 campaign_id，聚合时已从「任一天」取 campaign_id，所以**多天窗口目前不受影响**。

因此，**唯一会缺 campaign_id 的场景**是：规则时间窗口 = **yesterday**，且未触发「空结果降级到 ad_snapshots」。

### 4.2 影响（不改时）

| 项目 | 说明 |
|------|------|
| **谁受影响** | 仅「时间窗口 = 昨日」且「动作含增减预算」且「命中的广告属于 CBO」的规则。 |
| **表现** | 规则能匹配到广告、条件评估正常，但执行增减预算时执行层拿不到 campaign_id，日志出现「CBO 广告系列但无 campaign_id，无法调整预算」，该条动作失败。 |
| **其他** | 时间窗口为 today / last_7_days 等、或昨日但降级到 ad_snapshots、或规则没有预算动作、或只是 ABO 广告，都不受影响。 |

### 4.3 改前 vs 改后（若给 daily_stats 加 campaign_id）

| 维度 | 不改（现状） | 改（daily_stats 加列 + 归档写 + 查询返回） |
|------|----------------|---------------------------------------------|
| **昨日 + CBO + 增减预算** | 执行失败，缺 campaign_id | 可正常执行，与 today 行为一致 |
| **数据来源** | 昨日只看 daily_stats，无 campaign_id | 昨日 daily_stats 行带 campaign_id，规则数据与执行层都能拿到 |
| **归档逻辑** | 归档只写现有字段 | 归档需从 ad_snapshots 或结构数据带出 campaign_id 写入 daily_stats |
| **表结构** | 无新列 | 新增一列，历史行为 NULL 或需回填 |

### 4.4 优缺点简表

|  | 不改 | 改 |
|--|------|-----|
| **优点** | 无迁移、无改归档与查询，维护简单；昨日 CBO 预算若用得少，可接受失败 | 昨日 CBO 规则与 today 一致，都能调系列预算；行为统一、可预期 |
| **缺点** | 昨日 + CBO + 增减预算 会稳定失败，需向用户说明或避免该组合 | 要做迁移、改归档写入与查询，并考虑历史数据是否回填 campaign_id |

### 4.5 建议

- **若几乎不用「昨日」+ CBO + 增减预算**：可以不改，在文档/产品里说明「昨日窗口下 CBO 预算动作可能失败」即可。
- **若希望昨日与今天行为一致、支持昨日 CBO 调预算**：建议做「daily_stats 加 campaign_id + 归档写入 + 查询返回」；历史行可先保持 NULL，只保证新归档带 campaign_id，规则数据层对 null 已有兼容。

---

## 五、验证建议（与整体验证清单一致）

- **today + 广告系列规则 + CBO**：已通过（匹配 1 个、走 CBO、成功增加/减少预算）。  
- **多天窗口**：若使用 last_7_days 等且目标为 CBO，执行一次规则确认日志中无「无 campaign_id」且能成功调 campaign 预算（当前已通过 aggregateMultiDayMetrics 保留 campaign_id）。  
- **yesterday 仅冷数据**：若 06:00 后使用 yesterday 且未降级，CBO 规则可能仍缺 campaign_id，属上述「已知限制 1」。

---

## 六、小结

- 本次修改已覆盖：迁移、写入、规则数据（含单天与多天）、规则引擎、执行层、回显、前端提示、单测。  
- 已补两处遗漏：单天指标计算与多天聚合均带出 campaign_id。  
- 剩余已知限制：daily_stats 无 campaign_id（影响纯 yesterday 冷数据下的 CBO）；日志预算数值需与规则配置一致。按需可后续为 daily_stats 增加 campaign_id 并写入/查询。
