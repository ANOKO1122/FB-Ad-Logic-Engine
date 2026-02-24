-- ============================================================
-- 检查锁的持有连接信息
-- ============================================================

-- 1. 检查锁状态
SELECT 
  IS_FREE_LOCK('fb_ad_brain:cron:execute_rules') AS is_free,
  IS_USED_LOCK('fb_ad_brain:cron:execute_rules') AS connection_id;

-- 2. 如果锁被占用（connection_id 不为 NULL），查看连接信息
-- 注意：需要替换 connection_id 为实际的值
SELECT 
  ID,
  USER,
  HOST,
  DB,
  COMMAND,
  TIME,
  STATE,
  INFO,
  LEFT(INFO, 100) AS query_preview
FROM information_schema.PROCESSLIST
WHERE ID = 285766;  -- 替换为实际的 connection_id

-- 3. 查看所有持有锁的连接（MySQL 5.7+）
SELECT 
  r.OBJECT_SCHEMA,
  r.OBJECT_NAME,
  r.LOCK_TYPE,
  r.LOCK_DURATION,
  r.LOCK_STATUS,
  r.PROCESSLIST_ID,
  p.USER,
  p.HOST,
  p.DB,
  p.COMMAND,
  p.TIME,
  p.STATE,
  LEFT(p.INFO, 100) AS query_preview
FROM performance_schema.metadata_locks r
LEFT JOIN performance_schema.threads t ON r.OWNER_THREAD_ID = t.THREAD_ID
LEFT JOIN information_schema.PROCESSLIST p ON t.PROCESSLIST_ID = p.ID
WHERE r.OBJECT_NAME = 'fb_ad_brain:cron:execute_rules'
   OR r.OBJECT_NAME LIKE '%cron%'
   OR r.OBJECT_NAME LIKE '%rule%';

