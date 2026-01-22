-- ============================================
-- 迁移脚本：005_add_unique_index_to_daily_stats.sql
-- 目的：为 daily_stats 表添加唯一索引，确保 ON DUPLICATE KEY UPDATE 生效
-- 依据：方案C 阶段A - 冷数据归档优化
-- 创建时间：2026-01-20
-- ============================================
-- 
-- 执行前请先备份数据库！
-- 备份命令示例（Windows PowerShell）：
-- mysqldump -u root -p fb_ad_brain > backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql
-- 
-- 执行后验证：
-- SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
-- ============================================

-- ============================================
-- 第一部分：检查是否存在唯一索引（幂等性检查）
-- ============================================

-- 如果唯一索引已存在，先删除（避免重复创建报错）
-- 注意：在生产环境执行前，请先检查是否有重复数据
-- 如果有重复数据，需要先清理后再创建唯一索引

-- 检查是否存在重复数据（执行前建议先运行）
-- SELECT account_id, ad_id, date, COUNT(*) as cnt
-- FROM daily_stats
-- GROUP BY account_id, ad_id, date
-- HAVING cnt > 1;

-- ============================================
-- 第二部分：创建唯一索引
-- ============================================

-- 为 daily_stats 表创建唯一索引 (account_id, ad_id, date)
-- 确保同一账户、同一广告、同一日期只有一条记录
-- 这样 ON DUPLICATE KEY UPDATE 才能正确生效
CREATE UNIQUE INDEX `uk_account_ad_date` ON `daily_stats` (`account_id`, `ad_id`, `date`);

-- ============================================
-- 执行后验证（可选，手动执行）
-- ============================================
-- 
-- 1. 检查唯一索引是否创建成功：
--    SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
-- 
-- 2. 检查索引信息：
--    SELECT 
--      TABLE_NAME,
--      INDEX_NAME,
--      COLUMN_NAME,
--      NON_UNIQUE,
--      SEQ_IN_INDEX
--    FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = 'fb_ad_brain'
--      AND TABLE_NAME = 'daily_stats'
--      AND INDEX_NAME = 'uk_account_ad_date';
-- 
-- 3. 测试唯一约束（应该报错）：
--    INSERT INTO daily_stats (account_id, ad_id, date, owner_id, timezone_name, spend)
--    VALUES ('test_account', 'test_ad', '2026-01-20', 1, 'UTC', 100.00);
--    -- 再次插入相同数据应该报错：Duplicate entry 'test_account-test_ad-2026-01-20' for key 'uk_account_ad_date'
-- 
-- ============================================
-- 回滚脚本（如需回滚，请手动执行）
-- ============================================
-- 
-- DROP INDEX `uk_account_ad_date` ON `daily_stats`;
-- 
-- ============================================

