---
name: time-window-upgrade
overview: 扩展规则时间窗口枚举，新增含今天/不含今天的近 N 天窗口，并把 `lifetime` 从固定 1970 起点改为按对象创建时间到今天的聚合口径。方案保持现有“先聚合、再判断条件”的规则执行模型不变。
todos:
  - id: sync-window-enums
    content: 同步前端下拉、模板页面、审计文案与后端校验中的时间窗口枚举。
    status: completed
  - id: implement-date-boundaries
    content: 在 `timeWindow.js` 中实现含今天与不含今天的近 3/5/7 天日期边界。
    status: completed
  - id: update-ad-query
    content: 改造广告层多天取数，让不含今天窗口只查 `daily_stats`，含今天窗口继续合并今天快照。
    status: completed
  - id: verify-level-aggregation
    content: 确认并测试广告组/广告系列同层聚合在新窗口下的 `includeToday` 行为。
    status: completed
  - id: implement-lifetime-created-time
    content: 将 `lifetime` 改为按结构表 `created_time` 起算，并处理缺失创建时间的 warning 与兜底。
    status: completed
  - id: add-tests
    content: 补充时间边界、数据源选择、同层聚合和 `lifetime` 创建时间起点测试。
    status: completed
isProject: false
---

# 时间窗口升级执行方案

## 背景与核心原则

当前规则判断链路是：时间窗口取数 -> 多天聚合 -> 条件判断。这个模型要保持不变，因为它能让 `spend`、`purchases` 这类计数字段做求和，并让 `cpa`、`roas`、`cpc` 这类比率字段用总分子/总分母重算，避免多日平均带来的口径错误。

本次改造只改变“时间窗口如何确定日期范围”和“是否合并今天实时数据”，不改变 `evaluateRuleWithData()` 的条件判断方式。

```mermaid
flowchart LR
  ruleConfig[Rule Config] --> timeWindow[Time Window]
  timeWindow --> dataQuery[Data Query]
  dataQuery --> aggregate[Aggregate Metrics]
  aggregate --> conditionEval[Condition Evaluation]
  conditionEval --> actions[Actions]
```

## 里程碑1：统一时间窗口枚举

[目标]

把新增窗口先定义成稳定枚举，前端、后端校验、审计文案、模板页面共用同一套值。

[具体改动方案]

在以下文件同步新增枚举与显示文案：

- [`/root/work/FB-Ad-Logic-Engine/src/views/RuleManager.vue`](/root/work/FB-Ad-Logic-Engine/src/views/RuleManager.vue)
- [`/root/work/FB-Ad-Logic-Engine/src/views/AdminTemplates.vue`](/root/work/FB-Ad-Logic-Engine/src/views/AdminTemplates.vue)
- [`/root/work/FB-Ad-Logic-Engine/src/utils/ruleAuditNarrative.js`](/root/work/FB-Ad-Logic-Engine/src/utils/ruleAuditNarrative.js)
- [`/root/work/FB-Ad-Logic-Engine/server/utils/templateValidator.js`](/root/work/FB-Ad-Logic-Engine/server/utils/templateValidator.js)
- [`/root/work/FB-Ad-Logic-Engine/server/services/ruleEngineDispatcher.js`](/root/work/FB-Ad-Logic-Engine/server/services/ruleEngineDispatcher.js)，仅在需要兼容短别名时补充。

建议枚举：

- `today`：今天。
- `yesterday`：昨天。
- `last_3_days`：近3天，包含今天，保持现有语义。
- `last_3_days_excluding_today`：近3天，不包含今天。
- `last_5_days`：近5天，包含今天。
- `last_5_days_excluding_today`：近5天，不包含今天。
- `last_7_days`：近7天，包含今天。后端已有，前端补展示。
- `last_7_days_excluding_today`：近7天，不包含今天。
- `lifetime`：文案从“累计”改为“至今为止”。
- `custom_range`：自定义范围，保持不变。

