-- 创建 rules 表的 SQL 脚本
-- 你可以手动在 MySQL 中执行这个脚本

CREATE TABLE IF NOT EXISTS `rules` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL COMMENT '用户ID，关联到users表',
  `rule_name` VARCHAR(255) NOT NULL COMMENT '规则名称',
  `conditions` JSON NOT NULL COMMENT '规则条件，JSON格式',
  `actions` JSON NOT NULL COMMENT '执行操作，JSON格式',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否启用',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='自动化规则表';


