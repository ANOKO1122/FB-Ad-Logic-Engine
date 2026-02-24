# daily_stats 增加 campaign_id — 执行说明

以下命令**由你在本地执行**，按顺序做即可。

---

## 1. 执行迁移 021（加列）

在项目根目录下，用你的 MySQL 客户端执行：

```bash
# 方式 A：mysql 命令行
mysql -u 你的用户名 -p 你的数据库名 < server/db/migrations/021_add_campaign_id_to_daily_stats.sql

# 方式 B：PowerShell
Get-Content server/db/migrations/021_add_campaign_id_to_daily_stats.sql | mysql -u 你的用户名 -p 你的数据库名
```

验证：

```sql
DESCRIBE daily_stats;
-- 应看到 campaign_id VARCHAR(50) DEFAULT NULL
```

---

## 2. 回填历史数据（022）

为已有 `daily_stats` 行补全 `campaign_id`（从 `ad_snapshots` 同广告最新快照取）。**021 执行完成后再执行**。

```bash
mysql -u 你的用户名 -p 你的数据库名 < server/db/migrations/022_backfill_daily_stats_campaign_id.sql
```

或在 MySQL 客户端里执行 022 文件中的 SQL。

若报错 **MySQL 1093**（You can't specify target table for update in FROM clause），可改用 JOIN 写法（见文档末尾「回填 022 替代写法」）。

验证（可选）：

```sql
SELECT COUNT(*) AS total, SUM(campaign_id IS NOT NULL) AS with_campaign
FROM daily_stats;
-- 有 ad_snapshots 对应快照的行会被回填，其余保持 NULL
```

---

## 3. 代码与后续行为

- 本次已改：**冷数据落盘**（`archiveDailyStats`）、**按日修复写入**（`updateDailyStatsFromInsights`）会写入 `campaign_id`；**规则数据查询**（`queryDailyStats`、`queryDailyStatsForRange`）会 SELECT 并返回 `campaign_id`。
- 部署/重启服务后，新归档的昨日、以及「过去 N 天按日数据」写入 `daily_stats` 时都会带 `campaign_id`。
- 近三日、五日等时间窗口会查 `daily_stats` 历史段 + `ad_snapshots` 今天段，聚合时已从任一天取 `campaign_id`，历史行经回填后也会带 `campaign_id`，CBO 规则可正常执行。

---

---

## 4. 回填 022 替代写法（若遇 1093 或非 MySQL 8.0）

**A. MySQL 8.0+（JOIN + ROW_NUMBER）**

```sql
UPDATE daily_stats d
INNER JOIN (
  SELECT account_id, ad_id, campaign_id FROM (
    SELECT s.account_id, s.ad_id, s.campaign_id,
           ROW_NUMBER() OVER (PARTITION BY s.account_id, s.ad_id ORDER BY s.synced_at DESC, s.id DESC) AS rn
    FROM ad_snapshots s
    WHERE s.campaign_id IS NOT NULL
  ) x WHERE rn = 1
) t ON t.account_id = d.account_id AND t.ad_id = d.ad_id
SET d.campaign_id = t.campaign_id
WHERE d.campaign_id IS NULL;
```

**B. MySQL 5.7 兼容（JOIN + 最大 synced_at）**

```sql
UPDATE daily_stats d
INNER JOIN (
  SELECT s.account_id, s.ad_id, s.campaign_id
  FROM ad_snapshots s
  INNER JOIN (
    SELECT account_id, ad_id, MAX(synced_at) AS max_synced
    FROM ad_snapshots
    WHERE campaign_id IS NOT NULL
    GROUP BY account_id, ad_id
  ) m ON s.account_id = m.account_id AND s.ad_id = m.ad_id AND s.synced_at = m.max_synced
  WHERE s.campaign_id IS NOT NULL
) t ON t.account_id = d.account_id AND t.ad_id = d.ad_id
SET d.campaign_id = t.campaign_id
WHERE d.campaign_id IS NULL;
```

---

## 5. 顺序小结

1. 执行 **021**（加列）  
2. 执行 **022**（回填历史）  
3. 部署/重启应用（或已拉最新代码后直接重启）
