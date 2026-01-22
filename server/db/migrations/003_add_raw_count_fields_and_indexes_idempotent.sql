-- ============================================
-- 迁移脚本（幂等版本）：003_add_raw_count_fields_and_indexes_idempotent.sql
-- 目的：为 ad_snapshots 和 daily_stats 表添加原始计数字段、操作元数据字段和性能索引
-- 特点：幂等执行（可以重复执行，不会报错）
-- 依据：方案B+优化版-最终版.md 阶段1
-- 创建时间：2026-01-16
-- ============================================
-- 
-- 使用说明：
-- 1. 此脚本使用存储过程实现幂等性（可以重复执行）
-- 2. 如果字段/索引已存在，会跳过（不会报错）
-- 3. 执行前请先备份数据库！
-- 
-- 执行方式：
-- source D:/projects/FB-Ad-Logic-Engine/server/db/migrations/003_add_raw_count_fields_and_indexes_idempotent.sql
-- ============================================

-- 设置分隔符（用于存储过程）
DELIMITER $$

-- ============================================
-- 辅助函数：检查字段是否存在
-- ============================================
DROP PROCEDURE IF EXISTS add_column_if_not_exists$$
CREATE PROCEDURE add_column_if_not_exists(
    IN p_table_name VARCHAR(64),
    IN p_column_name VARCHAR(64),
    IN p_column_definition TEXT
)
BEGIN
    DECLARE column_exists INT DEFAULT 0;
    
    SELECT COUNT(*) INTO column_exists
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table_name
      AND COLUMN_NAME = p_column_name;
    
    IF column_exists = 0 THEN
        SET @sql = CONCAT('ALTER TABLE `', p_table_name, '` ADD COLUMN ', p_column_definition);
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
        SELECT CONCAT('✅ 已添加字段: ', p_table_name, '.', p_column_name) AS result;
    ELSE
        SELECT CONCAT('⏭️  字段已存在，跳过: ', p_table_name, '.', p_column_name) AS result;
    END IF;
END$$

-- ============================================
-- 辅助函数：检查索引是否存在
-- ============================================
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
        SELECT CONCAT('✅ 已添加索引: ', p_table_name, '.', p_index_name) AS result;
    ELSE
        SELECT CONCAT('⏭️  索引已存在，跳过: ', p_table_name, '.', p_index_name) AS result;
    END IF;
END$$

-- 恢复分隔符
DELIMITER ;

-- ============================================
-- 第一部分：为 ad_snapshots 表添加字段
-- ============================================

-- 新增 6 个原始计数字段
CALL add_column_if_not_exists('ad_snapshots', 'link_clicks', 
    '`link_clicks` INT DEFAULT 0 COMMENT ''链接点击次数（CPC分母，来源：inline_link_clicks）''');

CALL add_column_if_not_exists('ad_snapshots', 'unique_link_clicks', 
    '`unique_link_clicks` INT DEFAULT 0 COMMENT ''独立链接点击次数（uCPC分母，来源：unique_inline_link_clicks）''');

CALL add_column_if_not_exists('ad_snapshots', 'purchase_value', 
    '`purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT ''购买总转化金额（ROAS分子，来源：action_values）''');

CALL add_column_if_not_exists('ad_snapshots', 'add_to_cart_count', 
    '`add_to_cart_count` INT DEFAULT 0 COMMENT ''加购次数（加购费分母，来源：actions）''');

CALL add_column_if_not_exists('ad_snapshots', 'initiate_checkout_count', 
    '`initiate_checkout_count` INT DEFAULT 0 COMMENT ''发起结账次数（结账费分母，来源：actions）''');

CALL add_column_if_not_exists('ad_snapshots', 'add_payment_info_count', 
    '`add_payment_info_count` INT DEFAULT 0 COMMENT ''添加支付信息次数（支付费分母，来源：actions）''');

-- 新增操作元数据字段
CALL add_column_if_not_exists('ad_snapshots', 'ad_set_id', 
    '`ad_set_id` VARCHAR(50) DEFAULT NULL COMMENT ''广告组ID（用于规则动作：增减预算）''');

-- ============================================
-- 第二部分：为 ad_snapshots 表添加索引
-- ============================================

CALL add_index_if_not_exists('ad_snapshots', 'idx_account_synced', 
    '(`account_id`, `synced_at`)');

CALL add_index_if_not_exists('ad_snapshots', 'idx_ad_synced', 
    '(`ad_id`, `synced_at`)');

CALL add_index_if_not_exists('ad_snapshots', 'idx_ad_synced_desc', 
    '(`ad_id`, `synced_at` DESC)');

-- ============================================
-- 第三部分：为 daily_stats 表添加字段
-- ============================================

CALL add_column_if_not_exists('daily_stats', 'link_clicks', 
    '`link_clicks` INT DEFAULT 0 COMMENT ''链接点击次数（CPC分母，来源：inline_link_clicks）''');

CALL add_column_if_not_exists('daily_stats', 'unique_link_clicks', 
    '`unique_link_clicks` INT DEFAULT 0 COMMENT ''独立链接点击次数（uCPC分母，来源：unique_inline_link_clicks）''');

CALL add_column_if_not_exists('daily_stats', 'purchase_value', 
    '`purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT ''购买总转化金额（ROAS分子，来源：action_values）''');

CALL add_column_if_not_exists('daily_stats', 'add_to_cart_count', 
    '`add_to_cart_count` INT DEFAULT 0 COMMENT ''加购次数（加购费分母，来源：actions）''');

CALL add_column_if_not_exists('daily_stats', 'initiate_checkout_count', 
    '`initiate_checkout_count` INT DEFAULT 0 COMMENT ''发起结账次数（结账费分母，来源：actions）''');

CALL add_column_if_not_exists('daily_stats', 'add_payment_info_count', 
    '`add_payment_info_count` INT DEFAULT 0 COMMENT ''添加支付信息次数（支付费分母，来源：actions）''');

-- 新增操作元数据字段
CALL add_column_if_not_exists('daily_stats', 'ad_set_id', 
    '`ad_set_id` VARCHAR(50) DEFAULT NULL COMMENT ''广告组ID（用于规则动作：增减预算）''');

-- ============================================
-- 第四部分：为 daily_stats 表添加索引
-- ============================================

CALL add_index_if_not_exists('daily_stats', 'idx_account_date', 
    '(`account_id`, `date`)');

CALL add_index_if_not_exists('daily_stats', 'idx_ad_date', 
    '(`ad_id`, `date`)');

-- ============================================
-- 清理临时存储过程
-- ============================================
DROP PROCEDURE IF EXISTS add_column_if_not_exists;
DROP PROCEDURE IF EXISTS add_index_if_not_exists;

-- ============================================
-- 执行后验证（可选，手动执行）
-- ============================================
-- 
-- 1. 检查字段是否创建成功：
--    DESCRIBE ad_snapshots;
--    DESCRIBE daily_stats;
-- 
-- 2. 检查索引是否创建成功：
--    SHOW INDEX FROM ad_snapshots;
--    SHOW INDEX FROM daily_stats;
-- 
-- ============================================

