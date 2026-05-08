-- Migration: 050_ensure_explanation_column_on_automation_logs.sql
-- 目的：修复部分环境漏执行 048 导致 automation_logs.explanation 缺失
-- 策略：幂等检查，列不存在才执行 ALTER

SET @col_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'automation_logs'
    AND COLUMN_NAME = 'explanation'
);

SET @ddl = IF(
  @col_exists = 0,
  'ALTER TABLE automation_logs ADD COLUMN explanation JSON NULL COMMENT ''对象级执行解释：target/window/input/aggregate/conditionTrace/logic''',
  'SELECT ''skip: automation_logs.explanation already exists'' AS msg'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

