-- 验证 today 查询正确性
-- 检查 ad_snapshots 中是否有 last_7d 聚合数据混入

SELECT 
  account_id,
  ad_id,
  synced_at,
  spend,
  purchases,
  timezone_name,
  DATE(synced_at) as sync_date
FROM ad_snapshots
WHERE account_id = 'act_927139705822379'
  AND DATE(synced_at) = CURDATE()
ORDER BY synced_at DESC
LIMIT 20;

-- 预期结果：
-- 1. 所有记录的 spend 应该是"今天"的真实值
-- 2. 不应该包含"过去7天合计"的聚合值
-- 3. 如果某广告今天没有花费，spend 应该为 0 或 NULL

