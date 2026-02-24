-- ============================================
-- 迁移脚本（幂等）：017_add_idx_account_date_ad_idempotent.sql
-- 目的：为 ad_snapshots 增加 data_date 路径联合索引
-- 索引：idx_account_date_ad (account_id, data_date, ad_id)
--
-- 背景：
-- - 归档主路径与回退路径均以 data_date 作为自然日口径
-- - 当环境触发兼容回退（或需要按 data_date 高效过滤）时，该索引可显著降低扫描成本
--
-- 幂等性：
-- - 使用存储过程 add_index_if_not_exists：索引不存在则创建，存在则跳过
--
-- 执行方式：
-- source D:/projects/FB-Ad-Logic-Engine/server/db/migrations/017_add_idx_account_date_ad_idempotent.sql
-- ============================================

DELIMITER $$

DROP PROCEDURE IF EXISTS add_index_if_not_exists$$
CREATE PROCEDURE add_index_if_not_exists(
    IN p_table_name VARCHAR(64),
    IN p_index_name VARCHAR(64),
    IN p_index_definition TEXT
)
BEGIN
    DECLARE index_exists INT DEFAULT 0;
    
    SELECT COUNT(*) INTO index_exists
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table_name
      AND INDEX_NAME = p_index_name;
    
    IF index_exists = 0 THEN
        SET @sql = CONCAT('CREATE INDEX `', p_index_name, '` ON `', p_table_name, '` ', p_index_definition);
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
        -- 注意：避免 emoji 导致字符集/排序规则冲突（Illegal mix of collations）
        SELECT CONCAT('OK index added: ', p_table_name, '.', p_index_name) AS result;
    ELSE
        SELECT CONCAT('OK index exists, skipped: ', p_table_name, '.', p_index_name) AS result;
    END IF;
END$$

DELIMITER ;

-- 创建索引（不存在则创建）
CALL add_index_if_not_exists('ad_snapshots', 'idx_account_date_ad',
    '(`account_id`, `data_date`, `ad_id`)');

-- 清理存储过程
DROP PROCEDURE IF EXISTS add_index_if_not_exists;

-- ============================================
-- 验证（手动执行）
-- ============================================
-- SHOW INDEX FROM ad_snapshots WHERE Key_name = 'idx_account_date_ad';

