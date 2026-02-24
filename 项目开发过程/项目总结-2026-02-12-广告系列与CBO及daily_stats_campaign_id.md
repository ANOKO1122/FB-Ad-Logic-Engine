# 项目总结：2026-02-12 广告系列与 CBO 及 daily_stats campaign_id

本窗口完成「规则目标层级 = 广告系列」时的数据与执行闭环、CBO 预算智能路由、编辑回显「未同步」兜底，以及 daily_stats 增加 campaign_id 并回填历史，便于昨日/近三日/近七日等时间窗口下 CBO 规则正常执行。

---

## 一、本窗口目标与范围

- **目标**：  
  1）规则选择「广告系列」时能正确匹配到该系列下广告并执行动作（含增减预算）；  
  2）CBO（系列预算）时执行层自动调 campaign 预算 API，ABO（广告组预算）时调 adset 预算 API；  
  3）编辑规则时已选对象不误标「未同步」；  
  4）昨日/多日时间窗口下规则数据带 campaign_id，CBO 规则可执行。
- **范围**：迁移 020/021/022，ingestorService / ruleDataService / actionExecutorService / structureSyncService，RuleManager CBO 提示，文档与验证清单。

---

## 二、遇到的问题与解决方法

### 2.1 广告系列规则匹配 0 个广告 / 查询 campaign 下的广告ID失败

**问题**：目标层级选「广告系列」、选好系列并执行时，日志出现「查询 campaign 下的广告ID失败」「匹配 0 个广告」。

**根因**：规则引擎按 `campaign_id` 在 `ad_snapshots` 中查目标广告，但表结构只有 `ad_set_id`，没有 `campaign_id` 列，SQL 报错或查不到。

**解决**：  
- 迁移 020：`ad_snapshots` 增加 `campaign_id` 列。  
- ingestorService：Today 同步写入 snapshot 时从 insight/结构数据带出 `campaign_id` 并写入；INSERT/UPDATE 含 `campaign_id`。  
- ruleDataService：ad_snapshots 查询 SELECT 与返回含 `campaign_id`；**calculateSingleDayMetrics 返回对象增加 campaign_id**（否则单天数据被丢弃）；**aggregateMultiDayMetrics 结果增加 campaign_id**（从任一天取，多天窗口保留）。  
- server/index.js：evaluateRule / evaluateRuleWithData 的 matchedAds 含 `campaign_id`；resolveTargetAdIds 按 `campaign_id` 筛选。

### 2.2 CBO 执行增减预算时报 400 或「无 campaign_id」

**问题**：  
- updateAdsetBudget 用 query 传参导致 FB API 400。  
- CBO 时执行层需要调 campaign 预算，但 matchedAd 无 campaign_id。

**解决**：  
- updateAdsetBudget / updateCampaignBudget 均改为 **POST body** 传参。  
- server/index.js 新增 getCampaignBudget、getCampaignBudgetDetail、updateCampaignBudget；getAdsetBudgetDetail 返回 daily_budget/lifetime_budget。  
- actionExecutorService：increase_budget/decrease_budget 先 getAdsetBudgetDetail；有 daily/lifetime 走 ABO（updateAdsetBudget），否则走 CBO（用 matchedAd.campaign_id + getCampaignBudgetDetail + updateCampaignBudget）；日志区分「广告组」与「广告系列(CBO)」。  
- 单天/多天数据流确保 campaign_id 传到 matchedAds（见 2.1 的 calculateSingleDayMetrics、aggregateMultiDayMetrics 修复）。

### 2.3 编辑规则时已选对象显示「id (未同步)」而列表同条有名称

**问题**：回显只查 structure_ads，若该广告仅在 ad_snapshots 有、structure_ads 暂无，则被标 missing，显示「(未同步)」。

**解决**：structureSyncService.resolveStructureAdsByIds 在 structure_ads 未命中时，用 ad_snapshots 按 ad_id 取最新一条的 ad_name 兜底返回，避免误标未同步。

