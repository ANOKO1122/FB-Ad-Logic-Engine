# CPM（千次展示费用）条件指标添加方案

> 日期：2026-05-21 | 类型：功能增强 | 优先级：P2

---

## 一、可行性结论

**可以加，数据已存在，管道只缺几处补字段。** 但多天窗口下 CPM 无法正确聚合，需限制为单天窗口。

---

## 二、现有基础检查

| 环节 | 状态 | 说明 |
|------|:--:|------|
| Facebook API 返回 CPM | ✅ | `index.js:1330` `fullFields` 含 `cpm`，:1372 解析 |
| `ad_snapshots.cpm` 列 | ✅ | `decimal(10,4)`，存入 Facebook 每日 CPM 值 |
| `daily_stats.cpm` 列 | ✅ | `decimal(10,4)`，归档时写入 |
| `RuleEngine.getMetricValue` | ✅ | `index.js:2654` 已有 `case 'cpm'` |
| **规则查询 SQL SELECT `cpm`** | ❌ | `ruleDataService.js` 的 ad_snapshots / daily_stats SELECT 都没选 |
| **规则查询 mapper 透传 `cpm`** | ❌ | `queryAdSnapshots` maps 和 `queryDailyStatsForRange` maps 都没有 |
| **`calculateSingleDayMetrics` 处理 `cpm`** | ❌ | 单天指标计算未包含 CPM |
| **`aggregateMultiDayMetrics` 处理 `cpm`** | ❌ | 多天聚合未包含 CPM（且无 impressions 无法重算） |
| 前端 `BASE_METRIC_OPTIONS` | ❌ | 无 CPM |
| 后端 `VALID_METRICS` | ❌ | 无 `cpm` |
| 审计 `METRIC_LABEL` | ❌ | 无 CPM |
| 模板页面指标下拉 | ❌ | 无 CPM |

---

## 三、多天聚合的限制（重要）

CPM 公式：`spend / impressions * 1000`

系统**不存储 `impressions` 数据**（数据库无此列）。Facebook 返回的是每日预计算的 CPM 值，存入了 `ad_snapshots.cpm` 和 `daily_stats.cpm`。

| 窗口类型 | 能否正确取值 | 方式 |
|----------|:--:|------|
| `today` | ✅ | 直接取 `ad_snapshots.cpm`（单天，不需聚合） |
| `yesterday` | ✅ | 直接取 `daily_stats.cpm` 或 ad_snapshots（单天） |
| 多天窗口（含/不含今天） | ⚠️ 受限 | 每日 CPM 无法正确合并为"多天总 CPM"，因为缺少 impressions 做分子分母重算 |

**处理策略**：
- **单天窗口**：直接用 Facebook 预计算的 CPM 值，正确。
- **多天窗口**：`aggregateMultiDayMetrics` 中 CPM 返回 `null`（条件判断时 `null` 不触发条件，与 `purchases_avg_after_create` 的 null 处理一致，已由 `index.js:2565` 的 null guard 保护）。

> 这样不会产生错误判断——多天窗口下 CPM 条件不会误匹配，和"数据不足"的行为一致。

---

## 四、需修改的文件和位置

| # | 文件 | 改动 | 影响 |
|---|------|------|------|
| 1 | `server/services/ruleDataService.js` | ad_snapshots SELECT 加 `cpm` | 单天查询 |
| 2 | `server/services/ruleDataService.js` | `queryAdSnapshots` mapper 加 `cpm` | 数据透传 |
| 3 | `server/services/ruleDataService.js` | daily_stats SELECT 加 `cpm` | 历史查询 |
| 4 | `server/services/ruleDataService.js` | `queryDailyStatsForRange` mapper 加 `cpm` | 数据透传 |
| 5 | `server/services/ruleDataService.js` | `calculateSingleDayMetrics` 加 `cpm` | 单天透传 |
| 6 | `server/services/ruleDataService.js` | `aggregateMultiDayMetrics` 加 `cpm: null` | 多天安全 null |
| 7 | `server/utils/templateValidator.js` | `VALID_METRICS` 加 `'cpm'` | 后端校验 |
| 8 | `src/views/RuleManager.vue` | `BASE_METRIC_OPTIONS` 加 CPM | 规则编辑下拉 |
| 9 | `src/views/AdminTemplates.vue` | 模板指标下拉加 CPM 选项 | 模板编辑 |
| 10 | `src/utils/ruleAuditNarrative.js` | `METRIC_LABEL` 加 `cpm: 'CPM（千次展示费用）'` | 审计文案 |

---

## 五、具体代码改动

