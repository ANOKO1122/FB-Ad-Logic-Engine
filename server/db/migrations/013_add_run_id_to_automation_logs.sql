-- M4：为 automation_logs 增加 run_id 列（验收：同一 run_id + ad_id 最多 1 条记录）
-- 执行前请备份；若已存在 run_id 列则跳过（幂等）

-- MySQL 5.7+ 可用存储过程做「存在则跳过」；简单做法：直接 ADD COLUMN，若已存在会报错，可忽略
ALTER TABLE automation_logs ADD COLUMN run_id VARCHAR(100) NULL DEFAULT NULL COMMENT 'M4 运行批次，与 rule_execution_summaries.run_id 一致' AFTER id;

-- 可选：为按 run_id 查询加索引（排障时常用）
-- CREATE INDEX idx_automation_logs_run_id ON automation_logs (run_id);
