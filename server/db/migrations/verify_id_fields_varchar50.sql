-- ID 字段 VARCHAR(50) 盘点（TASKS 1.1）
-- 执行：mysql -u user -p dbname < server/db/migrations/verify_id_fields_varchar50.sql

SELECT '=== ID 字段类型盘点（FB 对象 ID 应为 VARCHAR(50)）===' AS '';

SELECT 
  TABLE_NAME AS '表名',
  COLUMN_NAME AS '列名',
  COLUMN_TYPE AS '当前类型',
  CASE 
    WHEN COLUMN_TYPE LIKE 'varchar(50)%' THEN 'PASS'
    WHEN COLUMN_TYPE LIKE 'varchar(%' THEN 'CHECK'
    ELSE 'FAIL'
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
