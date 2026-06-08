-- Migration 054: 添加 task_name 字段到 scheduled_tasks
ALTER TABLE scheduled_tasks ADD COLUMN task_name VARCHAR(255) DEFAULT NULL COMMENT '任务名称（用户自定义）' AFTER action_params;
