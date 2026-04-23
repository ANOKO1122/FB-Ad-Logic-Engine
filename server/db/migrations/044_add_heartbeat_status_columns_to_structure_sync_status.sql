-- ============================================
-- 迁移脚本：044_add_heartbeat_status_columns_to_structure_sync_status.sql
-- 目的：为统一心跳/业务快照同步补充独立状态字段，避免与结构同步 last_success_at 语义混用
-- 执行后验证：DESCRIBE structure_sync_status; 应看到 last_heartbeat_* 系列字段
-- ============================================

ALTER TABLE structure_sync_status
  ADD COLUMN last_heartbeat_attempt_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次尝试统一心跳/业务快照同步的时间' AFTER fast_dirty_cleared_at,
  ADD COLUMN last_heartbeat_success_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次统一心跳/业务快照同步成功完成的时间' AFTER last_heartbeat_attempt_at,
  ADD COLUMN last_heartbeat_data_update_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次实际写入 ad_snapshots/daily_stats 的时间' AFTER last_heartbeat_success_at,
  ADD COLUMN last_heartbeat_result_code VARCHAR(64) NULL DEFAULT NULL COMMENT '最近一次统一心跳结果码：SUCCESS_WITH_DATA/SUCCESS_NO_DATA/FAILED/SKIPPED_INVALID_ACCOUNT' AFTER last_heartbeat_data_update_at,
  ADD COLUMN last_heartbeat_error_message VARCHAR(500) NULL DEFAULT NULL COMMENT '最近一次统一心跳错误摘要' AFTER last_heartbeat_result_code,
  ADD COLUMN last_heartbeat_duration_ms INT NULL DEFAULT NULL COMMENT '最近一次统一心跳账户级处理耗时（毫秒）' AFTER last_heartbeat_error_message;

-- ============================================
