# 阶段二验证指南（统一心跳 + 双窗口归档）

## 验证步骤

### 1. 验证统一心跳 Cron 是否启动

在 MySQL 客户端执行以下 SQL，检查定时任务是否正常运行：

```sql
-- 检查是否有统一心跳的日志（需要查看应用日志）
-- 或者检查 daily_archive_status 表是否有新记录
SELECT 
  account_id,
  target_date,
  status,
  updated_at
FROM daily_archive_status
ORDER BY updated_at DESC
LIMIT 10;
```

### 2. 验证 data_date 字段是否正确写入

```sql
-- 检查最近同步的数据是否包含 data_date
SELECT 
  account_id,
  ad_id,
  data_date,
  synced_at,
  timezone_name
FROM ad_snapshots
ORDER BY synced_at DESC
LIMIT 10;

-- 检查 data_date 是否与 synced_at 和 timezone_name 一致
-- 注意：data_date 应该是账户本地时区的自然日
SELECT 
  account_id,
  ad_id,
  data_date,
  DATE(synced_at) AS synced_date_utc,
  timezone_name,
  CASE 
    WHEN data_date = DATE(synced_at) THEN '可能一致（UTC时区）'
    ELSE '需要检查时区转换'
  END AS 'date_check'
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
ORDER BY synced_at DESC
LIMIT 20;
```

### 3. 验证双窗口归档逻辑

```sql
-- 检查归档状态表
SELECT 
  account_id,
  target_date,
  status,
  updated_at,
  last_error
FROM daily_archive_status
ORDER BY updated_at DESC
LIMIT 20;

-- 检查是否有 PENDING 状态的记录（应该很少，因为 ≥02:00 会归档）
SELECT 
  COUNT(*) AS 'pending_count',
  MIN(target_date) AS 'oldest_pending_date',
  MAX(target_date) AS 'newest_pending_date'
FROM daily_archive_status
WHERE status = 'PENDING';

-- 检查是否有 ARCHIVED 但未 FINALIZED 的记录（≥12:00 应该会 FINALIZED）
SELECT 
  COUNT(*) AS 'archived_not_finalized_count',
  MIN(target_date) AS 'oldest_archived_date',
  MAX(target_date) AS 'newest_archived_date'
FROM daily_archive_status
WHERE status = 'ARCHIVED'
  AND target_date < CURDATE();  -- 只检查昨天的数据
```

### 4. 验证 GET_LOCK 修复（使用专用连接）

这个需要在代码层面验证，检查 `archiveAllAccountsDailyStats` 和 `executeArchive` 函数是否使用 `pool.getConnection()` 获取专用连接。

验证方法：
1. 查看代码中是否使用 `connection = await pool.getConnection()`
2. 检查是否在同一连接上执行 `GET_LOCK` 和 `RELEASE_LOCK`
3. 检查是否在 `finally` 块中释放连接

### 5. 验证统一心跳的时间窗口选择逻辑

根据当前时间和账户时区，统一心跳应该：
- 白天（6-18点）：主要同步 Today，每小时第 0 分钟回补 last_3d
- 夜间（0-6点）：回补 last_7d
- 晚上（18-24点）：回补 last_14d

验证方法：查看应用日志，确认每个账户选择的 time_range 是否正确。

### 6. 验证归档完整性

```sql
-- 检查昨天是否有数据但未归档
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

## 预期结果

1. ✅ **统一心跳 Cron**: 每 15 分钟执行一次，日志中可以看到"统一心跳同步任务"
2. ✅ **data_date 字段**: 所有新同步的数据都包含 data_date，且与账户时区一致
3. ✅ **双窗口归档**: 
   - 账户本地时间 ≥02:00 时，昨日数据状态变为 ARCHIVED
   - 账户本地时间 ≥12:00 时，昨日数据状态变为 FINALIZED
4. ✅ **GET_LOCK 修复**: 使用专用连接，避免锁泄漏
5. ✅ **时间窗口选择**: 根据账户时区和当前时间自动选择合适的时间范围

## 常见问题排查

### 问题1：统一心跳没有执行

**检查**：
- 查看应用启动日志，确认 Cron 任务已启动
- 检查系统时间是否正确
- 查看是否有错误日志

### 问题2：data_date 为 NULL 或默认值

**检查**：
- 确认迁移脚本已执行（010_add_data_date_to_ad_snapshots.sql）
- 检查新同步的数据是否包含 data_date
- 如果旧数据没有 data_date，需要运行回填脚本

### 问题3：归档状态一直是 PENDING

**检查**：
- 确认账户本地时间是否 ≥02:00
- 检查 `checkAndExecuteArchive` 函数是否被调用
- 查看是否有错误日志

### 问题4：GET_LOCK 仍然泄漏

**检查**：
- 确认代码中使用 `pool.getConnection()` 获取专用连接
- 确认在 `finally` 块中释放连接
- 检查是否有异常导致连接未释放

## 下一步

如果所有验证都通过，可以继续阶段三（如果需要）或开始测试整个系统。

