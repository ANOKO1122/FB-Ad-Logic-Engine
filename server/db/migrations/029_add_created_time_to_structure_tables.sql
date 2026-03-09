-- ============================================
-- 迁移脚本：029_add_created_time_to_structure_tables.sql
-- 目的：在结构镜像三张表中增加 created_time 字段，供监控范围条件「创建时间段」后续扩展
-- 说明：仅加列。若已执行过 ALTER，再次执行会报「Duplicate column」可忽略。
--
-- 执行后验证：
--   SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'structure_ads' AND COLUMN_NAME = 'created_time';
-- ============================================

ALTER TABLE structure_ads ADD COLUMN created_time VARCHAR(80) DEFAULT NULL COMMENT 'FB 返回的 created_time（ISO8601）' AFTER updated_time;
ALTER TABLE structure_adsets ADD COLUMN created_time VARCHAR(80) DEFAULT NULL COMMENT 'FB 返回的 created_time（ISO8601）' AFTER updated_time;
ALTER TABLE structure_campaigns ADD COLUMN created_time VARCHAR(80) DEFAULT NULL COMMENT 'FB 返回的 created_time（ISO8601）' AFTER updated_time;