[原因和理由]

时间窗口值会被规则 JSON、模板 JSON、审计日志和后端校验共同引用。先统一枚举，可以避免前端能保存、后端拒绝，或规则执行能识别、审计日志显示 `undefined` 的割裂问题。

[验收标准]

新建规则、模板规则、审计日志里都能看到同一套中文文案；提交包含新增窗口的规则时，`templateValidator` 不再报 `when_time_window 不支持`。

## 里程碑2：实现含今天与不含今天的日期边界

[目标]

让 `server/utils/timeWindow.js` 精确计算每个窗口的自然日边界，且全部基于账户数据时区。

[具体改动方案]

修改 [`/root/work/FB-Ad-Logic-Engine/server/utils/timeWindow.js`](/root/work/FB-Ad-Logic-Engine/server/utils/timeWindow.js) 的 `calculateTimeWindow()`：

```js
// 含今天：从 N-1 天前 00:00:00 到今天 23:59:59.999
last_3_days: now.minus({ days: 2 }).startOf('day') -> now.endOf('day')
last_5_days: now.minus({ days: 4 }).startOf('day') -> now.endOf('day')
last_7_days: now.minus({ days: 6 }).startOf('day') -> now.endOf('day')

// 不含今天：从 N 天前 00:00:00 到昨天 23:59:59.999
last_3_days_excluding_today: now.minus({ days: 3 }).startOf('day') -> now.minus({ days: 1 }).endOf('day')
last_5_days_excluding_today: now.minus({ days: 5 }).startOf('day') -> now.minus({ days: 1 }).endOf('day')
last_7_days_excluding_today: now.minus({ days: 7 }).startOf('day') -> now.minus({ days: 1 }).endOf('day')
```

同时补充单元测试，固定测试时钟，避免测试受当天日期影响。

[原因和理由]

“近3天”在业务上有两种常见口径：含今天与不含今天。当前代码里的 `last_3_days` 已明确包含今天，所以新增不含今天窗口不能复用旧枚举，必须新增枚举值表达新业务语义。

[验收标准]

假设账户时区今天是 `2026-05-12`：

- `last_3_days` 返回 `2026-05-10` 到 `2026-05-12`。
- `last_3_days_excluding_today` 返回 `2026-05-09` 到 `2026-05-11`。
- `last_5_days_excluding_today` 返回 `2026-05-07` 到 `2026-05-11`。
- `last_7_days_excluding_today` 返回 `2026-05-05` 到 `2026-05-11`。

## 里程碑3：调整普通广告层多天取数

[目标]

广告层规则保持“窗口内聚合后判断”，但根据窗口是否包含今天决定是否合并 `ad_snapshots`。

[具体改动方案]

修改 [`/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js`](/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js)：

- `selectDataSource()` 新增 `last_5_days`、`last_3_days_excluding_today`、`last_5_days_excluding_today`、`last_7_days_excluding_today`，全部返回 `source: 'daily_stats'` 与 `needAggregation: true`。
- 把当前 `queryMultiDayWithToday()` 改造为更通用的 `queryMultiDayWindow()`。
- 增加一个小函数，例如 `doesWindowIncludeToday(start, end, timezoneName)`，统一判断窗口是否包含今天。
- 含今天窗口：历史段查 `daily_stats`，今天段查 `ad_snapshots`，再聚合。
- 不含今天窗口：只查 `daily_stats`，不执行 `queryAdSnapshots(..., 'today')`。

[原因和理由]

`daily_stats` 是每日归档表，适合查询昨天及更早日期；`ad_snapshots` 是今天实时热表，适合补齐今天。新增“不含今天”窗口如果继续拼接 `ad_snapshots`，会把今天数据误加入，导致规则过早触发或误触发。

[验收标准]

- `last_3_days` 的结果包含历史段与今天段。
- `last_3_days_excluding_today` 的结果只来自 `daily_stats`。
- 聚合后的 `spend`、`purchases` 为窗口内求和。
- 聚合后的 `cpa`、`roas`、`cpc` 使用总分子/总分母重算。

