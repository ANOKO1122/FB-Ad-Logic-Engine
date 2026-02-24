# 归档日期口径与 cpc/roas 兜底 — 验证步骤

本文档对应三项改动后的验收：日期口径统一、回退健壮性、冷数据 cpc/roas 单日兜底。

---

## 如何手动触发归档

**目的**：强制对所有活跃账户执行一次「昨日」冷数据归档（使用当前代码逻辑，含 cpc/roas 兜底），便于验证兜底是否生效。

**方式一：命令行脚本（推荐）**

在项目根目录执行：

```bash
node server/scripts/manual-archive.js
```

- 会调用 `manualArchive()`，内部执行 `archiveAllAccountsDailyStats(null, true)`。
- `forceAll=true` 表示忽略时区窗口（06:00–06:09），对所有账户立即归档。
- 每个账户的「昨日」按该账户本地时区计算；若你多数账户在同一时区，则多数会归档同一天（如 2026-02-11）。

**方式二：在代码里单次调用（调试用）**

在任意已加载环境的 Node 里：

```js
import { manualArchive } from './server/services/cronService.js'
await manualArchive()
```

**注意**：

- 手动脚本使用 **forceAll=true**：会**忽略完整性检查**，对所有账户都执行一次归档（ON DUPLICATE KEY UPDATE），因此会重写并更新 cpc/roas 兜底值。日志中会看到「强制重跑归档 (date: xxx, M/N 条)，将更新 cpc/roas 等」。
- 定时任务（非手动）仍会做完整性检查：已完整则跳过，避免重复写。

---

## 触发后如何验证

手动触发归档完成后，在 MySQL 里执行下面 SQL（昨日 = `CURDATE() - INTERVAL 1 DAY`，若你归档的是其他日期，把条件里的日期改成该日期）。

**1. 看「两边都有」且可算 cpc 的行里，cpc 是否被填上**

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN d.cpc IS NOT NULL AND ABS(d.cpc - (d.spend / d.link_clicks)) < 0.0001 THEN 1 ELSE 0 END) AS cpc_filled_ok,
  SUM(CASE WHEN d.cpc IS NULL THEN 1 ELSE 0 END) AS cpc_null
