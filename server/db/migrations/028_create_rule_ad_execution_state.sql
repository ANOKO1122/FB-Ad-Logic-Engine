-- ============================================
-- 迁移 028: 创建规则×广告冷却状态表 rule_ad_execution_state
-- 依据: docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md §2.2
-- ============================================
-- 语义：每条 (rule_id, ad_id) 记录该规则在该广告上的最近一次触发时间与状态
-- 仅由「每分钟 Cron 调度」读写；单条规则手动执行不读不写此表
-- ============================================

CREATE TABLE IF NOT EXISTS `rule_ad_execution_state` (
  `rule_id` INT NOT NULL,
  `ad_id` VARCHAR(50) NOT NULL,
  `last_executed_at` TIMESTAMP NOT NULL COMMENT '最近一次触发时间（UTC）',
  `last_status` ENUM('success','fail','suppressed','outside_window') NULL COMMENT '用于诊断',
  PRIMARY KEY (`rule_id`, `ad_id`),
  INDEX `idx_rule` (`rule_id`),
  INDEX `idx_ad` (`ad_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='规则×广告执行冷却状态（调度路径读写，单条执行不参与）';

-- ============================================
-- 验证
-- ============================================
-- SHOW CREATE TABLE rule_ad_execution_state;
