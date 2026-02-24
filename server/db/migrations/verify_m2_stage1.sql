-- ============================================
-- 验证脚本：verify_m2_stage1.sql
-- 目的：验证阶段一（数据表设计与迁移）是否成功
-- 执行时机：在 009 和 010 迁移脚本执行后运行
-- ============================================

-- ============================================
-- 第一部分：验证 daily_archive_status 表
-- ============================================

SELECT '=== 验证 daily_archive_status 表 ===' AS '';

-- 1. 检查表是否存在
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ daily_archive_status 表存在'
    ELSE '❌ daily_archive_status 表不存在'
  END AS '表存在性检查'
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status';

-- 2. 检查字段
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

-- 3. 检查唯一索引
SELECT 
  INDEX_NAME,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS '索引列',
  NON_UNIQUE,
  CASE 
    WHEN NON_UNIQUE = 0 THEN '✅ 唯一索引'
    ELSE '⚠️  普通索引'
  END AS '索引类型'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_archive_status'
GROUP BY INDEX_NAME
ORDER BY INDEX_NAME;

-- ============================================
-- 第二部分：验证 ad_snapshots 表的 data_date 字段
-- ============================================

SELECT '' AS '';
SELECT '=== 验证 ad_snapshots 表的 data_date 字段 ===' AS '';

-- 1. 检查 data_date 字段是否存在
SELECT 
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ data_date 字段存在'
    ELSE '❌ data_date 字段不存在'
  END AS '字段存在性检查'
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME = 'data_date';

-- 2. 检查 data_date 字段属性
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

-- 3. 检查唯一索引 uk_account_ad_date
SELECT 
  INDEX_NAME,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS '索引列',
  NON_UNIQUE,
  CASE 
    WHEN NON_UNIQUE = 0 THEN '✅ 唯一索引'
    ELSE '⚠️  普通索引'
  END AS '索引类型'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND INDEX_NAME = 'uk_account_ad_date'
GROUP BY INDEX_NAME;

-- 4. 检查 data_date 数据完整性（是否有 NULL 或默认值）
SELECT 
  CASE 
    WHEN COUNT(*) = 0 THEN '✅ 所有记录的 data_date 都已正确回填'
    ELSE CONCAT('⚠️  还有 ', COUNT(*), ' 条记录的 data_date 未正确回填（NULL 或 1970-01-01）')
  END AS '数据完整性检查'
FROM ad_snapshots
WHERE data_date IS NULL OR data_date = '1970-01-01';

-- 5. 统计 data_date 分布（最近7天）
SELECT 
  data_date,
  COUNT(*) AS '记录数',
  COUNT(DISTINCT account_id) AS '账户数',
  COUNT(DISTINCT ad_id) AS '广告数'
FROM ad_snapshots
WHERE data_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY data_date
ORDER BY data_date DESC;

-- ============================================
-- 第三部分：验证 ID 字段类型（VARCHAR(50)）
-- ============================================

SELECT '' AS '';
SELECT '=== 验证 ID 字段类型（应为 VARCHAR(50)） ===' AS '';

-- 检查所有相关表的 ID 字段类型
SELECT 
  TABLE_NAME AS '表名',
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '字段类型',
  CASE 
    WHEN COLUMN_TYPE LIKE 'varchar(50)%' THEN '✅ 正确'
    ELSE '⚠️  需要检查'
  END AS '类型检查'
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
-- 第四部分：总结
-- ============================================

SELECT '' AS '';
SELECT '=== 验证总结 ===' AS '';
SELECT 
  '如果以上所有检查都显示 ✅，说明阶段一迁移成功！' AS '提示',
  '如有 ❌ 或 ⚠️，请检查对应的迁移脚本是否执行成功' AS '注意事项';