FROM daily_stats d
INNER JOIN (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s ON d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
WHERE d.date = CURDATE() - INTERVAL 1 DAY
  AND d.link_clicks > 0 AND d.spend > 0;
```

**预期**：若归档使用了新逻辑，`cpc_filled_ok` 应 > 0，`cpc_null` 应比触发前减少（之前你这边是 250 行全 null，触发后应有一部分变为 filled_ok）。

**2. 抽查明细（可选）**

```sql
SELECT d.account_id, d.ad_id, d.date,
       d.spend, d.link_clicks,
       d.cpc,
       (d.spend / NULLIF(d.link_clicks, 0)) AS expected_cpc,
       CASE
         WHEN d.cpc IS NULL THEN 'null'
         WHEN ABS(d.cpc - (d.spend / d.link_clicks)) < 0.0001 THEN 'ok'
         ELSE 'mismatch'
       END AS cpc_check
FROM daily_stats d
INNER JOIN (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s ON d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
WHERE d.date = CURDATE() - INTERVAL 1 DAY
  AND d.link_clicks > 0 AND d.spend > 0
ORDER BY d.account_id, d.ad_id
LIMIT 20;
```

**预期**：至少部分行 `cpc_check = 'ok'`，`cpc` 与 `expected_cpc` 一致。

若触发后仍全部为 `cpc_null` / `cpc_check = 'null'`，可能原因：  
（1）该日期被判定为「已归档且完整」而跳过写入（脚本输出或日志里会有「已归档且完整，跳过」）；  
（2）归档脚本报错未写回 DB。可查看脚本输出中的「本次归档账户」「归档记录数」及日志里是否有「归档完成，共 N 条」。

---

## 1. 日期一致性（date_start 优先）

对比昨日 `ad_snapshots.data_date` 与 `daily_stats.date` 的分布是否一致：

```sql
-- 昨日 ad_snapshots 条数（按 data_date）
SELECT COUNT(*) AS cnt_snapshots
FROM ad_snapshots
WHERE data_date = CURDATE() - INTERVAL 1 DAY;

-- 昨日 daily_stats 条数（按 date）
SELECT COUNT(*) AS cnt_daily_stats
FROM daily_stats
WHERE date = CURDATE() - INTERVAL 1 DAY;
```

预期：两者在业务上应对齐（同一自然日）；若存在时区或拉取延迟，可接受小幅差异，但不应出现“同一天 ad_snapshots 有大量数据而 daily_stats 为 0”的情况。

---

## 2. 回退健壮性（startTime/endTime）

- **方法**：人为让 ROW_NUMBER 主路径抛错（例如在 `archiveDailyStats` 里临时把 SQL 关键字改错，或在不支持窗口函数的 MySQL 版本上跑）。
- **预期**：日志出现“ROW_NUMBER() 不支持，使用兼容方案”，且 `queryLastSnapshotCompatible(accountId, startTime, endTime)` 被调用，不报 `startTime/endTime is not defined`，归档能完成或正常返回 0 条。

---

## 3. 单日兜底效果（cpc/roas）

- **cpc**：找一条 `link_clicks > 0` 且 `spend > 0` 的归档记录，检查 `daily_stats.cpc = spend / link_clicks`；不满足条件时应为 `null`。

```sql
-- 抽查：有 link_clicks 和 spend 的昨日归档，cpc 应为 spend/link_clicks
SELECT account_id, ad_id, date,
       spend, link_clicks,
       cpc,
       (spend / NULLIF(link_clicks, 0)) AS expected_cpc
FROM daily_stats
WHERE date = CURDATE() - INTERVAL 1 DAY
  AND link_clicks > 0 AND spend > 0
LIMIT 5;
```

- **roas**：制造或找一条 API 无 roas 但 `purchase_value > 0` 且 `spend > 0` 的样本，归档后检查 `daily_stats.roas` 非 null，且等于 `purchase_value / spend`。

```sql
-- 抽查：有 purchase_value 和 spend 的昨日归档，roas 应有值或为 purchase_value/spend
SELECT account_id, ad_id, date,
       spend, purchase_value,
       roas,
       (purchase_value / NULLIF(spend, 0)) AS expected_roas
FROM daily_stats
WHERE date = CURDATE() - INTERVAL 1 DAY
  AND purchase_value > 0 AND spend > 0
LIMIT 5;
```

---

## 4. 唯一索引约束（uk_account_ad_date）

确认唯一索引存在且 ON DUPLICATE KEY UPDATE 生效（同一 account_id, ad_id, date 只更新一行）：

```sql
SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
```

若无该索引，可参考迁移文件 `005_add_unique_index_to_daily_stats.sql` 创建。

---

## 5. 两表键一致性与「仅归档来源」的 CPC 兜底

以下 SQL 均以**昨日**为例（`CURDATE() - INTERVAL 1 DAY`），可按需改日期。

### 5.1 同一 (account_id, ad_id, date) 在两张表是否都存在

```sql
-- 昨日：在 daily_stats 和 ad_snapshots 里都存在的 (account_id, ad_id, date) 数量
-- （两边同一天都有数据，date 与 data_date 口径一致）
SELECT COUNT(*) AS cnt_in_both
FROM daily_stats d
INNER JOIN (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s ON d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
WHERE d.date = CURDATE() - INTERVAL 1 DAY;
```

```sql
-- 昨日：只在 daily_stats 有、在 ad_snapshots 没有该自然日的（可能来自 API 按日写入）
SELECT COUNT(*) AS cnt_only_in_daily_stats
FROM daily_stats d
WHERE d.date = CURDATE() - INTERVAL 1 DAY
  AND NOT EXISTS (
    SELECT 1 FROM ad_snapshots s
    WHERE s.account_id = d.account_id AND s.ad_id = d.ad_id AND s.data_date = d.date
  );
```

```sql
-- 昨日：只在 ad_snapshots 有、在 daily_stats 没有该自然日的（归档未覆盖或未跑）
SELECT COUNT(*) AS cnt_only_in_snapshots
FROM (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s
WHERE NOT EXISTS (
  SELECT 1 FROM daily_stats d
  WHERE d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
);
```

### 5.2 「只可能来自归档」的广告：看 CPC 是否被填成 spend/link_clicks

这里把「在 ad_snapshots 里也有该日期的 (account_id, ad_id)」的 daily_stats 行视为**可能被归档路径写过**（归档会从 ad_snapshots 取最后快照写 daily_stats）。在这些行里查：满足 link_clicks>0 且 spend>0 时，cpc 是否等于 spend/link_clicks。

```sql
-- 昨日、两边都有的 (account_id, ad_id, date)，且 link_clicks>0 且 spend>0：看 cpc 与 expected_cpc
SELECT d.account_id, d.ad_id, d.date,
       d.spend, d.link_clicks,
       d.cpc,
       (d.spend / NULLIF(d.link_clicks, 0)) AS expected_cpc,
       CASE
         WHEN d.cpc IS NULL THEN 'null'
         WHEN ABS(d.cpc - (d.spend / d.link_clicks)) < 0.0001 THEN 'ok'
         ELSE 'mismatch'
       END AS cpc_check
FROM daily_stats d
INNER JOIN (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s ON d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
WHERE d.date = CURDATE() - INTERVAL 1 DAY
  AND d.link_clicks > 0 AND d.spend > 0
ORDER BY d.account_id, d.ad_id
LIMIT 20;
```

```sql
-- 汇总：上述集合里 cpc 已填且≈expected_cpc 的数量、cpc 为 null 的数量
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN d.cpc IS NOT NULL AND ABS(d.cpc - (d.spend / d.link_clicks)) < 0.0001 THEN 1 ELSE 0 END) AS cpc_filled_ok,
  SUM(CASE WHEN d.cpc IS NULL THEN 1 ELSE 0 END) AS cpc_null
FROM daily_stats d
INNER JOIN (
  SELECT DISTINCT account_id, ad_id, data_date
  FROM ad_snapshots
  WHERE data_date = CURDATE() - INTERVAL 1 DAY
) s ON d.account_id = s.account_id AND d.ad_id = s.ad_id AND d.date = s.data_date
WHERE d.date = CURDATE() - INTERVAL 1 DAY
  AND d.link_clicks > 0 AND d.spend > 0;
```

解读：
- **cnt_in_both** 大：说明昨日两边自然日口径对齐较好。
- **cnt_only_in_daily_stats**：仅 API 按日写入、或历史归档，当天 ad_snapshots 无该键。
- **cnt_only_in_snapshots**：归档未跑/失败或日期口径差异，导致 daily_stats 缺这些键。
- **cpc_filled_ok** 多、**cpc_null** 少：说明归档路径的 cpc 兜底（spend/link_clicks）已生效；若多数仍为 cpc_null，可能是这些行先被 API 写入且未填 cpc、或归档尚未用新逻辑重跑。

---

## 改动小结

| 改动 | 文件位置 | 说明 |
|------|----------|------|
| 日期口径 | `updateDailyStatsFromInsights` 构造 values 的日期字段 | `insight.date_start \|\| insight.date` |
| 回退健壮性 | `archiveDailyStats` 计算 targetDateStart/End 后 | 新增 `startTime`/`endTime`，回退分支使用 `queryLastSnapshotCompatible(accountId, startTime, endTime)` |
| cpc/roas 兜底 | `archiveDailyStats` 的 values 映射 | cpc：link_clicks>0 且 spend>0 时 = spend/link_clicks；roas：优先 API，否则 purchase_value>0 且 spend>0 时 = purchase_value/spend |
