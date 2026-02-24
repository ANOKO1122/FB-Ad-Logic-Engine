-- ============================================
-- 迁移脚本 008: 为 rules 表添加 last_executed_at 字段
-- 用途: 实现规则执行冷却期机制，防止重复执行
-- ============================================

-- 添加 last_executed_at 字段
-- 存储规则上次执行的时间（UTC），用于计算是否满足冷却期
ALTER TABLE `rules` 
ADD COLUMN `last_executed_at` TIMESTAMP NULL 
COMMENT '上次执行时间（UTC），用于冷却期计算'
AFTER `updated_at`;

-- 添加索引（用于快速查询"哪些规则到期了"）
CREATE INDEX `idx_rules_last_executed` ON `rules` (`last_executed_at`);

-- ============================================
-- 验证
-- ============================================
-- DESCRIBE rules;
-- 应该看到新增的字段：last_executed_at

-- ============================================
-- 冷却期机制说明
-- ============================================
-- 1. 每分钟 Cron 检查一次
-- 2. 只执行满足条件的规则：
--    - enabled = true
--    - last_executed_at IS NULL（从未执行过）
--    - 或 NOW() - last_executed_at >= 15 分钟
-- 3. 无论手动还是自动触发，执行后都更新 last_executed_at
-- 4. 这样可以防止手动触发后很快又自动触发



