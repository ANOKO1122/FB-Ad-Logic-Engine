# 一天后完整验证清单

## 验证目标

验证过去一天内系统的运行状态，确保所有优化都已生效：
1. ✅ **AdsPolar "Insights First" 策略**：是否正常工作
2. ✅ **队列写入机制**：是否解决了死锁问题
3. ✅ **数据完整性**：是否完整收集了所有 spend>0 的广告
4. ✅ **统一心跳同步**：是否正常执行
5. ✅ **双窗口归档**：是否正常工作

---

## 验证步骤

### 1. 验证数据同步是否正常工作（Today 热同步）

**目标**：确认 Today 热同步正常执行，数据正确写入

**SQL 验证**：
```sql
-- 检查最近 24 小时内的同步数据
SELECT 
  account_id,
  COUNT(DISTINCT ad_id) as ad_count,
  SUM(spend) as total_spend,
  MAX(synced_at) as last_synced_at,
  MAX(data_date) as latest_data_date
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY account_id
ORDER BY last_synced_at DESC
LIMIT 20;

-- 检查是否有 spend>0 的广告（应该接近 100%）
SELECT 
  account_id,
  COUNT(*) as total_ads,
  COUNT(CASE WHEN spend > 0 THEN 1 END) as spend_gt_zero_ads,
  ROUND(COUNT(CASE WHEN spend > 0 THEN 1 END) * 100.0 / COUNT(*), 2) as spend_gt_zero_percentage
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY account_id
ORDER BY account_id;

-- 检查 data_date 是否正确（应该与账户时区一致）
SELECT 
  account_id,
  data_date,
  DATE(synced_at) as synced_date_utc,
  timezone_name,
  COUNT(*) as count
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY account_id, data_date, DATE(synced_at), timezone_name
ORDER BY account_id, data_date DESC
LIMIT 20;
```

**预期结果**：
- ✅ 所有账户都有最近 24 小时内的同步数据
- ✅ `spend_gt_zero_percentage` 应该接近 100%
- ✅ `data_date` 应该与账户时区一致

---

### 2. 验证队列写入是否解决了死锁问题

**目标**：确认不再出现死锁错误

**验证方法**：
1. 查看后端日志，搜索 `Deadlock` 或 `Lock wait timeout`
2. 应该**不出现**这些错误

**SQL 验证**：
```sql
-- 检查最近 24 小时内的同步会话ID（如果有重试，会有 retry_ 前缀）
SELECT 
  account_id,
  sync_session_id,
  COUNT(*) as snapshot_count,
  MAX(synced_at) as last_synced_at
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND sync_session_id LIKE 'retry_%'
GROUP BY account_id, sync_session_id
ORDER BY last_synced_at DESC
LIMIT 20;
-- 预期：如果有重试，说明之前的死锁问题已解决（通过重试机制）
```

**预期结果**：
- ✅ 日志中不再出现 `Deadlock` 或 `Lock wait timeout` 错误
- ✅ 所有账户都能成功写入数据

---

### 3. 验证数据完整性（使用验证脚本）

**目标**：确认是否完整收集了所有 spend>0 的广告

**执行命令**：
```bash
node server/scripts/verify-spend-ads-completeness.js
```

**预期结果**：
- ✅ 覆盖率应该接近 100%（≥95%）
- ✅ 遗漏广告数应该大幅减少或为 0
- ✅ 如果仍有遗漏，需要分析原因

---

### 4. 验证统一心跳同步是否正常执行

**目标**：确认统一心跳 Cron 正常执行（每 15 分钟）

**SQL 验证**：
```sql
-- 检查最近 24 小时内的同步会话ID分布
SELECT 
  DATE_FORMAT(synced_at, '%Y-%m-%d %H:%i') as sync_time,
  COUNT(DISTINCT account_id) as account_count,
  COUNT(*) as total_records
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY DATE_FORMAT(synced_at, '%Y-%m-%d %H:%i')
ORDER BY sync_time DESC
LIMIT 20;
-- 预期：应该看到每 15 分钟有一次同步（或更频繁）

-- 检查统一心跳的日志（需要查看应用日志）
-- 应该看到：每 15 分钟执行一次 "统一心跳同步任务"
```

**预期结果**：
- ✅ 每 15 分钟有一次数据同步
- ✅ 日志中可以看到 "统一心跳同步任务" 的执行记录

---

### 5. 验证双窗口归档是否正常工作

**目标**：确认双窗口归档（ARCHIVED 和 FINALIZED）正常执行

