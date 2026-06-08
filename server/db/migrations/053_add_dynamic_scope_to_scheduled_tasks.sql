-- 053_add_dynamic_scope_to_scheduled_tasks.sql
-- 定时任务多对象支持：复用规则管理的动态筛选 + 多选 + 排除名单模式
-- 日期：2026-06-01

-- 1. target_id 改为可选（兼容旧数据，新逻辑用 target_ids）
ALTER TABLE scheduled_tasks
  MODIFY COLUMN target_id VARCHAR(50) NULL;

-- 2. 多目标对象（JSON 数组，替代单 target_id）
ALTER TABLE scheduled_tasks
  ADD COLUMN target_ids JSON NULL AFTER target_id;

-- 3. 动态筛选开关
ALTER TABLE scheduled_tasks
  ADD COLUMN use_dynamic_scope TINYINT(1) NOT NULL DEFAULT 0 AFTER target_ids;

-- 4. 监控范围条件（复用规则管理的 scope_filters 格式）
ALTER TABLE scheduled_tasks
  ADD COLUMN scope_filters JSON NULL AFTER use_dynamic_scope;

-- 5. 排除名单（复用规则管理的 exclude_ids 格式）
ALTER TABLE scheduled_tasks
  ADD COLUMN exclude_ids JSON NULL AFTER scope_filters;

-- 6. 动态匹配上限
ALTER TABLE scheduled_tasks
  ADD COLUMN max_dynamic_matches INT NOT NULL DEFAULT 1000 AFTER exclude_ids;
