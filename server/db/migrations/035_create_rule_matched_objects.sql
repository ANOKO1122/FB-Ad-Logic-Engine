-- ============================================
-- 迁移脚本：035_create_rule_matched_objects.sql
-- 目的：创建动态筛选快照表 rule_matched_objects
-- 依据：.cursor/plans/动态筛选执行方案（最终版_v3）_4a4a8936.plan.md §2.2
--
-- 表用途：
--   - 存储「规则 × 账户」在广告级别的目标快照。
--   - DynamicScopeService 在账户锁 + DB 事务内按账户原子替换整表：
--       1) 读取账户下所有 use_dynamic_scope=1 的规则并在事务外计算 finalAdIds；
--       2) DELETE FROM rule_matched_objects WHERE account_id = ?;
--       3) 分块 INSERT (rule_id, account_id, object_id, object_type, created_at)；
--       4) 批量更新 rules.dynamic_scope_status/*error_msg/*updated_at。
--   - 执行层（RuleEngineDispatcher）按 rule_id + account_id 从本表读取 object_id 作为 ad_id 列表。
--
-- 字段：
--   - id           BIGINT 自增主键（诊断用）
--   - rule_id      INT     规则 ID（FK: rules.id）
--   - account_id   VARCHAR 账户 ID
--   - object_id    VARCHAR 对象 ID（V1=ad_id）
--   - object_type  VARCHAR 对象类型（V1 固定 'ad'，便于未来扩展 adset/campaign）
--   - created_at   TIMESTAMP 创建时间
--
-- 索引：
--   - UNIQUE (rule_id, account_id, object_id)         保证同一规则/账户下同一个对象只出现一次
--   - INDEX  idx_account_rule (account_id, rule_id)   支持 Dispatcher 按账户/规则读取
--   - INDEX  idx_rule (rule_id)                       便于按规则维度排查
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/035_create_rule_matched_objects.sql
--
-- 验证：
--   SHOW TABLES LIKE 'rule_matched_objects';
--   DESCRIBE rule_matched_objects;
--   SHOW INDEX FROM rule_matched_objects;
-- ============================================

CREATE TABLE IF NOT EXISTS rule_matched_objects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  rule_id INT NOT NULL COMMENT '规则 ID（rules.id）',
  account_id VARCHAR(50) NOT NULL COMMENT '广告账户 ID',
  object_id VARCHAR(50) NOT NULL COMMENT '对象 ID（V1=ad_id）',
  object_type VARCHAR(16) NOT NULL COMMENT '对象类型（V1 固定 ad，预留扩展）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '快照生成时间',

  UNIQUE KEY uk_rule_account_object (rule_id, account_id, object_id),
  KEY idx_account_rule (account_id, rule_id),
  KEY idx_rule (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='动态筛选快照表：规则×账户→广告级目标集合';

-- 回滚（仅在需要时手动执行，慎用）：
-- DROP TABLE IF EXISTS rule_matched_objects;

