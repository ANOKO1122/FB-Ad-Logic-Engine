-- ============================================
-- 迁移脚本：009_create_daily_archive_status.sql
-- 用途：归档任务注册表（PENDING → ARCHIVED → FINALIZED）
-- ============================================
-- 若表中已存在（如经本机或他处建表），可跳过执行。
-- 验证：SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_archive_status';
-- 若返回 1 行且表结构含 account_id, target_date, status, updated_at, last_error 及唯一索引 uk_account_date，则无需执行本脚本。
-- ============================================

-- 建表（幂等：仅当表不存在时执行）
CREATE TABLE IF NOT EXISTS `daily_archive_status` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `account_id` VARCHAR(50) NOT NULL COMMENT 'Facebook 账户ID',
  `target_date` DATE NOT NULL COMMENT '目标归档日期（账户本地时区的自然日）',
  `status` ENUM('PENDING', 'ARCHIVED', 'FINALIZED') NOT NULL DEFAULT 'PENDING' COMMENT '归档状态',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_error` TEXT NULL COMMENT '最后一次归档失败的错误信息',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_account_date` (`account_id`, `target_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='归档任务注册表';
