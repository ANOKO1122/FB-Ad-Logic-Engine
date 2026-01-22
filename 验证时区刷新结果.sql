-- 验证时区刷新结果
-- 执行此 SQL 应该返回 0 行（所有时区已一致）

SELECT 
  ds.account_id,
  am.timezone_name as account_timezone,
  ds.timezone_name as daily_stats_timezone,
  COUNT(*) as mismatch_count
FROM daily_stats ds
INNER JOIN account_mappings am ON ds.account_id = am.fb_account_id
WHERE am.is_active = 1
  AND ds.timezone_name != am.timezone_name
GROUP BY ds.account_id, am.timezone_name, ds.timezone_name;

-- 如果返回 0 行，说明刷新成功 ✅
-- 如果返回多行，说明还有账户需要刷新

