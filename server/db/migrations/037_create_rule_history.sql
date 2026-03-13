-- ============================================
-- 迁移脚本：037_create_rule_history.sql
-- 目的：创建规则配置变更历史表 rule_history（历史数据与审计方案 P0）
-- 依据：历史数据与审计落地方案 § 三、P0：rule_history
--
-- 表用途：
--   - 记录规则「谁在何时改了什么」：CREATE/UPDATE/DELETE/TOGGLE/动态刷新回写(SYSTEM_REFRESH)
--   - rule_snapshot 仅存配置字段，严禁 matched_count、dynamic_scope_status、last_executed_at 等
--   - 保留期 60 天，由 NightlyCleanupTask 按 changed_at 分批删除
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/037_create_rule_history.sql
--
-- 验证：
--   SHOW TABLES LIKE 'rule_history';
--   DESCRIBE rule_history;
--   SHOW INDEX FROM rule_history;
-- ============================================

CREATE TABLE IF NOT EXISTS rule_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  rule_id INT NOT NULL COMMENT '规则 ID（rules.id）',
  change_type ENUM('CREATE','UPDATE','DELETE','TOGGLE','SYSTEM_REFRESH') NOT NULL COMMENT '变更类型',
  changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '变更时间',
  source VARCHAR(32) NOT NULL COMMENT '来源：api_save | api_toggle | dynamic_scope_refresh',
  changed_by_user_id INT NULL COMMENT '操作用户 ID（系统刷新为 NULL）',
  changed_by_owner_id INT NULL COMMENT '负责人 ID（可选）',
  rule_snapshot JSON NULL COMMENT '规则配置快照（仅配置字段，见方案 3.2）',
  added_ids JSON NULL COMMENT '可选，排障用',
  removed_ids JSON NULL COMMENT '可选，排障用',

  KEY idx_rule_changed (rule_id, changed_at),
  KEY idx_changed_at (changed_at),
  KEY idx_change_type (change_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则配置变更历史（保留 60 天）';

-- 回滚（仅在需要时手动执行，慎用）：
-- DROP TABLE IF EXISTS rule_history;
