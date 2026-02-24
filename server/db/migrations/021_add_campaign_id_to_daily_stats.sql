-- 迁移：021_add_campaign_id_to_daily_stats.sql
-- 目的：为 daily_stats 增加 campaign_id，支持昨日/多日时间窗口下 CBO 规则执行（增减预算需 campaign_id）
-- 依赖：020_add_campaign_id_to_ad_snapshots.sql 已执行（归档与回填从 ad_snapshots 取 campaign_id）
-- 执行后：需执行 022 回填历史数据（或由你本地执行回填 SQL）

ALTER TABLE `daily_stats`
ADD COLUMN `campaign_id` VARCHAR(50) DEFAULT NULL COMMENT '广告系列ID（CBO 执行增减预算时使用）';
