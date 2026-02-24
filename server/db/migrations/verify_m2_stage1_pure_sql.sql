-- ============================================
-- Verification Script: verify_m2_stage1_pure_sql.sql
-- Purpose: Verify Stage 1 migrations (pure SQL, no Chinese comments)
-- Execute in MySQL client after running 009 and 010 migrations
-- ============================================

-- ============================================
-- Part 1: Verify daily_archive_status table
-- ============================================

-- 1.1 Check if table exists
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'PASS: daily_archive_status table exists'
    ELSE 'FAIL: daily_archive_status table does not exist'
  END AS 'Table Existence Check'
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status';

-- 1.2 Check table structure
SELECT 
  COLUMN_NAME,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_DEFAULT,
  COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status'
ORDER BY ORDINAL_POSITION;

-- 1.3 Check unique index uk_account_date
SELECT 
  INDEX_NAME,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS 'Index Columns',
  NON_UNIQUE,
  CASE 
    WHEN NON_UNIQUE = 0 THEN 'UNIQUE INDEX'
    ELSE 'NON-UNIQUE INDEX'
  END AS 'Index Type'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status'
GROUP BY INDEX_NAME
ORDER BY INDEX_NAME;

-- ============================================
-- Part 2: Verify ad_snapshots.data_date field
-- ============================================

-- 2.1 Check if data_date field exists
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN 'PASS: data_date field exists'
    ELSE 'FAIL: data_date field does not exist'
  END AS 'Field Existence Check'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME = 'data_date';

-- 2.2 Check data_date field properties
SELECT 
  COLUMN_NAME,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_DEFAULT,
  COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME = 'data_date';

-- 2.3 Check unique index uk_account_ad_date
SELECT 
  INDEX_NAME,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS 'Index Columns',
  NON_UNIQUE,
  CASE 
    WHEN NON_UNIQUE = 0 THEN 'UNIQUE INDEX'
    ELSE 'NON-UNIQUE INDEX'
  END AS 'Index Type'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND INDEX_NAME = 'uk_account_ad_date'
GROUP BY INDEX_NAME;

-- 2.4 Check data integrity (should be 0)
SELECT 
  CASE 
    WHEN COUNT(*) = 0 THEN 'PASS: All records have valid data_date'
    ELSE CONCAT('WARNING: ', COUNT(*), ' records have NULL or default data_date')
  END AS 'Data Integrity Check'
FROM ad_snapshots
WHERE data_date IS NULL OR data_date = '1970-01-01';

-- 2.5 Show data_date distribution (last 7 days)
SELECT 
  data_date,
  COUNT(*) AS 'Record Count',
  COUNT(DISTINCT account_id) AS 'Account Count',
  COUNT(DISTINCT ad_id) AS 'Ad Count'
FROM ad_snapshots
WHERE data_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY data_date
ORDER BY data_date DESC;

-- ============================================
-- Part 3: Verify ID field types (should be VARCHAR(50))
-- ============================================

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

-- ============================================
-- Part 4: Summary
-- ============================================

SELECT '=== Verification Summary ===' AS '';
SELECT 
  'If all checks show PASS, Stage 1 migration is successful!' AS 'Result',
  'If any check shows FAIL or WARNING, please review the migration scripts' AS 'Note';

