-- ============================================
-- 迁移脚本：032_add_fast_sync_columns_to_structure_sync_status.sql
-- 目的：为 Track2 Fast Sync 增加专用水位字段，避免与 last_success_at 语义混用
-- 执行后验证：DESCRIBE structure_sync_status; 应看到 last_fast_sync_ts / last_fast_filter_since_sec
-- ============================================

ALTER TABLE structure_sync_status
  ADD COLUMN last_fast_sync_ts TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次 Track2 Fast Sync 成功时间' AFTER last_filter_since_sec,
  ADD COLUMN last_fast_filter_since_sec BIGINT NULL COMMENT '最近一次 Track2 Fast Sync 使用的过滤起点（Unix 秒）' AFTER last_fast_sync_ts;

-- ============================================
