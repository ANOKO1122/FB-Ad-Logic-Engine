-- 回填：022_backfill_daily_stats_campaign_id.sql
-- 目的：为已有 daily_stats 行补全 campaign_id（从 ad_snapshots 同广告最新快照取）
-- 执行时机：021 迁移执行完成后，由你本地执行本脚本
-- 说明：同一广告的 campaign_id 长期不变，用 ad_snapshots 任意日期的最新一条即可

UPDATE daily_stats d
SET d.campaign_id = (
  SELECT s.campaign_id
  FROM ad_snapshots s
  WHERE s.account_id = d.account_id
    AND s.ad_id = d.ad_id
    AND s.campaign_id IS NOT NULL
  ORDER BY s.synced_at DESC, s.id DESC
  LIMIT 1
)
WHERE d.campaign_id IS NULL;