### 5.1 ruleDataService.js — ad_snapshots SELECT（约第 565 行）

在 `cpc,` 之前加 `cpm,`：

```sql
cpm,
cpc,
```

### 5.2 ruleDataService.js — ad_snapshots 另一处 SELECT（约第 620 行）

同样在 `cpc,` 之前加 `cpm,`。

### 5.3 ruleDataService.js — ad_snapshots mapper（约第 683 行）

在 `cpc: null,` 之前加：

```js
cpm: row.cpm != null ? parseFloat(row.cpm) : null,
```

### 5.4 ruleDataService.js — daily_stats SELECT（约第 892 行）

在 `cpc,` 之前加 `cpm,`。

### 5.5 ruleDataService.js — daily_stats mapper（约第 914 行）

在 `cpc: null,` 之前加：

```js
cpm: row.cpm != null ? parseFloat(row.cpm) : null,
```

### 5.6 ruleDataService.js — calculateSingleDayMetrics（约第 1250 行）

在 `cpc:` 行之前加：

```js
cpm: dailyStats.cpm != null ? parseFloat(dailyStats.cpm) : null,
```

### 5.7 ruleDataService.js — aggregateMultiDayMetrics（约第 1160 行）

在结果对象中加（与其他成本类指标并列）：

```js
// CPM：多天聚合无法重算（缺少 impressions），返回 null
cpm: null,
```

### 5.8 templateValidator.js — VALID_METRICS（约第 25 行）

```js
const VALID_METRICS = [
  'spend', 'roas', 'cpa', 'cpc', 'cpm', 'purchases', 'link_clicks',  // cpm 新增
  ...
]
```

### 5.9 RuleManager.vue — BASE_METRIC_OPTIONS（约第 1139 行）

```js
{ value: 'cpm', label: 'CPM（千次展示费用）' },
```

### 5.10 AdminTemplates.vue — 指标下拉

在 `RuleManager.vue` 同位置添加：

```html
<option value="cpm">CPM（千次展示费用）</option>
```

以及在 `METRIC_LABELS` 对象中添加 `cpm: 'CPM（千次展示费用）'`。

### 5.11 ruleAuditNarrative.js — METRIC_LABEL（约第 305 行）

```js
cpm: 'CPM（千次展示费用）',
```

---

## 六、影响分析

### 6.1 不影响现有逻辑

| 模块 | 是否影响 | 原因 |
|------|:--:|------|
| 现有规则条件判断 | ❌ | 不选 CPM 的规则行为完全不变 |
| ROAS/CPA/CPC 计算 | ❌ | 这些是本地计算的，不需要 cpm |
| 同层聚合（adset/campaign） | ❌ | `queryRuleDataByLevel` 只处理 spend/purchases/link_clicks |
| 冷却机制 | ❌ | 无关 |
| 执行动作 | ❌ | CPM 只做条件指标，不做动态预算指标（不需要在 dynamicBudgetMetricOptions 加） |
| 数据库写入 | ❌ | 只读不改 |
| 已有规则 | ❌ | 老数据返回 `cpm: null`，条件判断被 null guard 拦截，不会误触发 |

### 6.2 null 安全保障

`RuleEngine.evaluateCondition`（`index.js:2565`）已有：
```js
if (metricValue == null || Number.isNaN(Number(metricValue))) {
  return condition.operator === 'ne' ? metricValue !== condition.value : false
}
```

多天窗口 CPM 为 `null` → 不满足条件 → 不会误触发。

### 6.3 性能影响

| 指标 | 说明 |
|------|------|
| 查询性能 | 多 SELECT 一个 decimal 列，影响可忽略 |
| 内存 | 每条广告多一个 float 字段 |
| 聚合性能 | aggregateMultiDayMetrics 只赋值 `null`，无计算开销 |

---

## 七、不改的地方（有意排除）

| 位置 | 原因 |
|------|------|
| `dynamicBudgetMetricOptions` | CPM 不适合做预算公式指标（$3 CPM × 30 = $90 日预算，语义不直观） |
| 同层聚合 `queryRuleDataByLevel` | adset/campaign 层没有 impressions，暂时不开放 |
| `aggregateMultiDayMetrics` 重算 CPM | 缺少 impressions，设 null 安全 |

---

## 八、总结

| 维度 | 说明 |
|------|------|
| 改动文件 | 5 个 |
| 新增字段 | `cpm`（已有 DB 列，仅补查询管道） |
| 多天限制 | CPM 仅单天窗口正确，多天返回 null（安全） |
| 破坏性变更 | 无 |
| 兼容性 | 老规则不受影响 |
