-- ============================================
-- 迁移脚本：025_backfill_campaign_adset_from_structure.sql
-- 目的：历史回填 ad_snapshots / daily_stats 中 campaign_id 或 ad_set_id 为空的行
-- 来源：structure_ads（结构镜像表为关系真相源）
-- 范围：仅最近 7 天，避免全表 UPDATE；建议先单账号验收再全量
-- 执行时机：写入时兜底（ingestorService）已上线后，执行本脚本修复历史数据
-- ============================================
-- 执行前请备份。
-- 可选：先查待回填行数（含 NULL 与空字符串）
--   SELECT COUNT(*) FROM ad_snapshots s WHERE (s.campaign_id IS NULL OR s.campaign_id = '' OR s.ad_set_id IS NULL OR s.ad_set_id = '') AND s.data_date >= CURDATE() - INTERVAL 7 DAY;
--   SELECT COUNT(*) FROM daily_stats d  WHERE (d.campaign_id IS NULL OR d.campaign_id = '' OR d.ad_set_id IS NULL OR d.ad_set_id = '') AND d.date >= CURDATE() - INTERVAL 7 DAY;
-- 单账号验收：在下面两段 UPDATE 的 WHERE 中增加 AND s.account_id = 'act_xxx' / AND d.account_id = 'act_xxx'，验证无误后再去掉该条件全量执行。
-- ============================================
-- 说明：SET 使用 COALESCE(NULLIF(TRIM(...),''), a.xxx)，使 NULL 与空字符串均被结构表值覆盖

-- 1. ad_snapshots：仅回填 campaign_id 或 ad_set_id 为空（含空串）且最近 7 天的行
UPDATE ad_snapshots s
JOIN structure_ads a
  ON s.account_id = a.account_id AND s.ad_id = a.ad_id
SET s.campaign_id = COALESCE(NULLIF(TRIM(s.campaign_id), ''), a.campaign_id),
    s.ad_set_id  = COALESCE(NULLIF(TRIM(s.ad_set_id), ''),  a.adset_id)
WHERE s.data_date >= CURDATE() - INTERVAL 7 DAY
  AND (s.campaign_id IS NULL OR s.campaign_id = '' OR s.ad_set_id IS NULL OR s.ad_set_id = '');

-- 2. daily_stats：仅回填 campaign_id 或 ad_set_id 为空（含空串）且最近 7 天的行
UPDATE daily_stats d
JOIN structure_ads a
  ON d.account_id = a.account_id AND d.ad_id = a.ad_id
SET d.campaign_id = COALESCE(NULLIF(TRIM(d.campaign_id), ''), a.campaign_id),
    d.ad_set_id   = COALESCE(NULLIF(TRIM(d.ad_set_id), ''),  a.adset_id)
WHERE d.date >= CURDATE() - INTERVAL 7 DAY
  AND (d.campaign_id IS NULL OR d.campaign_id = '' OR d.ad_set_id IS NULL OR d.ad_set_id = '');

-- ============================================
-- 执行后验证（可选）
-- ============================================
-- SELECT COUNT(*) AS ad_snapshots_null FROM ad_snapshots WHERE (COALESCE(TRIM(campaign_id),'') = '' OR COALESCE(TRIM(ad_set_id),'') = '') AND data_date >= CURDATE() - INTERVAL 7 DAY;
-- SELECT COUNT(*) AS daily_stats_null  FROM daily_stats  WHERE (COALESCE(TRIM(campaign_id),'') = '' OR COALESCE(TRIM(ad_set_id),'') = '') AND date >= CURDATE() - INTERVAL 7 DAY;
