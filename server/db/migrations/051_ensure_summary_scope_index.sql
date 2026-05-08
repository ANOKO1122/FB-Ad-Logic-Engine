-- Migration: 051_ensure_summary_scope_index.sql
-- 目的：幂等修复 rule_execution_summaries.summary_scope 列与 idx_summary_scope 索引
-- 场景：部分环境执行 049 时因重复列报错中断，导致索引未创建（半生效）

SET @summary_scope_col_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_execution_summaries'
    AND COLUMN_NAME = 'summary_scope'
);

SET @summary_scope_add_column_sql = IF(
  @summary_scope_col_exists = 0,
  'ALTER TABLE rule_execution_summaries ADD COLUMN summary_scope VARCHAR(20) DEFAULT NULL COMMENT ''摘要层级：account=账户级明细，rollup=汇总级，NULL=历史数据（兼容）'' AFTER status',
  'SELECT ''skip: rule_execution_summaries.summary_scope already exists'' AS msg'
);

PREPARE stmt_summary_scope_col FROM @summary_scope_add_column_sql;
EXECUTE stmt_summary_scope_col;
DEALLOCATE PREPARE stmt_summary_scope_col;

SET @summary_scope_idx_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_execution_summaries'
    AND INDEX_NAME = 'idx_summary_scope'
);

SET @summary_scope_add_index_sql = IF(
  @summary_scope_idx_exists = 0,
  'ALTER TABLE rule_execution_summaries ADD INDEX idx_summary_scope (summary_scope)',
  'SELECT ''skip: rule_execution_summaries.idx_summary_scope already exists'' AS msg'
);

PREPARE stmt_summary_scope_idx FROM @summary_scope_add_index_sql;
EXECUTE stmt_summary_scope_idx;
DEALLOCATE PREPARE stmt_summary_scope_idx;
