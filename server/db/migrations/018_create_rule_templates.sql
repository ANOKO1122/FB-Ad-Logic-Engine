-- ============================================
-- 迁移脚本：018_create_rule_templates.sql
-- 目的：创建规则模板表（管理员管理，普通用户只读使用）
-- 依据：docs/2.3.2_自定义模板页面_设计案.md
--
-- 执行前请备份数据库。
-- 执行后验证：
--   SHOW TABLES LIKE 'rule_templates';
--   DESCRIBE rule_templates;
--   SHOW INDEX FROM rule_templates;
-- ============================================

CREATE TABLE IF NOT EXISTS rule_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT '模板展示名，如「止损」',
  slug VARCHAR(50) NOT NULL COMMENT '唯一标识，如 stop_loss',
  description VARCHAR(500) DEFAULT NULL COMMENT '简要说明',
  when_lines JSON NOT NULL COMMENT '条件行 [{join,metric,operator,value},...]',
  when_time_window VARCHAR(50) NOT NULL COMMENT 'today|yesterday|last_3_days|lifetime|custom_range',
  when_custom_range JSON DEFAULT NULL COMMENT 'custom_range 时的 {since,until}',
  actions JSON NOT NULL COMMENT '动作 [{type,value,max_daily_budget},...]',
  sort_order INT DEFAULT 0 COMMENT '排序，小的在前',
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用（软删除/禁用）',
  created_by INT DEFAULT NULL COMMENT '创建人（用户ID）',
  updated_by INT DEFAULT NULL COMMENT '最后更新人（用户ID）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_slug (slug),
  INDEX idx_sort_order (sort_order),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则模板（管理员 CRUD，普通用户只读应用）';

-- ============================================
-- 回滚（仅在需要时由你手动执行，慎用）
-- ============================================
-- DROP TABLE IF EXISTS rule_templates;
-- ============================================
