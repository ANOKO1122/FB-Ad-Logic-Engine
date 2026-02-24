# ID 字段 VARCHAR(50) 盘点（TASKS 1.1）

> **目的**：Facebook 的 Account/Ad/AdSet/Campaign ID 可能超出 BIGINT 范围，应使用 VARCHAR(50) 存储。本文档盘点当前所有 ID 相关字段的类型。

---

## 一、盘点范围

以下字段存储 Facebook 对象 ID，需为 `VARCHAR(50)`：

| 字段名 | 含义 | 典型值示例 |
|--------|------|------------|
| account_id / fb_account_id | 广告账户 ID | act_123456789 |
| ad_id | 广告 ID | 120212345678901234 |
| adset_id | 广告组 ID | 120212345678901235 |
| campaign_id | 广告系列 ID | 120212345678901236 |

**说明**：自增主键 `id`（INT/BIGINT）为内部行标识，不受此约束。

---

## 二、自查 SQL（在 MySQL 中执行）

```sql
-- 查询所有存储 FB 对象 ID 的列及其类型
SELECT 
  TABLE_NAME AS '表名',
  COLUMN_NAME AS '列名',
  COLUMN_TYPE AS '当前类型',
  CASE 
    WHEN COLUMN_TYPE LIKE 'varchar(50)%' THEN '✅ 已符合'
    WHEN COLUMN_TYPE LIKE 'varchar(%' AND COLUMN_TYPE NOT LIKE 'varchar(50)%' THEN '⚠️ VARCHAR 但非 50'
    ELSE '❌ 需迁移'
  END AS '结论'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME IN ('ad_snapshots','daily_stats','automation_logs','rules',
                    'structure_ads','structure_sync_status','daily_archive_status',
                    'rule_execution_summaries','account_mappings')
     AND COLUMN_NAME IN ('account_id','fb_account_id','ad_id','adset_id','campaign_id'))
  )
ORDER BY TABLE_NAME, COLUMN_NAME;
```

---

## 三、迁移口径（基于迁移脚本与 schema）

| 表 | 列 | 当前类型（迁移定义） | 结论 |
|----|-----|----------------------|------|
| ad_snapshots | account_id | VARCHAR(50) | ✅ |
| ad_snapshots | ad_id | VARCHAR(50) | ✅ |
| daily_stats | account_id | VARCHAR(50) | ✅ |
| daily_stats | ad_id | VARCHAR(50) | ✅ |
| automation_logs | account_id | VARCHAR(50) | ✅ |
| automation_logs | ad_id | VARCHAR(50) | ✅ |
| rules | account_id | VARCHAR(50) | ✅ |
| structure_ads | account_id | VARCHAR(50) | ✅ |
| structure_ads | ad_id | VARCHAR(50) | ✅ |
| structure_ads | adset_id | VARCHAR(50) | ✅ |
| structure_ads | campaign_id | VARCHAR(50) | ✅ |
| structure_sync_status | account_id | VARCHAR(50) | ✅ |
| daily_archive_status | account_id | VARCHAR(50) | ✅ |
| rule_execution_summaries | account_id | VARCHAR(50) | ✅ |
| account_mappings | fb_account_id | 需实际查询确认 | ⚠️ 旧表，无迁移脚本 |

---

## 四、验收步骤

1. 执行上方「自查 SQL」，确认所有列 `结论` 为 `✅ 已符合`。
2. 若 `account_mappings.fb_account_id` 非 VARCHAR(50)，执行：
   ```sql
   -- 仅当实际类型不符时执行，先备份
   ALTER TABLE account_mappings MODIFY COLUMN fb_account_id VARCHAR(50) NOT NULL COMMENT 'Facebook 广告账户 ID';
   ```

---

## 五、参考

- TASKS §1.1：检查/更新所有 ID 字段为 VARCHAR(50)
- `server/db/migrations/verify_m2_stage1_pure_sql.sql` Part 3：已有部分 ID 类型校验
