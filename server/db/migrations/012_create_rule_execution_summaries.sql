-- Migration: 012_create_rule_execution_summaries.sql
-- 创建规则执行摘要表（阶段2：系统层可观测性）
-- 用途：记录每次规则评估的摘要，用于解释"为什么规则今天没动静"、排障、自证系统行为

CREATE TABLE IF NOT EXISTS rule_execution_summaries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(100) NOT NULL,                    -- 运行批次ID（同一轮 cron/手动触发/事件触发共享）
  rule_id INT NOT NULL,                            -- 规则ID
  rule_name VARCHAR(255),                          -- 规则名称（冗余，便于查询）
  account_id VARCHAR(50) NOT NULL,                 -- 广告账户ID
  user_id INT NOT NULL,                            -- 规则所属用户ID（rules.userId）
  owner_id INT DEFAULT 0,                          -- 用户所属 owner_id（users.owner_id）
  matched_count INT DEFAULT 0,                     -- 匹配的广告数量
  executed_count INT DEFAULT 0,                    -- 成功执行的广告数量
  failed_count INT DEFAULT 0,                      -- 执行失败的广告数量
  skipped_count INT DEFAULT 0,                      -- 跳过的广告数量
  status VARCHAR(20),                              -- 执行状态：matched/no_match/skipped/error
  skip_reason VARCHAR(50),                        -- 跳过原因枚举：cooldown/no_permission/account_mismatch/user_not_found/no_match/error
  skip_details JSON,                               -- 跳过详情（JSON对象，不要 stringify）：如 { "rule_account_id": "act_xxx", "locked_account_id": "act_yyy" }
  error_message VARCHAR(500),                     -- 错误信息（截断+脱敏，不超过500字符）
  duration_ms INT,                                 -- 执行耗时（毫秒）
  evaluated_at TIMESTAMP NOT NULL,                 -- 评估时间
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- 索引按查询模式设计（联合索引，覆盖常见查询场景）
  INDEX idx_run_id (run_id),                      -- 按运行批次查询
  INDEX idx_account_evaluated (account_id, evaluated_at DESC),      -- 按账户 + 时间倒序
  INDEX idx_rule_evaluated (rule_id, evaluated_at DESC),            -- 按规则 + 时间倒序
  INDEX idx_owner_evaluated (owner_id, evaluated_at DESC),          -- 按所有者 + 时间倒序
  INDEX idx_user_evaluated (user_id, evaluated_at DESC),            -- 按用户 + 时间倒序
  INDEX idx_status_evaluated (status, evaluated_at DESC),            -- 按状态 + 时间倒序
  INDEX idx_skip_reason_evaluated (skip_reason, evaluated_at DESC)  -- 按跳过原因 + 时间倒序
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则执行摘要表（系统层可观测性）';

-- 保留策略说明：
-- 建议定期清理（例如保留90天），可以通过定时任务或手动执行：
-- DELETE FROM rule_execution_summaries WHERE evaluated_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
-- 或者按月分区（先不做也行，但要有预案）
