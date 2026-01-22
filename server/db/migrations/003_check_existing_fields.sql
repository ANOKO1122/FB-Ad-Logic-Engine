-- ============================================
-- 检查脚本：003_check_existing_fields.sql
-- 目的：检查 ad_snapshots 和 daily_stats 表中哪些字段/索引已存在
-- 执行方式：在 MySQL 客户端中执行此脚本，查看输出结果
-- ============================================

-- 检查 ad_snapshots 表的字段
SELECT 
    'ad_snapshots 表字段检查' AS table_name,
    COLUMN_NAME,
    COLUMN_TYPE,
    COLUMN_DEFAULT,
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME IN (
    'link_clicks',
    'unique_link_clicks',
    'purchase_value',
    'add_to_cart_count',
    'initiate_checkout_count',
    'add_payment_info_count',
    'ad_set_id'
  )
ORDER BY COLUMN_NAME;

-- 检查 daily_stats 表的字段
SELECT 
    'daily_stats 表字段检查' AS table_name,
    COLUMN_NAME,
    COLUMN_TYPE,
    COLUMN_DEFAULT,
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_stats'
  AND COLUMN_NAME IN (
    'link_clicks',
    'unique_link_clicks',
    'purchase_value',
    'add_to_cart_count',
    'initiate_checkout_count',
    'add_payment_info_count',
    'ad_set_id'
  )
ORDER BY COLUMN_NAME;

-- 检查 ad_snapshots 表的索引
SELECT 
    'ad_snapshots 表索引检查' AS table_name,
    INDEX_NAME,
    COLUMN_NAME,
    SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND INDEX_NAME IN (
    'idx_account_synced',
    'idx_ad_synced',
    'idx_ad_synced_desc'
  )
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 检查 daily_stats 表的索引
SELECT 
    'daily_stats 表索引检查' AS table_name,
    INDEX_NAME,
    COLUMN_NAME,
    SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'daily_stats'
  AND INDEX_NAME IN (
    'idx_account_date',
    'idx_ad_date'
  )
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

