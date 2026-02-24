-- 迁移脚本：为 rules 表添加 account_id 字段
-- 用途：限定规则只作用于指定的广告账户
-- 日期：2026-01-23

-- 添加 account_id 字段（可为空，向后兼容旧规则）
-- 如果字段已存在，则跳过
SET @column_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'rules' 
    AND COLUMN_NAME = 'account_id'
);

SET @sql = IF(@column_exists = 0, 
    'ALTER TABLE rules ADD COLUMN account_id VARCHAR(50) NULL AFTER user_id COMMENT ''广告账户ID，限定规则只作用于此账户''',
    'SELECT ''account_id 字段已存在，跳过'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 添加索引（如果不存在）
SET @index_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'rules' 
    AND INDEX_NAME = 'idx_rules_account_id'
);

SET @sql = IF(@index_exists = 0, 
    'ALTER TABLE rules ADD INDEX idx_rules_account_id (account_id)',
    'SELECT ''idx_rules_account_id 索引已存在，跳过'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 验证
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    IS_NULLABLE, 
    COLUMN_COMMENT 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
AND TABLE_NAME = 'rules' 
AND COLUMN_NAME = 'account_id';



