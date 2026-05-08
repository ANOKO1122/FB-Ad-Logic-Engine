-- M5: 审计日志通用对象模型
-- 为 automation_logs 新增通用对象字段，支持 ad/adset/campaign 三层对象记录
--
-- object_type: 目标对象类型 (ad | adset | campaign)
-- object_id: 目标对象 ID
-- object_name: 目标对象名称
-- preflight_mode: Pre-Flight 模式 (preflight | direct_api_fallback)
--
-- 兼容策略：新字段写真实目标对象，旧 ad_id/ad_name 保留兼容写入
-- 读路径优先读新字段，为空时回退旧字段

ALTER TABLE automation_logs
    ADD COLUMN object_type VARCHAR(16) DEFAULT NULL COMMENT '目标对象类型：ad|adset|campaign',
    ADD COLUMN object_id VARCHAR(50) DEFAULT NULL COMMENT '目标对象 ID',
    ADD COLUMN object_name VARCHAR(500) DEFAULT NULL COMMENT '目标对象名称',
    ADD COLUMN preflight_mode VARCHAR(32) DEFAULT NULL COMMENT 'Pre-Flight 模式：preflight|direct_api_fallback';
