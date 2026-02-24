-- ============================================
-- 迁移：020_add_campaign_id_to_ad_snapshots.sql
-- 目的：为 ad_snapshots 增加 campaign_id，支持规则按「广告系列」筛选目标广告
-- 依据：docs/规则管理_广告系列与未同步回显_问题与方案.md
-- ============================================

-- 仅加列，默认 NULL；历史数据保持 NULL，新同步写入 campaign_id
ALTER TABLE `ad_snapshots`
ADD COLUMN `campaign_id` VARCHAR(50) DEFAULT NULL COMMENT '广告系列ID（用于规则目标层级 campaign）';
