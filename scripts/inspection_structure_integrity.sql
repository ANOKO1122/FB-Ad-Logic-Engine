-- ============================================================
-- 同层闭环结构完整性巡检 SQL
-- 用途：运维与发布前检查，确保结构表关系链闭合
-- ============================================================

-- 1. 检查 structure_ads 中存在但 structure_campaigns 缺失的 campaign_id
SELECT 'missing_campaigns' AS check_type,
       sa.account_id,
       sa.campaign_id,
       COUNT(DISTINCT sa.ad_id) AS orphan_ad_count
FROM structure_ads sa
LEFT JOIN structure_campaigns sc
  ON sa.account_id = sc.account_id AND sa.campaign_id = sc.campaign_id
WHERE sc.campaign_id IS NULL
  AND sa.campaign_id IS NOT NULL
  AND sa.campaign_id != ''
GROUP BY sa.account_id, sa.campaign_id
ORDER BY orphan_ad_count DESC
LIMIT 100;

-- 2. 检查 structure_ads 中存在但 structure_adsets 缺失的 adset_id
SELECT 'missing_adsets' AS check_type,
       sa.account_id,
       sa.adset_id,
       COUNT(DISTINCT sa.ad_id) AS orphan_ad_count
FROM structure_ads sa
LEFT JOIN structure_adsets sas
  ON sa.account_id = sas.account_id AND sa.adset_id = sas.adset_id
WHERE sas.adset_id IS NULL
  AND sa.adset_id IS NOT NULL
  AND sa.adset_id != ''
GROUP BY sa.account_id, sa.adset_id
ORDER BY orphan_ad_count DESC
LIMIT 100;

-- 3. 最近 no_match 的规则分布（按规则）
SELECT res.rule_id,
       res.rule_name,
       COUNT(*) AS no_match_count,
       MAX(res.evaluated_at) AS last_no_match_at
FROM rule_execution_summaries res
WHERE res.status = 'no_match'
  AND res.summary_scope = 'account'
  AND res.evaluated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY res.rule_id, res.rule_name
ORDER BY no_match_count DESC
LIMIT 20;

-- 4. summary_scope 统计占比
SELECT summary_scope,
       COUNT(*) AS total,
       SUM(matched_count) AS total_matched,
       SUM(executed_count) AS total_executed
FROM rule_execution_summaries
WHERE evaluated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY summary_scope
ORDER BY total DESC;

-- 5. 整体结构表行数概览
SELECT 'structure_ads' AS table_name, COUNT(*) AS row_count FROM structure_ads
UNION ALL
SELECT 'structure_campaigns', COUNT(*) FROM structure_campaigns
UNION ALL
SELECT 'structure_adsets', COUNT(*) FROM structure_adsets;