**SQL 验证**：
```sql
-- 检查归档状态表
SELECT 
  account_id,
  target_date,
  status,
  updated_at,
  last_error
FROM daily_archive_status
WHERE updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY updated_at DESC
LIMIT 20;

-- 检查是否有 PENDING 状态的记录（应该很少，因为 ≥02:00 会归档）
SELECT 
  COUNT(*) AS 'pending_count',
  MIN(target_date) AS 'oldest_pending_date',
  MAX(target_date) AS 'newest_pending_date'
FROM daily_archive_status
WHERE status = 'PENDING'
  AND target_date < CURDATE();  -- 只检查昨天的数据

-- 检查是否有 ARCHIVED 但未 FINALIZED 的记录（≥12:00 应该会 FINALIZED）
SELECT 
  COUNT(*) AS 'archived_not_finalized_count',
  MIN(target_date) AS 'oldest_archived_date',
  MAX(target_date) AS 'newest_archived_date'
FROM daily_archive_status
WHERE status = 'ARCHIVED'
  AND target_date < CURDATE();  -- 只检查昨天的数据

-- 检查归档完整性：昨天是否有数据但未归档
SELECT 
  a.account_id,
  COUNT(DISTINCT a.ad_id) AS 'snapshot_count',
  COALESCE(s.status, 'NOT_STARTED') AS 'archive_status',
  COALESCE(COUNT(DISTINCT d.ad_id), 0) AS 'archived_count'
FROM ad_snapshots a
LEFT JOIN daily_archive_status s 
  ON a.account_id = s.account_id 
  AND DATE(a.data_date) = s.target_date
LEFT JOIN daily_stats d 
  ON a.account_id = d.account_id 
  AND DATE(a.data_date) = d.date
WHERE DATE(a.data_date) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
GROUP BY a.account_id, s.status
HAVING snapshot_count > 0
ORDER BY a.account_id;
```

**预期结果**：
- ✅ 昨天的数据应该有 `ARCHIVED` 或 `FINALIZED` 状态
- ✅ `pending_count` 应该为 0 或很少
- ✅ `archived_not_finalized_count` 应该为 0（如果已过 12:00）

---

### 6. 验证队列写入统计

**目标**：确认队列写入机制正常工作

**验证方法**：
1. 查看后端日志，搜索 `📤 推入写入队列` 和 `💾 [队列写入器]`
2. 应该看到队列写入的日志

**SQL 验证**：
```sql
-- 检查最近 24 小时内的同步数据（验证队列写入是否成功）
SELECT 
  account_id,
  COUNT(*) as total_records,
  COUNT(DISTINCT sync_session_id) as session_count,
  MIN(synced_at) as first_sync,
  MAX(synced_at) as last_sync
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY account_id
ORDER BY account_id;
-- 预期：每个账户应该有多个同步会话，说明队列写入正常工作
```

**预期结果**：
- ✅ 日志中可以看到队列写入的日志
- ✅ 所有数据都成功写入数据库

---

## 预期结果总结

| 验证项 | 预期结果 |
|--------|---------|
| 数据同步 | ✅ 所有账户都有最近 24 小时内的同步数据 |
| 死锁问题 | ✅ 不再出现死锁错误 |
| 数据完整性 | ✅ 覆盖率 ≥95%，遗漏广告数大幅减少 |
| 统一心跳 | ✅ 每 15 分钟执行一次 |
| 双窗口归档 | ✅ 昨天的数据已归档（ARCHIVED 或 FINALIZED） |
| 队列写入 | ✅ 队列写入正常工作，无死锁 |

---

## 常见问题排查

### 问题1：数据同步不完整

**检查**：
- 查看后端日志，确认是否有错误
- 检查队列写入是否正常工作
- 运行验证脚本，查看遗漏的广告

### 问题2：仍有死锁错误

**检查**：
- 确认队列写入机制已启用
- 查看日志，确认是否使用队列写入
- 检查并发度设置（应该为 8）

### 问题3：统一心跳未执行

**检查**：
- 查看应用启动日志，确认 Cron 任务已启动
- 检查系统时间是否正确
- 查看是否有错误日志

### 问题4：归档未执行

**检查**：
- 确认账户本地时间是否 ≥02:00（ARCHIVED）或 ≥12:00（FINALIZED）
- 检查 `checkAndExecuteArchive` 函数是否被调用
- 查看是否有错误日志

---

## 下一步

如果所有验证都通过，可以：
1. ✅ 继续监控系统运行状态
2. ✅ 测试优雅退出功能
3. ✅ 测试错误隔离功能
4. ✅ 继续优化性能（如果需要）

