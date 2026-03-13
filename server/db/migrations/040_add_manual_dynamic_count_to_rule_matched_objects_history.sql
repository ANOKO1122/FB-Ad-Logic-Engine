-- ============================================
-- 迁移脚本：040_add_manual_dynamic_count_to_rule_matched_objects_history.sql
-- 目的：为 rule_matched_objects_history 增加 manual_count、dynamic_count 计数维度（动态筛选防误判与审计增强方案 §2.1）
--
-- 字段含义：
--   manual_count  当次手动目标展开到 ad 的数量（union 前）
--   dynamic_count 当次动态筛选得到的 ad 数量（union 前）
-- 用途：排障时可区分「筛选异常」与「手动勾选变化」；NULL 表示兼容旧数据。
--
-- 本脚本为幂等：若列已存在（例如已执行过 040）则跳过，不会报 Duplicate column name。
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/040_add_manual_dynamic_count_to_rule_matched_objects_history.sql
--
-- 验证：
--   DESCRIBE rule_matched_objects_history;
--   -- 应看到 manual_count INT NULL, dynamic_count INT NULL
-- ============================================

DELIMITER //
CREATE PROCEDURE add_manual_dynamic_count_if_missing()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rule_matched_objects_history' AND COLUMN_NAME = 'manual_count') THEN
    ALTER TABLE rule_matched_objects_history
      ADD COLUMN manual_count INT NULL COMMENT '当次手动目标展开到 ad 的数量（union 前）' AFTER object_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rule_matched_objects_history' AND COLUMN_NAME = 'dynamic_count') THEN
    ALTER TABLE rule_matched_objects_history
      ADD COLUMN dynamic_count INT NULL COMMENT '当次动态筛选得到的 ad 数量（union 前）' AFTER manual_count;
  END IF;
END //
DELIMITER ;
CALL add_manual_dynamic_count_if_missing();
DROP PROCEDURE IF EXISTS add_manual_dynamic_count_if_missing;

-- 回滚（仅在需要时手动执行，慎用）：
-- ALTER TABLE rule_matched_objects_history DROP COLUMN manual_count, DROP COLUMN dynamic_count;
