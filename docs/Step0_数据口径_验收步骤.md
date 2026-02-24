# Step 0 数据口径 — 验收步骤

> 对应 TASKS.md 1.2 中「数据口径」「status 来源」两项。

---

## 验收项 1：today 热数据只写入 spend>0 的广告

**口径**：ad_snapshots 中 today 数据不应包含 spend=0 的记录。

**代码位置**：
- `ingestorService.js` 322-327：API 嗅探阶段过滤
- `ingestorService.js` 1607-1613：队列写入前清洗

**验收 SQL**（执行后应返回 0）：

```sql
-- 1.1 检查 today 快照中是否存在 spend=0 的记录（应无）
SELECT COUNT(*) AS spend_zero_count
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND (spend = 0 OR spend IS NULL);

-- 1.2 抽查最近 1 小时内 today 快照的 spend 分布
SELECT
  CASE WHEN spend > 0 THEN '>0' ELSE '=0' END AS spend_bucket,
  COUNT(*) AS cnt
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
  AND data_date = CURDATE()
GROUP BY spend_bucket;
```

**预期**：`spend_zero_count = 0`；`spend_bucket = '>0'` 有数据，`'=0'` 无数据。

---

## 验收项 2：ad_snapshots.status 写入 FB 的 effective_status

**口径**：status 字段来源于 FB 的 `effective_status`（或 fallback 到 `status`）。

**代码位置**：
- `ingestorService.js` 351-354：`statusMap.set(adId, ad.effective_status || ad.status || null)`
- `ingestorService.js` 368-370：合并到 insight
- `ingestorService.js` 1691：写入 values.status

**验收 SQL**（检查 status 是否为有效枚举值）：

```sql
-- 2.1 今日快照 status 分布（应为 ACTIVE/PAUSED 等 FB 标准值）
SELECT status, COUNT(*) AS cnt
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY status
ORDER BY cnt DESC;

-- 2.2 是否存在异常 status（空或非标准值）
-- 注：枚举包含 FB effective_status 全量（含 CAMPAIGN_PAUSED、ADSET_PAUSED 等）
SELECT COUNT(*) AS abnormal_count
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND (status IS NULL OR status = ''
    OR status NOT IN ('ACTIVE','PAUSED','PENDING_REVIEW','DISAPPROVED','IN_PROCESS','WITH_ISSUES',
      'ARCHIVED','DELETED','CAMPAIGN_PAUSED','ADSET_PAUSED','PREAPPROVED','PENDING_BILLING_INFO'));
```

**预期**：status 主要为 ACTIVE/PAUSED/CAMPAIGN_PAUSED 等；`abnormal_count` 应为 0。

---

## 验收步骤汇总

1. 确保最近有 Today 同步（等 Cron 或手动触发一次）
2. 连接 MySQL，依次执行上述 SQL
3. 核对结果是否符合预期
4. 若通过，在 TASKS.md 中勾选：
   - `数据口径（下一阶段优先级）`：today 热数据只写入 spend>0
   - `status 来源`：ad_snapshots.status 写入 FB 的 effective_status
