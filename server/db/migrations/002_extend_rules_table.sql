-- 扩展 rules 表的 SQL 迁移脚本
-- 按照 DEV_PLAN.md M3 的要求，添加规则配置层所需的新字段
-- 注意：这是安全的 ALTER TABLE 操作，不会丢失现有数据

-- ============================================
-- 第一步：添加目标范围字段
-- ============================================

-- target_level: 目标层级（ad/adset/campaign）
ALTER TABLE `rules` 
ADD COLUMN `target_level` VARCHAR(20) DEFAULT 'ad' 
COMMENT '目标层级：ad=广告, adset=广告组, campaign=广告系列'
AFTER `rule_name`;

-- target_ids: 目标ID列表（JSON数组）
ALTER TABLE `rules` 
ADD COLUMN `target_ids` JSON DEFAULT (JSON_ARRAY()) 
COMMENT '目标ID列表，JSON数组格式，如 ["ad_123", "ad_456"]'
AFTER `target_level`;

-- ============================================
-- 第二步：添加条件配置字段
-- ============================================

-- logic_operator: 逻辑运算符（AND/OR）
ALTER TABLE `rules` 
ADD COLUMN `logic_operator` VARCHAR(10) DEFAULT 'AND' 
COMMENT '逻辑运算符：AND=所有条件都满足, OR=任一条件满足'
AFTER `conditions`;

-- 注意：conditions 字段已经存在，但需要更新其结构以支持 time_window
-- 现有数据保持不变，新数据可以使用新格式：
-- [{ metric: 'spend', operator: 'gt', value: 20, time_window: 'today' }]

-- ============================================
-- 第三步：添加时区与执行模式字段
-- ============================================

-- timezone_name: 账户时区
ALTER TABLE `rules` 
ADD COLUMN `timezone_name` VARCHAR(50) DEFAULT 'UTC' 
COMMENT '账户时区，如 Asia/Shanghai, America/New_York'
AFTER `logic_operator`;

-- is_simulation: 是否 Dry Run 模式
ALTER TABLE `rules` 
ADD COLUMN `is_simulation` BOOLEAN DEFAULT FALSE 
COMMENT '是否模拟执行（Dry Run模式）：true=只记录日志不下发, false=真实执行'
AFTER `timezone_name`;

-- ============================================
-- 第四步：添加索引（提升查询性能）
-- ============================================

-- 为 target_level 添加索引（如果经常按层级查询）
CREATE INDEX `idx_target_level` ON `rules` (`target_level`);

-- 为 is_simulation 添加索引（如果经常筛选模拟/真实规则）
CREATE INDEX `idx_is_simulation` ON `rules` (`is_simulation`);

-- ============================================
-- 验证：检查表结构
-- ============================================
-- 执行完迁移后，可以运行以下命令验证：
-- DESCRIBE rules;
-- 应该看到新增的字段：target_level, target_ids, logic_operator, timezone_name, is_simulation

