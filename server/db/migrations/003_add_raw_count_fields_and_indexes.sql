-- ============================================
-- 迁移脚本：003_add_raw_count_fields_and_indexes.sql
-- 目的：为 ad_snapshots 和 daily_stats 表添加原始计数字段、操作元数据字段和性能索引
-- 依据：方案B+优化版-最终版.md 阶段1
-- 创建时间：2026-01-16
-- ============================================
-- 
-- 执行前请先备份数据库！
-- 备份命令示例（Windows）：
-- mysqldump -u root -p your_database_name > backup_$(date +%Y%m%d_%H%M%S).sql
-- 
-- 执行后验证：
-- DESCRIBE ad_snapshots;
-- DESCRIBE daily_stats;
-- SHOW INDEX FROM ad_snapshots;
-- SHOW INDEX FROM daily_stats;
-- ============================================

-- ============================================
-- 第一部分：为 ad_snapshots 表添加字段
-- ============================================

-- 新增 6 个原始计数字段（用于动态计算 CPC、ROAS、加购费、结账费、支付费）
ALTER TABLE `ad_snapshots`
ADD COLUMN `link_clicks` INT DEFAULT 0 COMMENT '链接点击次数（CPC分母，来源：inline_link_clicks）',
ADD COLUMN `unique_link_clicks` INT DEFAULT 0 COMMENT '独立链接点击次数（uCPC分母，来源：unique_inline_link_clicks）',
ADD COLUMN `purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT '购买总转化金额（ROAS分子，来源：action_values）',
ADD COLUMN `add_to_cart_count` INT DEFAULT 0 COMMENT '加购次数（加购费分母，来源：actions）',
ADD COLUMN `initiate_checkout_count` INT DEFAULT 0 COMMENT '发起结账次数（结账费分母，来源：actions）',
ADD COLUMN `add_payment_info_count` INT DEFAULT 0 COMMENT '添加支付信息次数（支付费分母，来源：actions）';

-- 新增操作元数据字段（用于规则动作：增减预算需要 adset_id）
ALTER TABLE `ad_snapshots`
ADD COLUMN `ad_set_id` VARCHAR(50) DEFAULT NULL COMMENT '广告组ID（用于规则动作：增减预算）';

-- ============================================
-- 第二部分：为 ad_snapshots 表添加索引（性能优化）
-- ============================================

-- 多天窗口高效聚合索引（按账户和时间范围查询）
CREATE INDEX `idx_account_synced` ON `ad_snapshots` (`account_id`, `synced_at`);

-- 多天窗口高效聚合索引（按广告和时间范围查询）
CREATE INDEX `idx_ad_synced` ON `ad_snapshots` (`ad_id`, `synced_at`);

-- 最后快照查询索引（降级策略：查询每个广告的最后一次快照）
CREATE INDEX `idx_ad_synced_desc` ON `ad_snapshots` (`ad_id`, `synced_at` DESC);

-- ============================================
-- 第三部分：为 daily_stats 表添加字段
-- ============================================

-- 新增 6 个原始计数字段（与 ad_snapshots 保持一致）
ALTER TABLE `daily_stats`
ADD COLUMN `link_clicks` INT DEFAULT 0 COMMENT '链接点击次数（CPC分母，来源：inline_link_clicks）',
ADD COLUMN `unique_link_clicks` INT DEFAULT 0 COMMENT '独立链接点击次数（uCPC分母，来源：unique_inline_link_clicks）',
ADD COLUMN `purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT '购买总转化金额（ROAS分子，来源：action_values）',
ADD COLUMN `add_to_cart_count` INT DEFAULT 0 COMMENT '加购次数（加购费分母，来源：actions）',
ADD COLUMN `initiate_checkout_count` INT DEFAULT 0 COMMENT '发起结账次数（结账费分母，来源：actions）',
ADD COLUMN `add_payment_info_count` INT DEFAULT 0 COMMENT '添加支付信息次数（支付费分母，来源：actions）';

-- 新增操作元数据字段（用于规则动作：增减预算需要 adset_id）
ALTER TABLE `daily_stats`
ADD COLUMN `ad_set_id` VARCHAR(50) DEFAULT NULL COMMENT '广告组ID（用于规则动作：增减预算）';

-- ============================================
-- 第四部分：为 daily_stats 表添加索引（性能优化）
-- ============================================

-- 多天窗口高效聚合索引（按账户和日期范围查询）
CREATE INDEX `idx_account_date` ON `daily_stats` (`account_id`, `date`);

-- 多天窗口高效聚合索引（按广告和日期范围查询）
CREATE INDEX `idx_ad_date` ON `daily_stats` (`ad_id`, `date`);

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
-- 3. 检查新字段的默认值：
--    SELECT COUNT(*) FROM ad_snapshots WHERE link_clicks = 0;
--    SELECT COUNT(*) FROM daily_stats WHERE link_clicks = 0;
-- 
-- ============================================
-- 回滚脚本（如需回滚，请手动执行）
-- ============================================
-- 
-- -- 删除 ad_snapshots 表的索引
-- DROP INDEX `idx_account_synced` ON `ad_snapshots`;
-- DROP INDEX `idx_ad_synced` ON `ad_snapshots`;
-- DROP INDEX `idx_ad_synced_desc` ON `ad_snapshots`;
-- 
-- -- 删除 ad_snapshots 表的字段
-- ALTER TABLE `ad_snapshots`
-- DROP COLUMN `link_clicks`,
-- DROP COLUMN `unique_link_clicks`,
-- DROP COLUMN `purchase_value`,
-- DROP COLUMN `add_to_cart_count`,
-- DROP COLUMN `initiate_checkout_count`,
-- DROP COLUMN `add_payment_info_count`,
-- DROP COLUMN `ad_set_id`;
-- 
-- -- 删除 daily_stats 表的索引
-- DROP INDEX `idx_account_date` ON `daily_stats`;
-- DROP INDEX `idx_ad_date` ON `daily_stats`;
-- 
-- -- 删除 daily_stats 表的字段
-- ALTER TABLE `daily_stats`
-- DROP COLUMN `link_clicks`,
-- DROP COLUMN `unique_link_clicks`,
-- DROP COLUMN `purchase_value`,
-- DROP COLUMN `add_to_cart_count`,
-- DROP COLUMN `initiate_checkout_count`,
-- DROP COLUMN `add_payment_info_count`,
-- DROP COLUMN `ad_set_id`;
-- 
-- ============================================