## 里程碑4：调整广告组/广告系列同层聚合

[目标]

让 `adset` 与 `campaign` 规则也支持新增窗口，并与广告层保持同一口径。

[具体改动方案]

修改 [`/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js`](/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js) 中的 `queryRuleDataByLevel()`：

- 继续使用 `calculateTimeWindow()` 得到 `startDate` 与 `endDate`。
- 保持现有 `includeToday = startDate <= todayDate && endDate >= todayDate` 逻辑。
- 对 `*_excluding_today`，由于 `endDate` 等于昨天，`includeToday` 会自然变成 `false`。
- `queryLevelAggregateRows()` 与 `queryLevelChildrenRows()` 继续按 `includeHistory` / `includeToday` 组合 SQL。

[原因和理由]

同层聚合已经是“历史段 + 今天段 UNION ALL 后再 GROUP BY 对象”的结构，新增不含今天窗口只需要让日期边界正确，现有 `includeToday` 判断就会阻止今天热表参与查询。

[验收标准]

广告组规则选择 `last_7_days_excluding_today` 时：

- `queryLevelAggregateRows()` 不生成今天段 `ad_snapshots` 子查询。
- 聚合对象仍是 `ad_set_id` 或 `campaign_id`。
- `aggregationTrace.window.timeWindow` 记录新枚举值。

## 里程碑5：把 `lifetime` 改为“至今为止”

[目标]

把 `lifetime` 的业务含义从“1970-01-01 到今天”改成“对象创建时间到今天，包含今天”。

[具体改动方案]

不要只在 `calculateTimeWindow()` 里改 `lifetime`，因为创建时间是每个对象不同的，不能用一个全局 `start` 表达。

建议实现路径：

- 在 [`/root/work/FB-Ad-Logic-Engine/server/utils/timeWindow.js`](/root/work/FB-Ad-Logic-Engine/server/utils/timeWindow.js) 中保留 `lifetime` 的 `end = now.endOf('day')`，但不要再把 `start` 固定为 `1970-01-01` 作为最终查询起点。
- 在 [`/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js`](/root/work/FB-Ad-Logic-Engine/server/services/ruleDataService.js) 中增加创建时间解析逻辑。
- 广告层：从 `structure_ads.created_time` 按 `account_id + ad_id` 读取每个广告的创建时间。
- 广告组层：从 `structure_adsets.created_time` 按 `account_id + adset_id` 读取创建时间。
- 广告系列层：从 `structure_campaigns.created_time` 按 `account_id + campaign_id` 读取创建时间。
- 将 FB ISO8601 字符串转换为账户时区自然日：`DateTime.fromISO(created_time).setZone(timezoneName).startOf('day')`。
- 查询历史数据时加入对象级起点过滤。

广告层建议优先实现为“按广告分别过滤”：

```sql
JOIN structure_ads sa
  ON sa.account_id = daily_stats.account_id
 AND sa.ad_id = daily_stats.ad_id
WHERE daily_stats.date >= DATE(CONVERT_TZ_OR_APP_PARSED_CREATED_TIME)
```

如果不想把时区转换写进 SQL，可以先在 Node 侧查出 `ad_id -> createdDate`，再分组构造查询；对象数量大时需要分批，避免 SQL 过长。

同层聚合建议用目标对象自己的 `created_time` 作为同层对象起点。理由是规则目标是广告组/广告系列时，用户看到和执行的是该对象的生命周期，而不是每条子广告各自不同生命周期。

[原因和理由]

当前 `lifetime` 从 `1970-01-01` 开始只是简化实现，语义上会把“对象不存在之前”的日期也纳入查询范围。虽然多数情况下这些日期没有指标行，但会扩大查询范围，增加历史扫描成本，并且不符合用户看到的“至今为止”含义。

[缺失创建时间处理]

