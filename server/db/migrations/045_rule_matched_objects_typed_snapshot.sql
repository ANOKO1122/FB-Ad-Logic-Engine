-- Migration: 045_rule_matched_objects_typed_snapshot.sql
-- 目的：将 rule_matched_objects 从 ad-only 唯一键升级为 typed snapshot 唯一键
-- 兼容：幂等执行，适配历史环境索引命名差异（uk/uq）

-- 1) 删除旧唯一索引（历史命名之一：uk_rule_account_object）
SET @legacy_uk_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_matched_objects'
    AND INDEX_NAME = 'uk_rule_account_object'
);

SET @drop_legacy_uk_sql = IF(
  @legacy_uk_exists > 0,
  'ALTER TABLE rule_matched_objects DROP INDEX uk_rule_account_object',
  'SELECT ''skip: rule_matched_objects.uk_rule_account_object not found'' AS msg'
);

PREPARE stmt_drop_legacy_uk FROM @drop_legacy_uk_sql;
EXECUTE stmt_drop_legacy_uk;
DEALLOCATE PREPARE stmt_drop_legacy_uk;

-- 2) 删除旧唯一索引（历史命名之一：uq_rule_account_object）
SET @legacy_uq_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_matched_objects'
    AND INDEX_NAME = 'uq_rule_account_object'
);

SET @drop_legacy_uq_sql = IF(
  @legacy_uq_exists > 0,
  'ALTER TABLE rule_matched_objects DROP INDEX uq_rule_account_object',
  'SELECT ''skip: rule_matched_objects.uq_rule_account_object not found'' AS msg'
);

PREPARE stmt_drop_legacy_uq FROM @drop_legacy_uq_sql;
EXECUTE stmt_drop_legacy_uq;
DEALLOCATE PREPARE stmt_drop_legacy_uq;

-- 3) 新增 typed 唯一索引（rule_id + account_id + object_type + object_id）
SET @typed_unique_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_matched_objects'
    AND INDEX_NAME = 'uq_rule_account_type_object'
);

SET @add_typed_unique_sql = IF(
  @typed_unique_exists = 0,
  'ALTER TABLE rule_matched_objects ADD UNIQUE INDEX uq_rule_account_type_object (rule_id, account_id, object_type, object_id)',
  'SELECT ''skip: rule_matched_objects.uq_rule_account_type_object already exists'' AS msg'
);

PREPARE stmt_add_typed_unique FROM @add_typed_unique_sql;
EXECUTE stmt_add_typed_unique;
DEALLOCATE PREPARE stmt_add_typed_unique;

-- 4) 新增复合索引（account_id + rule_id + object_type）
SET @typed_lookup_idx_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rule_matched_objects'
    AND INDEX_NAME = 'idx_account_rule_type'
);

SET @add_typed_lookup_idx_sql = IF(
  @typed_lookup_idx_exists = 0,
  'ALTER TABLE rule_matched_objects ADD INDEX idx_account_rule_type (account_id, rule_id, object_type)',
  'SELECT ''skip: rule_matched_objects.idx_account_rule_type already exists'' AS msg'
);

PREPARE stmt_add_typed_lookup_idx FROM @add_typed_lookup_idx_sql;
EXECUTE stmt_add_typed_lookup_idx;
DEALLOCATE PREPARE stmt_add_typed_lookup_idx;
