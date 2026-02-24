-- ============================================
-- AdsPolar 修复验证 - SQL 查询集合
-- ============================================
-- 使用方法：在 MySQL 客户端中执行以下查询，逐一验证

-- ============================================
-- 步骤1.3：验证没有新的僵尸数据
-- ============================================
-- 检查最近1小时内是否有新的 spend=0 且无交互的数据
SELECT 
  account_id,
  ad_id,
  spend,
  link_clicks,
  purchases,
  data_date,
  synced_at
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
  AND spend = 0
  AND (link_clicks IS NULL OR link_clicks = 0)
  AND (purchases IS NULL OR purchases = 0)
ORDER BY synced_at DESC
LIMIT 20;

-- 预期结果：应该返回 0 行（或只有历史数据，synced_at 是旧的）


-- ============================================
-- 步骤2.1：检查归档查询是否使用 data_date
-- ============================================
-- 查看最近归档的数据，确认 data_date 字段正确
SELECT 
  account_id,
  ad_id,
  data_date,
  DATE(synced_at) as synced_date_utc,
  timezone_name,
  spend
FROM ad_snapshots
WHERE data_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
ORDER BY account_id, ad_id
LIMIT 20;

-- 预期结果：
-- - 应该能看到昨天的数据（data_date = 昨天）
-- - synced_date_utc 可能和 data_date 不同（这是正常的，因为有时区差异）


-- ============================================
-- 步骤4.1：验证 data_date 查询口径
-- ============================================
-- 查询今天的数据（使用 data_date，而不是 synced_at）
SELECT 
  account_id,
  COUNT(DISTINCT ad_id) as ad_count,
  SUM(spend) as total_spend,
  MAX(data_date) as latest_data_date
FROM ad_snapshots
WHERE data_date = CURDATE()
GROUP BY account_id
ORDER BY account_id
LIMIT 20;

-- 预期结果：应该能看到今天的数据，latest_data_date 应该是今天


-- ============================================
-- 步骤4.2：验证没有新的僵尸数据（严格版）
-- ============================================
-- 检查今天是否有 spend=0 且无交互的新数据
SELECT 
  account_id,
  COUNT(*) as zombie_count
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND spend = 0
  AND (link_clicks IS NULL OR link_clicks = 0)
  AND (purchases IS NULL OR purchases = 0)
GROUP BY account_id
HAVING zombie_count > 0;

-- 预期结果：应该返回 0 行


-- ============================================
-- 步骤4.2：验证没有新的僵尸数据（简化版）
-- ============================================
-- 检查今天是否有 spend=0 的数据（更严格的验证）
SELECT 
  account_id,
  COUNT(*) as spend_zero_count
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND spend = 0
GROUP BY account_id
HAVING spend_zero_count > 0;

-- 预期结果：应该返回 0 行（或只有历史数据，data_date 不是今天）


-- ============================================
-- 步骤4.3：对比 synced_at 和 data_date 的差异
-- ============================================
-- 查看 synced_at 和 data_date 不一致的情况（历史数据被更新 synced_at）
SELECT 
  account_id,
  ad_id,
  data_date,
  DATE(synced_at) as synced_date_utc,
  spend,
  synced_at
FROM ad_snapshots
WHERE data_date < DATE(synced_at)
  AND synced_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY synced_at DESC
LIMIT 20;

-- 预期结果：
-- - 这些是历史数据（data_date 是昨天或更早），但 synced_at 被更新了
-- - 这解释了为什么之前查询 `synced_at >= 24小时前` 会看到 spend=0 的历史数据
