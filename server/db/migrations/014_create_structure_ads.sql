-- ============================================
-- 迁移脚本：014_create_structure_ads.sql
-- 目的：创建结构镜像表 structure_ads（顺序2 阶段 2.1）
-- 依据：TASKS.md 1.2 结构镜像表、DEV_PLAN 顺序2 口径
-- 说明：仅广告层级；campaigns/adsets 表在后续阶段按需添加
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
-- 备份示例（PowerShell）：mysqldump -u root -p <数据库名> > backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql
--
-- 执行后验证：
--   SHOW TABLES LIKE 'structure_ads';
--   DESCRIBE structure_ads;
--   SHOW INDEX FROM structure_ads;
-- ============================================

CREATE TABLE IF NOT EXISTS structure_ads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(50) NOT NULL COMMENT '广告账户 ID',
  ad_id VARCHAR(50) NOT NULL COMMENT '广告 ID（FB 对象 id）',
  adset_id VARCHAR(50) DEFAULT NULL COMMENT '广告组 ID',
  campaign_id VARCHAR(50) DEFAULT NULL COMMENT '广告系列 ID',
  name VARCHAR(500) DEFAULT NULL COMMENT '广告名称',
  effective_status VARCHAR(50) DEFAULT NULL COMMENT '有效状态（选择器默认过滤用）：ACTIVE/PAUSED/DELETED/ARCHIVED 等',
  status VARCHAR(50) DEFAULT NULL COMMENT '状态（原始）',
  configured_status VARCHAR(50) DEFAULT NULL COMMENT '配置状态（可选）',
  updated_time VARCHAR(80) DEFAULT NULL COMMENT 'FB 返回的 updated_time（ISO8601 字符串）',
  last_synced_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP COMMENT '本库最近一次从 FB 同步时间',

  UNIQUE KEY uk_account_ad (account_id, ad_id),
  INDEX idx_account_effective_status (account_id, effective_status),
  INDEX idx_account_name (account_id, name(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='结构镜像表-广告（选择器读库用，不存指标）';

-- ============================================
-- 回滚（仅在需要时由你手动执行，慎用）
-- ============================================
-- DROP TABLE IF EXISTS structure_ads;
-- ============================================
