-- ============================================
-- 迁移 031: rule_ad_execution_state 支持 scope_key（方案2）
-- 依据: .cursor/plans/budget-cooldown-and-prefight-refactor 方案 §一
-- ============================================
-- 目标：主键从 (rule_id, ad_id) 改为 (rule_id, scope_key)，支持广告与预算目标节点统一冷却
-- 执行：由你在本机/环境手动执行；建议低峰或停规则 Cron 后执行
-- ============================================

-- 1) 新增列（允许 NULL，便于回填）
ALTER TABLE `rule_ad_execution_state`
  ADD COLUMN `scope_key` VARCHAR(100) NULL COMMENT '冷却键：如 ad:123, budget_adset:xxx, budget_campaign:xxx' AFTER `ad_id`;

-- 2) 回填：现有行 scope_key = 'ad:' + ad_id
UPDATE `rule_ad_execution_state`
SET `scope_key` = CONCAT('ad:', `ad_id`)
WHERE `scope_key` IS NULL;

-- 3) 改为 NOT NULL
ALTER TABLE `rule_ad_execution_state`
  MODIFY COLUMN `scope_key` VARCHAR(100) NOT NULL COMMENT '冷却键：如 ad:123, budget_adset:xxx, budget_campaign:xxx';

-- 4) 删除原主键，新增主键
ALTER TABLE `rule_ad_execution_state`
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`rule_id`, `scope_key`);

-- 5) 为 scope_key 加索引（按 scope_key 查询时使用）
ALTER TABLE `rule_ad_execution_state`
  ADD INDEX `idx_scope_key` (`scope_key`);

-- 保留 ad_id 列用于诊断/兼容，不删除
-- ============================================
-- 验证（可选，你手动执行）
-- ============================================
-- SHOW CREATE TABLE rule_ad_execution_state;
-- SELECT rule_id, scope_key, ad_id, last_executed_at FROM rule_ad_execution_state LIMIT 5;