### 2.4 昨日/多日时间窗口下 CBO 规则缺 campaign_id

**问题**：daily_stats 表无 campaign_id，昨日（仅冷数据）或历史段数据无该字段，执行层拿不到 campaign_id 无法调 campaign 预算。

**解决**：  
- 迁移 021：daily_stats 增加 `campaign_id`。  
- 迁移 022：用 ad_snapshots 同广告最新快照回填历史行 campaign_id（用户本地执行）。  
- ingestorService：archiveDailyStats、updateDailyStatsFromInsights 写入 campaign_id。  
- ruleDataService：queryDailyStats、queryDailyStatsForRange 的 SELECT 与返回含 campaign_id。

---

## 三、修改点汇总

| 类别 | 文件/位置 | 变更要点 |
|------|-----------|----------|
| 迁移 | 020_add_campaign_id_to_ad_snapshots.sql | ad_snapshots 加 campaign_id |
| 迁移 | 021_add_campaign_id_to_daily_stats.sql | daily_stats 加 campaign_id |
| 迁移 | 022_backfill_daily_stats_campaign_id.sql | 历史 daily_stats 回填 campaign_id |
| 写入 | ingestorService.js | Today 同步写 campaign_id；archiveDailyStats / updateDailyStatsFromInsights 写 campaign_id |
| 规则数据 | ruleDataService.js | queryAdSnapshots/queryDailyStats/queryDailyStatsForRange 含 campaign_id；calculateSingleDayMetrics、aggregateMultiDayMetrics 带出 campaign_id |
| 规则引擎 | server/index.js | matchedAds 含 campaign_id；resolveTargetAdIds 按 campaign_id；getCampaignBudgetDetail/updateCampaignBudget（body）；getAdsetBudgetDetail；updateAdsetBudget 用 body |
| 执行层 | actionExecutorService.js | increase_budget/decrease_budget ABO/CBO 分流，CBO 用 matchedAd.campaign_id |
| 回显 | structureSyncService.js | resolve 用 ad_snapshots 兜底 name |
| 前端 | RuleManager.vue | 存在增减预算时展示 CBO 说明框（hasBudgetAction + .cbo-hint） |
| 文档 | docs/规则管理_*、daily_stats_campaign_id_执行说明.md | 问题与方案、整体验证清单、全面检查与遗漏分析、执行说明（021/022 命令与回填替代写法） |

---

## 四、项目目标与进度（本窗口后）

### 项目目标（简述）

- **定位**：Facebook Marketing API 智能监控与自动化规则系统，7x24h 无人值守、多账户隔离、可审计。  
- **本窗口贡献**：规则「广告系列」目标 + CBO 预算 + 昨日/多日数据口径闭环；daily_stats 具备 campaign_id，近三日/五日/七日 CBO 规则可稳定执行。

### 验收情况

- **today + 广告系列 + CBO 增减预算**：已通过（匹配 ≥1，执行成功，日志「广告系列(CBO)」）。  
- **last_3_days + 广告系列 + CBO**：已通过（规则数据 1 条，执行成功，当前预算 3000→新预算 3300）。  
- **昨日**：依赖 daily_stats 有「昨天」数据，需每日冷数据落盘；数据到位后 CBO 规则可执行。  
- **daily_stats campaign_id**：021/022 已执行，回填 840 行；新归档与按日写入带 campaign_id。

### 后续建议

- **运维**：保证每日执行一次 archiveDailyStats（定时任务），「昨天」规则才有数据。  
- **可选**：在运维/部署文档中注明「昨日规则依赖每日冷数据落盘」。  
- **下一窗口**：按 DEV_PLAN 继续 Step 4 体验与完整性、4.2 IM 机器人等。

---

## 五、相关文档

- `docs/规则管理_广告系列与未同步回显_问题与方案.md`  
- `docs/规则管理_广告系列与CBO_整体验证清单.md`  
- `docs/规则管理_广告系列与CBO_全面检查与遗漏分析.md`  
- `docs/daily_stats_campaign_id_执行说明.md`
