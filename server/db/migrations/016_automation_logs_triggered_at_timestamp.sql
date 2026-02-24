-- P1：统一 automation_logs.triggered_at 与 rule_execution_summaries.evaluated_at 时间口径
-- 将 triggered_at 从 DATETIME 迁到 TIMESTAMP；必须先 SET time_zone 再 ALTER，否则按 session 时区转换会整体偏移 8h
-- 执行前请备份；若列已是 TIMESTAMP 则 MODIFY 可重复执行（幂等）
--
-- 验收 SQL（同一 run_id 两表时间应接近）：
--   SELECT s.run_id, s.evaluated_at, a.triggered_at
--   FROM rule_execution_summaries s
--   JOIN automation_logs a ON a.run_id = s.run_id
--   ORDER BY s.evaluated_at DESC LIMIT 5;

SET time_zone = '+00:00';
ALTER TABLE automation_logs MODIFY COLUMN triggered_at TIMESTAMP NOT NULL COMMENT '触发时间（UTC，与 evaluated_at 一致）';
