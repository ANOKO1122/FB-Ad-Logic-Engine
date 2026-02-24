-- ============================================
-- 迁移脚本：015_create_structure_sync_status.sql
-- 目的：结构同步状态表（顺序2 结构同步增量化）
-- 用于：按账户记录增量游标、全量计数，支持 5 分钟回看与回退全量判定。
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
-- 执行后验证：SHOW TABLES LIKE 'structure_sync_status'; DESCRIBE structure_sync_status;
-- ============================================

CREATE TABLE IF NOT EXISTS structure_sync_status (
  account_id VARCHAR(50) NOT NULL PRIMARY KEY COMMENT '广告账户 ID',
  last_success_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次同步成功时间',
  last_error VARCHAR(500) DEFAULT NULL COMMENT '最近一次错误信息',
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  last_sync_updated_ts BIGINT DEFAULT NULL COMMENT '内部游标：Unix 秒，用于增量 updated_time 比较',
  last_full_count INT DEFAULT NULL COMMENT '最近一次全量同步后的本地条数',
  has_full_synced TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否曾完成过全量同步：0/1',
  last_full_success_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次全量同步成功时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='结构同步状态（按账户增量游标与回退判定）';

-- ============================================
-- 回滚（仅在需要时由你手动执行，慎用）
-- ============================================
-- DROP TABLE IF EXISTS structure_sync_status;
-- ============================================
