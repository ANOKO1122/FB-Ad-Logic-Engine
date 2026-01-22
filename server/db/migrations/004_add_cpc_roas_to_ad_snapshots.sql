-- ============================================
-- 迁移脚本 004：为 ad_snapshots 表添加 cpc 和 roas 字段
-- 原因：根据测试发现，purchase_roas 可以直接从 API 获取，cpc 也可以直接获取
-- 日期：2026-01-19
-- ============================================

-- 第一部分：为 ad_snapshots 表添加 cpc 字段
-- 检查字段是否存在，如果不存在则添加
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_snapshots'
    AND COLUMN_NAME = 'cpc'
);

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `ad_snapshots` ADD COLUMN `cpc` DECIMAL(10,4) COMMENT ''单次链接点击费用（直接从 API 获取）''',
  'SELECT ''字段 cpc 已存在，跳过'' as result'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 第二部分：为 ad_snapshots 表添加 roas 字段
-- 检查字段是否存在，如果不存在则添加
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_snapshots'
    AND COLUMN_NAME = 'roas'
);

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `ad_snapshots` ADD COLUMN `roas` DECIMAL(10,4) COMMENT ''广告支出回报率（优先从 purchase_roas 提取，缺失时计算）''',
  'SELECT ''字段 roas 已存在，跳过'' as result'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 验证：显示添加结果
SELECT 
  COLUMN_NAME,
  COLUMN_TYPE,
  COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND COLUMN_NAME IN ('cpc', 'roas')
ORDER BY COLUMN_NAME;

