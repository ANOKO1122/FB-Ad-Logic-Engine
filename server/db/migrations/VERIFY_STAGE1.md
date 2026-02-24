# 阶段一验证指南（纯 SQL 命令）

## 验证步骤

在 MySQL 客户端中依次执行以下 SQL 命令，验证迁移是否成功。

### 1. 验证 daily_archive_status 表

```sql
-- 检查表是否存在
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'PASS: daily_archive_status table exists'
    ELSE 'FAIL: daily_archive_status table does not exist'
  END AS 'Table Existence Check'
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status';

-- 查看表结构
DESCRIBE daily_archive_status;

-- 检查唯一索引
SHOW INDEX FROM daily_archive_status WHERE Key_name = 'uk_account_date';
```

### 2. 验证 ad_snapshots.data_date 字段

```sql
-- 检查字段是否存在
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'PASS: data_date field exists'
    ELSE 'FAIL: data_date field does not exist'
  END AS 'Field Existence Check'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME = 'data_date';

-- 查看字段属性
SHOW COLUMNS FROM ad_snapshots WHERE Field = 'data_date';

-- 检查唯一索引
SHOW INDEX FROM ad_snapshots WHERE Key_name = 'uk_account_ad_date';

-- 检查数据完整性（应该返回 0）
SELECT COUNT(*) AS 'Records with NULL or default data_date'
FROM ad_snapshots
WHERE data_date IS NULL OR data_date = '1970-01-01';

-- 查看最近 7 天的 data_date 分布
SELECT 
  data_date,
  COUNT(*) AS 'Record Count',
  COUNT(DISTINCT account_id) AS 'Account Count',
  COUNT(DISTINCT ad_id) AS 'Ad Count'
FROM ad_snapshots
WHERE data_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY data_date
ORDER BY data_date DESC;
```

### 3. 验证 ID 字段类型（应为 VARCHAR(50)）

```sql
-- 检查所有相关表的 ID 字段类型
SELECT 
  TABLE_NAME AS 'Table Name',
  COLUMN_NAME AS 'Column Name',
  COLUMN_TYPE AS 'Column Type',
  CASE 
    WHEN COLUMN_TYPE LIKE 'varchar(50)%' THEN 'PASS: VARCHAR(50)'
    ELSE 'CHECK: May need to update'
  END AS 'Type Check'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'ad_snapshots' AND COLUMN_NAME IN ('account_id', 'ad_id'))
    OR (TABLE_NAME = 'daily_stats' AND COLUMN_NAME IN ('account_id', 'ad_id'))
    OR (TABLE_NAME = 'daily_archive_status' AND COLUMN_NAME = 'account_id')
    OR (TABLE_NAME = 'automation_logs' AND COLUMN_NAME IN ('account_id', 'ad_id'))
    OR (TABLE_NAME = 'rules' AND COLUMN_NAME = 'account_id')
  )
ORDER BY TABLE_NAME, COLUMN_NAME;
```

### 4. 快速验证（一键执行）

如果你想一次性执行所有验证，可以直接运行：

```sql
-- 在 MySQL 客户端中执行
SOURCE server/db/migrations/verify_m2_stage1_pure_sql.sql;
```

或者复制 `verify_m2_stage1_pure_sql.sql` 文件的内容到 MySQL 客户端执行。

## 预期结果

所有检查应该显示：
- ✅ **PASS**: 表示检查通过
- ⚠️ **WARNING**: 需要关注，但不一定失败
- ❌ **FAIL**: 表示迁移失败，需要检查

## 根据你的输出分析

从你的执行结果看：

1. ✅ **daily_archive_status 表**: 已成功创建
2. ✅ **data_date 字段**: 已成功添加，类型为 `date`，NOT NULL
3. ✅ **唯一索引 uk_account_ad_date**: 已成功创建，包含 `account_id`, `ad_id`, `data_date` 三列
4. ✅ **数据完整性**: `null_data_date_count = 0`，说明所有记录都已正确回填

**结论：阶段一迁移成功！** 🎉

## 下一步

现在可以继续阶段二：实现统一心跳 Cron 和双窗口归档逻辑。

