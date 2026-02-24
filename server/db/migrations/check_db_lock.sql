-- ============================================================
-- 检查数据库锁状态
-- ============================================================

-- 1. 检查规则任务锁是否被占用
SELECT 
  IS_FREE_LOCK('fb_ad_brain:cron:execute_rules') AS is_free,
  IS_USED_LOCK('fb_ad_brain:cron:execute_rules') AS connection_id;

-- 2. 如果锁被占用，查看是哪个连接持有的
-- connection_id 不为 NULL 表示锁被占用
-- 可以通过 connection_id 查看连接信息

-- 3. 查看所有活跃的锁（MySQL 5.7+）
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
  p.INFO
FROM performance_schema.metadata_locks r
LEFT JOIN performance_schema.threads t ON r.OWNER_THREAD_ID = t.THREAD_ID
LEFT JOIN information_schema.PROCESSLIST p ON t.PROCESSLIST_ID = p.ID
WHERE r.OBJECT_NAME = 'fb_ad_brain:cron:execute_rules'
   OR r.OBJECT_NAME LIKE '%cron%';

-- 4. 如果锁被占用且无法释放，可以强制释放（谨慎使用）
-- SELECT RELEASE_LOCK('fb_ad_brain:cron:execute_rules');

