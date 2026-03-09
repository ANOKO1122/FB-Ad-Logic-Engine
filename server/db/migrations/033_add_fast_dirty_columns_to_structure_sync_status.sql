-- ============================================
-- 迁移脚本：033_add_fast_dirty_columns_to_structure_sync_status.sql
-- 目的：为 Track2 Fast Sync 增加 dirty 联动字段（规则执行前刷新闭环）
-- 执行后验证：DESCRIBE structure_sync_status; 应看到 fast_dirty / fast_dirty_marked_at / fast_dirty_cleared_at
-- ============================================

ALTER TABLE structure_sync_status
  ADD COLUMN fast_dirty TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Track2 写库后是否存在待刷新结构（0/1）' AFTER last_fast_filter_since_sec,
  ADD COLUMN fast_dirty_marked_at TIMESTAMP NULL DEFAULT NULL COMMENT 'Track2 标记 dirty 的时间' AFTER fast_dirty,
  ADD COLUMN fast_dirty_cleared_at TIMESTAMP NULL DEFAULT NULL COMMENT '规则前刷新成功后清 dirty 的时间' AFTER fast_dirty_marked_at;

-- ============================================
