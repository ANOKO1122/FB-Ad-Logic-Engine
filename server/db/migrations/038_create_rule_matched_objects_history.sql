-- ============================================
-- 迁移脚本：038_create_rule_matched_objects_history.sql
-- 目的：创建动态规则匹配对象变动历史表（历史数据与审计方案 P1）
-- 依据：历史数据与审计落地方案 § 四、P1：rule_matched_objects_history
--
-- 表用途：
--   - 仅在 refresh 时「有增删」写入；无变化不插入（Change-Only）
--   - added_count/removed_count 便于列表过滤与排障；object_count>500 时 snapshot 只存前 100 + checksum
--   - 保留期 30 天，由 NightlyCleanupTask 按 refreshed_at 分批删除
--
-- 索引说明：
--   - (rule_id, refreshed_at, account_id)：典型查询「某规则的所有变动历史」或按时间范围 range scan
--   - (refreshed_at)：清理任务按 refreshed_at 删除超期数据
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/038_create_rule_matched_objects_history.sql
--
-- 验证：
--   SHOW TABLES LIKE 'rule_matched_objects_history';
--   DESCRIBE rule_matched_objects_history;
--   SHOW INDEX FROM rule_matched_objects_history;
-- ============================================

CREATE TABLE IF NOT EXISTS rule_matched_objects_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  rule_id INT NOT NULL COMMENT '规则 ID',
  account_id VARCHAR(50) NOT NULL COMMENT '广告账户 ID',
  refreshed_at TIMESTAMP(6) NOT NULL COMMENT '本次刷新时间',
  trigger_type VARCHAR(32) DEFAULT NULL COMMENT '触发类型',
  object_count INT NOT NULL DEFAULT 0 COMMENT '本次快照对象总数',
  added_count INT NOT NULL DEFAULT 0 COMMENT '相对上一份新增个数',
  removed_count INT NOT NULL DEFAULT 0 COMMENT '相对上一份移除个数',
  object_ids_snapshot JSON NULL COMMENT 'ID 快照（object_count>500 时仅前 100）',
  object_ids_checksum VARCHAR(64) NULL COMMENT 'object_count>500 时存 MD5(sorted_ids)，用于快速比对',

  KEY idx_rule_refreshed_account (rule_id, refreshed_at, account_id),
  KEY idx_refreshed_at (refreshed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='动态规则匹配对象变动历史（保留 30 天，仅变化时写入）';

-- 回滚（仅在需要时手动执行，慎用）：
-- DROP TABLE IF EXISTS rule_matched_objects_history;
