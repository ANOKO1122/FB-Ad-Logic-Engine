-- ============================================
-- 迁移脚本：030_add_last_filter_since_sec_to_structure_sync_status.sql
-- 目的：结构同步「近 3 天」过滤窗口可观测——记录上次使用的 since（Unix 秒），便于核对过滤窗口与同步结果。
-- 执行后验证：DESCRIBE structure_sync_status; 应看到 last_filter_since_sec 列。
-- ============================================

ALTER TABLE structure_sync_status
  ADD COLUMN last_filter_since_sec BIGINT NULL COMMENT '上次结构同步使用的 updated_time 过滤起点（Unix 秒，近3天窗口）' AFTER last_full_success_at;

-- ============================================
