-- ============================================
-- 迁移脚本：024_create_structure_adsets.sql
-- 目的：创建结构镜像表 structure_adsets（广告组层级）
-- 依据：TASKS 顺序2 结构镜像扩展；与 structure_ads 同口径，三层查库
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
-- 备份示例（PowerShell）：mysqldump -u root -p <数据库名> > backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql
--
-- 执行后验证：
--   SHOW TABLES LIKE 'structure_adsets';
--   DESCRIBE structure_adsets;
--   SHOW INDEX FROM structure_adsets;
-- ============================================

CREATE TABLE IF NOT EXISTS structure_adsets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(50) NOT NULL COMMENT '广告账户 ID',
  adset_id VARCHAR(50) NOT NULL COMMENT '广告组 ID（FB 对象 id）',
  campaign_id VARCHAR(50) DEFAULT NULL COMMENT '广告系列 ID',
  name VARCHAR(500) DEFAULT NULL COMMENT '广告组名称',
  effective_status VARCHAR(50) DEFAULT NULL COMMENT '有效状态：ACTIVE/PAUSED/DELETED/ARCHIVED 等',
  status VARCHAR(50) DEFAULT NULL COMMENT '状态（原始）',
  updated_time VARCHAR(80) DEFAULT NULL COMMENT 'FB 返回的 updated_time（ISO8601 字符串）',
  last_synced_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP COMMENT '本库最近一次从 FB 同步时间',

  UNIQUE KEY uk_account_adset (account_id, adset_id),
  INDEX idx_account_effective_status (account_id, effective_status),
  INDEX idx_account_campaign (account_id, campaign_id),
  INDEX idx_account_name (account_id, name(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='结构镜像表-广告组（选择器读库用，不存指标）';

-- ============================================
-- 回滚（仅在需要时由你手动执行，慎用）
-- ============================================
-- DROP TABLE IF EXISTS structure_adsets;
-- ============================================
