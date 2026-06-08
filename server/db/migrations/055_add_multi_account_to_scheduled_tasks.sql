-- 055_add_multi_account_to_scheduled_tasks.sql
-- 定时任务多账户支持：复用规则管理的 target_account_ids + target_by_account 模式
-- 日期：2026-06-04

-- 1. 多选账户ID列表（JSON数组）
ALTER TABLE scheduled_tasks
  ADD COLUMN target_account_ids JSON NULL AFTER account_id;

-- 2. 按账户分组的目标ID（方案B）
ALTER TABLE scheduled_tasks
  ADD COLUMN target_by_account JSON NULL AFTER target_account_ids;
