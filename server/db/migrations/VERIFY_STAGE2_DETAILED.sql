-- ============================================
-- 详细验证 SQL（阶段二）
-- 用于深入检查统一心跳和归档逻辑
-- ============================================

-- 1. 检查所有账户及其时区配置
SELECT 
  fb_account_id AS 'account_id',
  owner_id,
  timezone_name,
  is_active,
  updated_at
FROM account_mappings
WHERE is_active = 1
ORDER BY fb_account_id;

-- 2. 检查 ad_snapshots 中每个账户的数据分布
SELECT 
  account_id,
  timezone_name,
  MIN(data_date) AS '最早数据日期',
  MAX(data_date) AS '最新数据日期',
  COUNT(*) AS '记录数',
  COUNT(DISTINCT ad_id) AS '广告数',
  MAX(synced_at) AS '最后同步时间'
FROM ad_snapshots
GROUP BY account_id, timezone_name
ORDER BY account_id;

-- 3. 检查 daily_stats 中的数据分布
SELECT 
  account_id,
  timezone_name,
  MIN(date) AS '最早日期',
  MAX(date) AS '最新日期',
  COUNT(*) AS '记录数',
  COUNT(DISTINCT ad_id) AS '广告数'
FROM daily_stats
GROUP BY account_id, timezone_name
ORDER BY account_id;

-- 4. 检查归档状态表的完整情况
SELECT 
  account_id,
  target_date,
  status,
  updated_at,
  last_error,
  DATEDIFF(CURDATE(), target_date) AS '距离今天的天数'
FROM daily_archive_status
ORDER BY account_id, target_date DESC;

-- 5. 检查哪些账户的昨天数据还未归档
SELECT 
  a.account_id,
  a.timezone_name,
  COUNT(DISTINCT a.ad_id) AS '昨日快照数',
  COALESCE(s.status, 'NOT_STARTED') AS '归档状态',
  COALESCE(COUNT(DISTINCT d.ad_id), 0) AS '已归档数'
FROM (
  SELECT DISTINCT account_id, timezone_name
  FROM ad_snapshots
  WHERE data_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
) a
LEFT JOIN daily_archive_status s 
  ON a.account_id = s.account_id 
  AND s.target_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
LEFT JOIN daily_stats d 
  ON a.account_id = d.account_id 
  AND d.date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
LEFT JOIN ad_snapshots snap
  ON a.account_id = snap.account_id
  AND snap.data_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
GROUP BY a.account_id, a.timezone_name, s.status
ORDER BY a.account_id;

-- 6. 检查 data_date 与时区的一致性（验证时区转换是否正确）
SELECT 
  account_id,
  ad_id,
  data_date,
  synced_at,
  timezone_name,
  -- 计算 UTC 时间对应的账户时区日期
  DATE(CONVERT_TZ(synced_at, '+00:00', 
    CASE 
      WHEN timezone_name = 'Asia/Shanghai' THEN '+08:00'
      WHEN timezone_name = 'UTC' THEN '+00:00'
      ELSE '+00:00'  -- 默认 UTC
    END
  )) AS '计算出的data_date',
  CASE 
    WHEN data_date = DATE(CONVERT_TZ(synced_at, '+00:00', 
      CASE 
        WHEN timezone_name = 'Asia/Shanghai' THEN '+08:00'
        WHEN timezone_name = 'UTC' THEN '+00:00'
        ELSE '+00:00'
      END
    )) THEN '一致'
    ELSE '不一致'
  END AS '一致性检查'
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY synced_at DESC
LIMIT 20;

-- 7. 检查统一心跳是否在运行（通过检查最近的数据同步时间）
SELECT 
  account_id,
  MAX(synced_at) AS '最后同步时间',
  TIMESTAMPDIFF(MINUTE, MAX(synced_at), NOW()) AS '距离现在（分钟）',
  CASE 
    WHEN TIMESTAMPDIFF(MINUTE, MAX(synced_at), NOW()) <= 20 THEN '正常（15分钟内）'
    WHEN TIMESTAMPDIFF(MINUTE, MAX(synced_at), NOW()) <= 60 THEN '可能延迟'
    ELSE '异常（超过1小时）'
  END AS '状态'
FROM ad_snapshots
GROUP BY account_id
ORDER BY account_id;

-- 8. 检查归档完整性（昨天应该有数据但未归档的情况）
SELECT 
  snap.account_id,
  COUNT(DISTINCT snap.ad_id) AS '快照中的广告数',
  COUNT(DISTINCT stats.ad_id) AS '已归档的广告数',
  COUNT(DISTINCT snap.ad_id) - COUNT(DISTINCT stats.ad_id) AS '缺失数',
  COALESCE(arch_status.status, 'NOT_STARTED') AS '归档状态'
FROM ad_snapshots snap
LEFT JOIN daily_stats stats 
  ON snap.account_id = stats.account_id 
  AND snap.data_date = stats.date
LEFT JOIN daily_archive_status arch_status
  ON snap.account_id = arch_status.account_id
  AND snap.data_date = arch_status.target_date
WHERE snap.data_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
GROUP BY snap.account_id, arch_status.status
HAVING COUNT(DISTINCT snap.ad_id) > 0
ORDER BY snap.account_id;

