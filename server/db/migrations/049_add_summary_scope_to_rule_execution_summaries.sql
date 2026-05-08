-- Migration: 049_add_summary_scope_to_rule_execution_summaries.sql
-- 新增 summary_scope 字段，区分"账户级执行事实"与"汇总级执行事实"
-- 消除单账户双写歧义与统计翻倍问题
-- 
-- summary_scope 枚举：
--   'account' : 每个账户一条明细摘要（per-account execution summary）
--   'rollup'  : 手动执行后生成的汇总摘要（aggregated across accounts）
--   NULL      : 兼容历史数据

ALTER TABLE rule_execution_summaries
  ADD COLUMN summary_scope VARCHAR(20) DEFAULT NULL COMMENT '摘要层级：account=账户级明细，rollup=汇总级，NULL=历史数据（兼容）'
  AFTER status;

-- 索引：按 summary_scope 查询
ALTER TABLE rule_execution_summaries
  ADD INDEX idx_summary_scope (summary_scope);

-- 历史数据回填策略：
-- account_id='multi' 的老数据可直接回填为 'rollup'
-- 旧的单账户重复汇总行无法百分百无损区分，采用"新数据完全正确、旧数据保守兼容"策略
-- 如需清理历史，可追加一次性修复脚本：
--   UPDATE rule_execution_summaries SET summary_scope = 'rollup' WHERE account_id = 'multi';
--   推荐：后续所有新数据写入必须携带 summary_scope，旧数据保持 NULL 兼容
