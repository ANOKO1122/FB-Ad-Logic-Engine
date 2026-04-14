-- 迁移：半成品规则铺底 — account_id 可空、模板幂等键、负责人冗余列
-- 依据：.cursor/plans/模板半成品规则自动铺底_992a9978.plan.md 阶段 0
-- 语义：
--   account_id NULL = 未配置广告账户（半成品）；enabled=true 须由 API「开闸校验」拦截
--   owner_id = 负责人维度冗余，与 users.owner_id 对齐，便于列表过滤与 UNIQUE(owner, template)
--   source_template_slug = 来源模板 slug，与 owner_id 组成铺底幂等键

-- 1) account_id 允许 NULL（撤销 011 NOT NULL 约束）
ALTER TABLE `rules`
  MODIFY COLUMN `account_id` VARCHAR(50) NULL
  COMMENT '广告账户ID；NULL 表示未绑定（半成品），启用前须校验';

-- 2) 负责人冗余（可空：历史规则未回填时可为 NULL）
ALTER TABLE `rules`
  ADD COLUMN `owner_id` INT NULL
  COMMENT '负责人ID，与 users.owner_id 一致；模板铺底幂等与列表按负责人维度'
  AFTER `user_id`;

-- 3) 模板来源 slug（可空：非铺底规则为 NULL）
ALTER TABLE `rules`
  ADD COLUMN `source_template_slug` VARCHAR(64) NULL
  COMMENT '来源 rule_templates.slug；与 owner_id 唯一约束用于铺底幂等'
  AFTER `rule_name`;

-- 4) 索引：负责人查询 + 铺底幂等（同一负责人同一模板仅一条半成品）
ALTER TABLE `rules`
  ADD INDEX `idx_rules_owner_id` (`owner_id`);

ALTER TABLE `rules`
  ADD UNIQUE KEY `uq_rules_owner_source_template` (`owner_id`, `source_template_slug`);
