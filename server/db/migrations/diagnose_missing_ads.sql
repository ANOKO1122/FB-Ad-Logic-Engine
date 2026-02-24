-- ============================================================
-- 诊断缺失广告问题
-- ============================================================

-- 1. 检查缺失广告在 ad_snapshots 中的实际数据情况
-- 查看这些广告是否有任何数据（不管 data_date）
SELECT 
  account_id,
  ad_id,
  data_date,
  DATE(synced_at) as synced_date,
  spend,
  synced_at
FROM ad_snapshots
WHERE account_id = 'act_1311074497415630'
  AND ad_id IN (
    '120239245299640498',
    '120239245299660498',
    '120239245299670498',
    '120239245301380498',
    '120239245301400498'
  )
ORDER BY synced_at DESC
LIMIT 20;

-- 2. 检查这些广告的 data_date 分布
-- 看看这些广告的数据是否在其他日期
SELECT 
  account_id,
  ad_id,
  data_date,
  COUNT(*) as record_count,
  MAX(synced_at) as last_synced,
  SUM(spend) as total_spend
FROM ad_snapshots
WHERE account_id = 'act_1311074497415630'
  AND ad_id IN (
    '120239245299640498',
    '120239245299660498',
    '120239245299670498'
  )
GROUP BY account_id, ad_id, data_date
ORDER BY data_date DESC, ad_id;

-- 3. 检查昨天（2026-01-26）该账户的所有广告数据
-- 看看昨天实际归档了多少广告
SELECT 
  COUNT(DISTINCT ad_id) as ad_count,
  SUM(spend) as total_spend
FROM ad_snapshots
WHERE account_id = 'act_1311074497415630'
  AND data_date = '2026-01-26';

-- 4. 检查 daily_stats 中昨天归档的数据
-- 看看实际归档了多少广告
SELECT 
  COUNT(DISTINCT ad_id) as ad_count,
  SUM(spend) as total_spend
FROM daily_stats
WHERE account_id = 'act_1311074497415630'
  AND date = '2026-01-26';

-- 5. 检查这些缺失广告是否在今天（2026-01-27）有数据
-- 看看是否是因为 data_date 计算错误
SELECT 
  account_id,
  ad_id,
  data_date,
  spend,
  synced_at
FROM ad_snapshots
WHERE account_id = 'act_1311074497415630'
  AND ad_id IN (
    '120239245299640498',
    '120239245299660498',
    '120239245299670498'
  )
  AND data_date >= '2026-01-26'
ORDER BY synced_at DESC;

-- 6. 检查归档执行时间点前后，这些广告的数据同步情况
-- 看看归档时（12:15）这些广告是否有数据
SELECT 
  account_id,
  ad_id,
  data_date,
  spend,
  synced_at,
  CASE 
    WHEN synced_at < '2026-01-27 12:15:00' THEN '归档前'
    WHEN synced_at >= '2026-01-27 12:15:00' AND synced_at < '2026-01-27 12:20:00' THEN '归档窗口'
    ELSE '归档后'
  END as sync_timing
FROM ad_snapshots
WHERE account_id = 'act_1311074497415630'
  AND ad_id IN (
    '120239245299640498',
    '120239245299660498',
    '120239245299670498'
  )
ORDER BY synced_at DESC;

