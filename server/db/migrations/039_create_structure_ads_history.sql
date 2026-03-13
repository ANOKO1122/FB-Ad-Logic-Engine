-- ============================================
-- 迁移脚本：039_create_structure_ads_history.sql
-- 目的：创建结构广告 name/status 变更历史表（历史数据与审计方案 P2）
-- 依据：历史数据与审计落地方案 § 五、P2：structure_ads_history
--
-- 表用途：
--   - 仅在 name 或 effective_status 发生变化时写入（Change-Only）
--   - 写入走异步队列 + 背压 5000，不阻塞主同步
--   - 保留期 60 天，由 NightlyCleanupTask 按 changed_at 分批删除
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/039_create_structure_ads_history.sql
--
-- 验证：
--   SHOW TABLES LIKE 'structure_ads_history';
--   DESCRIBE structure_ads_history;
--   SHOW INDEX FROM structure_ads_history;
-- ============================================

CREATE TABLE IF NOT EXISTS structure_ads_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(50) NOT NULL COMMENT '广告账户 ID',
  ad_id VARCHAR(50) NOT NULL COMMENT '广告 ID',
  changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '变更时间',
  name VARCHAR(500) DEFAULT NULL COMMENT '广告名称（变更后）',
  effective_status VARCHAR(50) DEFAULT NULL COMMENT '有效状态（变更后）',
  source VARCHAR(32) NULL COMMENT '来源（可选）',

  KEY idx_account_ad_changed (account_id, ad_id, changed_at),
  KEY idx_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='结构广告 name/status 变更历史（保留 60 天，仅变化时异步写入）';

-- 回滚（仅在需要时手动执行，慎用）：
-- DROP TABLE IF EXISTS structure_ads_history;