为了可落地，建议明确兜底策略：

- 如果 `created_time` 存在，严格使用创建日作为起点。
- 如果 `created_time` 缺失，记录 warning：`CREATED_TIME_MISSING`。
- 缺失时使用该对象可查到的最早指标日期作为起点；若没有历史指标但今天有快照，则只返回今天数据。

这个兜底能保证规则不中断，同时不会回到 `1970-01-01` 的大范围扫描。

[验收标准]

广告 `ad_1` 创建于 `2026-05-03`，今天是 `2026-05-12`：

- `lifetime` 查询范围是 `2026-05-03` 到 `2026-05-12`。
- 包含今天 `ad_snapshots` 最新快照。
- 不包含 `2026-05-02` 及以前的数据。
- `aggregationTrace.window` 里能看出 `timeWindow = lifetime`，最好补充 `createdSince` 便于审计。

## 里程碑6：补测试与验收脚本

[目标]

用测试锁住边界，避免后续再出现“近N天是否包含今天”的口径回退。

[具体改动方案]

建议新增或修改测试：

- [`/root/work/FB-Ad-Logic-Engine/server/tests/ruleDataService.test.js`](/root/work/FB-Ad-Logic-Engine/server/tests/ruleDataService.test.js)：覆盖多天聚合和单天指标计算。
- 新增 `timeWindow` 边界测试文件，覆盖 `last_3_days`、`last_5_days`、`last_7_days` 及不含今天版本。
- [`/root/work/FB-Ad-Logic-Engine/server/tests/ruleDataService.levelStatus.test.js`](/root/work/FB-Ad-Logic-Engine/server/tests/ruleDataService.levelStatus.test.js)：覆盖同层聚合不含今天不查询 `ad_snapshots`。
- [`/root/work/FB-Ad-Logic-Engine/server/tests/ruleEngineDispatcher.test.js`](/root/work/FB-Ad-Logic-Engine/server/tests/ruleEngineDispatcher.test.js)：确认新枚举能被 dispatcher 正常缓存、去重与执行。
- 前端如已有测试体系，补 `RuleManager.vue` 的选项渲染或至少人工验收。

[验证命令]

优先执行项目已有测试命令，以 `package.json` 为准。若脚本存在，建议顺序为：

```bash
npm test -- --run server/tests/ruleDataService.test.js
npm test -- --run server/tests/ruleDataService.levelStatus.test.js
npm test -- --run server/tests/ruleEngineDispatcher.test.js
```

[验收标准]

- 所有新增窗口可创建、保存、回显、执行。
- `*_excluding_today` 不合并今天快照。
- `last_5_days` 与 `last_7_days` 含今天。
- `lifetime` 起点来自结构表 `created_time`。
- 条件判断仍基于聚合后数据，不改为逐日判断。

## 风险与控制点

- `lifetime` 是本次最高风险点，因为它从全局时间窗口变成对象级时间窗口。控制方式是先实现普通多天窗口，再单独实现 `lifetime`。
- `created_time` 是 `VARCHAR(80)`，必须用 `DateTime.fromISO()` 做格式解析；解析失败要产生 warning，避免静默扩大查询范围。
- 同层聚合和广告层查询路径不同，测试必须同时覆盖 `ad`、`adset`、`campaign`。
- 前端枚举、后端校验、审计文案必须同批更新，否则会出现保存成功但展示异常，或展示可选但保存失败。

## 推荐落地顺序

1. 先实现 `last_3/5/7_days` 与 `*_excluding_today`，完成 UI、校验、时间边界、普通广告层与同层聚合测试。
2. 再把前端 `lifetime` 文案改为“至今为止”，但后端语义先不合并进第一批发布。
3. 最后单独实现 `lifetime` 对象创建时间起点，重点测试 `ad`、`adset`、`campaign` 三层。

这个顺序可以把低风险枚举扩展和高风险生命周期聚合拆开验收，出现问题时更容易定位。