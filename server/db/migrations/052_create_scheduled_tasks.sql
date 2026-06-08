-- 052_create_scheduled_tasks.sql
-- 定时任务功能（独立 scheduled_tasks 表）
-- 版本：v1.6
-- 日期：2026-05-30

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  -- 用户归属
  user_id         INT NOT NULL,
  owner_id        INT NOT NULL DEFAULT 0,

  -- 调度配置
  schedule_type   VARCHAR(16) NOT NULL,       -- once / daily / weekly / cron
  schedule_at     VARCHAR(32) NULL,             -- 格式：once=YYYY-MM-DD HH:mm，daily=HH:mm，weekly=W1,W2|HH:mm；cron 可为 NULL
  schedule_cron   VARCHAR(64) NULL,            -- cron 表达式（仅 cron 类型）
  schedule_timezone VARCHAR(50) NULL,          -- 时区，NULL=跟随账户时区
  next_execute_at DATETIME NULL,               -- 下次执行时间（UTC），由系统计算维护

  -- 目标对象
  account_id      VARCHAR(50) NOT NULL,        -- 广告账户 ID（act_xxx）
  target_level    VARCHAR(16) NOT NULL DEFAULT 'ad',  -- ad / adset / campaign
  target_id       VARCHAR(50) NOT NULL,        -- 目标对象 ID

  -- 动作配置
  action_type     VARCHAR(32) NOT NULL,        -- pause_ad / activate_ad / pause_adset / activate_adset / pause_campaign / activate_campaign / set_budget / increase_budget / decrease_budget
  action_params   JSON NOT NULL,               -- 动作参数

  -- 状态控制
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  is_simulation   TINYINT(1) NOT NULL DEFAULT 0,  -- Dry Run 模式
  auto_disable    TINYINT(1) NOT NULL DEFAULT 1,  -- once 类型执行后自动 enabled=false

  -- 执行追踪
  last_executed_at DATETIME NULL,
  last_status     VARCHAR(16) NULL,            -- success / fail / skipped

  -- 重试控制
  retry_count     INT NOT NULL DEFAULT 0,      -- 累计重试次数
  max_retries     INT NOT NULL DEFAULT 3,      -- 最大重试次数，超出后自动禁用

  -- 并发控制（乐观锁版本号）
  version         INT NOT NULL DEFAULT 0,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_next_execute (enabled, next_execute_at),
  INDEX idx_account (account_id),
  INDEX idx_user (user_id),
  INDEX idx_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
