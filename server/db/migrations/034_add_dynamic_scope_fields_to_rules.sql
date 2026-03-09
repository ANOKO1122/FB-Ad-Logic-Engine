-- ============================================
-- 迁移脚本：034_add_dynamic_scope_fields_to_rules.sql
-- 目的：为 rules 表增加动态筛选（Dynamic Scope）相关字段
-- 依据：.cursor/plans/动态筛选执行方案（最终版_v3）_4a4a8936.plan.md §2.1
--
-- 字段说明：
--   - use_dynamic_scope TINYINT(1) NOT NULL DEFAULT 0
--       是否启用动态筛选。1=从 rule_matched_objects 读取目标对象，0=沿用 target_level/target_ids 逻辑。
--   - scope_filters JSON NULL
--       监控范围条件，前端「监控范围」三个控件序列化结果。
--       示例：{"level":"adset","conditions":[{"field":"effective_status","op":"in","value":["ACTIVE"]},{"field":"created_time","op":"within_hours","value":72}]}
--   - exclude_ids JSON NULL
--       排除名单，支持混合 campaign/adset/ad。
--       示例：{"campaign_ids":["C1"],"adset_ids":["AS1"],"ad_ids":["A1","A2"]}。
--   - max_dynamic_matches INT NOT NULL DEFAULT 1000
--       动态匹配上限。finalAdIds 超过该值时视为 ERROR_OVERSIZE，本轮不写新快照（保留上一版）。
--   - dynamic_scope_status VARCHAR(32) NOT NULL DEFAULT 'NORMAL'
--       动态筛选状态机：NORMAL / ERROR_OVERSIZE / ERROR_FILTER_INVALID / ERROR_REFRESH_FAILED。
--   - dynamic_scope_error_msg VARCHAR(255) NULL
--       最近一次刷新异常的简要说明，供前端展示与排障。
--   - dynamic_scope_updated_at TIMESTAMP NULL
--       最近一次尝试刷新（成功或失败）的时间。
--
-- 【重要】请由你亲自在本地执行本脚本，执行前请备份数据库。
-- 建议执行顺序：032/033（Track2 Fast Sync）→ 034（本脚本）→ 035（rule_matched_objects）→ 036（structure_ads 索引补齐）。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/034_add_dynamic_scope_fields_to_rules.sql
--
-- 验证：
--   DESC rules;
--   SELECT use_dynamic_scope, scope_filters, exclude_ids, max_dynamic_matches,
--          dynamic_scope_status, dynamic_scope_error_msg, dynamic_scope_updated_at
--   FROM rules LIMIT 1;
-- ============================================

ALTER TABLE rules
  ADD COLUMN use_dynamic_scope TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用动态筛选(1=从 rule_matched_objects 读取目标对象)',
  ADD COLUMN scope_filters JSON NULL COMMENT '监控范围条件(JSON)：level + conditions 数组',
  ADD COLUMN exclude_ids JSON NULL COMMENT '排除名单(JSON)：campaign_ids/adset_ids/ad_ids',
  ADD COLUMN max_dynamic_matches INT NOT NULL DEFAULT 1000 COMMENT '动态匹配上限，超限视为 ERROR_OVERSIZE',
  ADD COLUMN dynamic_scope_status VARCHAR(32) NOT NULL DEFAULT 'NORMAL' COMMENT '动态筛选状态：NORMAL/ERROR_OVERSIZE/ERROR_FILTER_INVALID/ERROR_REFRESH_FAILED',
  ADD COLUMN dynamic_scope_error_msg VARCHAR(255) NULL COMMENT '最近一次动态筛选失败原因简要说明',
  ADD COLUMN dynamic_scope_updated_at TIMESTAMP NULL DEFAULT NULL COMMENT '最近一次尝试刷新动态范围的时间';

-- 回滚（仅在需要时手动执行，慎用）：
-- ALTER TABLE rules
--   DROP COLUMN dynamic_scope_updated_at,
--   DROP COLUMN dynamic_scope_error_msg,
--   DROP COLUMN dynamic_scope_status,
--   DROP COLUMN max_dynamic_matches,
--   DROP COLUMN exclude_ids,
--   DROP COLUMN scope_filters,
--   DROP COLUMN use_dynamic_scope;

