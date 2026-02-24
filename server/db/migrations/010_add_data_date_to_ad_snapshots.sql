-- ============================================
-- 迁移脚本：010_add_data_date_to_ad_snapshots.sql
-- 目的：为 ad_snapshots 表添加 data_date 字段和唯一索引
-- 依据：TASKS.md 1.7 + DEV_PLAN.md 4.1
-- 创建时间：2026-01-22
-- ============================================
-- 
-- 执行前请先备份数据库！
-- 备份命令示例（Windows PowerShell）：
-- mysqldump -u root -p fb_ad_brain > backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql
-- 
-- 重要提示：
-- 1. 本脚本会为现有数据回填 data_date（基于 synced_at 和 timezone_name）
-- 2. 如果现有数据量很大，回填可能需要较长时间
-- 3. 建议在低峰期执行
-- 
-- 执行后验证：
-- SELECT COUNT(*) FROM ad_snapshots WHERE data_date IS NULL;  -- 应该返回 0
-- SHOW INDEX FROM ad_snapshots WHERE Key_name = 'uk_account_ad_date';
-- ============================================

-- ============================================
-- 第一部分：检查字段是否存在（幂等性检查）
-- ============================================

SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_snapshots'
    AND COLUMN_NAME = 'data_date'
);

-- ============================================
-- 第二部分：添加 data_date 字段
-- ============================================

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `ad_snapshots` ADD COLUMN `data_date` DATE NOT NULL DEFAULT ''1970-01-01'' COMMENT ''数据日期（账户本地时区的自然日，用于分层落盘和真空期兜底）'' AFTER `timezone_name`',
  'SELECT ''字段 data_date 已存在，跳过添加字段步骤'' as result'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- 第三部分：回填现有数据的 data_date
-- ============================================
-- 
-- 说明：
-- 1. 根据 synced_at 和 timezone_name 计算 data_date
-- 2. 如果 timezone_name 为空或无效，使用 UTC
-- 3. 回填逻辑：将 synced_at 转换为账户时区的自然日

-- 注意：MySQL 不支持在 UPDATE 中直接使用时区转换函数
-- 这里使用简化逻辑：基于 UTC 时间计算（如果时区不一致，需要应用层处理）
-- 更精确的回填需要应用层脚本（见后续说明）

-- 临时回填：使用 DATE(synced_at) 作为初始值（UTC 时区）
-- 如果时区不是 UTC，后续同步时会自动更新为正确的 data_date
UPDATE `ad_snapshots` 
SET `data_date` = DATE(`synced_at`)
WHERE `data_date` = '1970-01-01' OR `data_date` IS NULL;

-- ============================================
-- 第四部分：检查并删除旧的唯一索引（如果存在）
-- ============================================
-- 
-- 注意：如果之前有基于 sync_session_id 的唯一索引，需要先删除
-- 因为我们要创建新的唯一索引 uk_account_ad_date

SET @index_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_snapshots'
    AND INDEX_NAME = 'uk_account_ad_date'
);

-- 如果唯一索引已存在，先删除（避免重复创建报错）
SET @sql = IF(@index_exists > 0,
  'SELECT ''唯一索引 uk_account_ad_date 已存在，跳过创建步骤'' as result',
  'ALTER TABLE `ad_snapshots` ADD UNIQUE INDEX `uk_account_ad_date` (`account_id`, `ad_id`, `data_date`) COMMENT ''唯一索引：确保每个账户每个广告每个自然日只有一条记录'''
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 如果索引不存在，创建它
SET @index_exists_after = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_snapshots'
    AND INDEX_NAME = 'uk_account_ad_date'
);

SET @sql = IF(@index_exists_after = 0,
  'ALTER TABLE `ad_snapshots` ADD UNIQUE INDEX `uk_account_ad_date` (`account_id`, `ad_id`, `data_date`) COMMENT ''唯一索引：确保每个账户每个广告每个自然日只有一条记录''',
  'SELECT ''唯一索引已创建'' as result'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- 第五部分：验证
-- ============================================

-- 显示添加结果
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

-- 检查唯一索引
SELECT 
  INDEX_NAME,
  COLUMN_NAME,
  NON_UNIQUE,
  SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ad_snapshots'
  AND INDEX_NAME = 'uk_account_ad_date'
ORDER BY SEQ_IN_INDEX;

-- 检查是否有 data_date 为 NULL 的记录（应该没有）
SELECT COUNT(*) as null_data_date_count
FROM ad_snapshots
WHERE data_date IS NULL OR data_date = '1970-01-01';

-- ============================================
-- 重要提示：时区精确回填
-- ============================================
-- 
-- 如果现有数据的 timezone_name 不是 UTC，上面的回填逻辑可能不准确
-- 建议在应用层创建一个回填脚本，使用 Luxon 库精确计算：
-- 
-- 示例 Node.js 回填脚本（需要手动创建）：
-- ```javascript
-- const { DateTime } = require('luxon');
-- const pool = require('./db/connection');
-- 
-- async function backfillDataDate() {
--   const [rows] = await pool.execute(`
--     SELECT id, account_id, synced_at, timezone_name 
--     FROM ad_snapshots 
--     WHERE data_date = '1970-01-01' OR data_date IS NULL
--   `);
--   
--   for (const row of rows) {
--     const tz = row.timezone_name || 'UTC';
--     const dt = DateTime.fromJSDate(row.synced_at).setZone(tz);
--     const dataDate = dt.toFormat('yyyy-MM-dd');
--     
--     await pool.execute(
--       'UPDATE ad_snapshots SET data_date = ? WHERE id = ?',
--       [dataDate, row.id]
--     );
--   }
-- }
-- ```
-- 
-- ============================================
-- 回滚脚本（如需回滚，请手动执行）
-- ============================================
-- 
-- -- 删除唯一索引
-- DROP INDEX `uk_account_ad_date` ON `ad_snapshots`;
-- 
-- -- 删除字段（注意：如果已有数据依赖此字段，删除前需要先处理）
-- ALTER TABLE `ad_snapshots` DROP COLUMN `data_date`;
-- 
-- ============================================

