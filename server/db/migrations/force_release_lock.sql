-- ============================================================
-- 强制释放数据库锁（紧急情况使用）
-- ============================================================

-- 1. 检查锁状态
SELECT 
  IS_FREE_LOCK('fb_ad_brain:cron:execute_rules') AS is_free,
  IS_USED_LOCK('fb_ad_brain:cron:execute_rules') AS connection_id;

-- 2. 如果锁被占用（is_free = 0），强制释放
-- 注意：这会释放所有连接持有的该锁
SELECT RELEASE_LOCK('fb_ad_brain:cron:execute_rules') AS released;

-- 3. 再次检查锁状态（应该已经释放）
SELECT 
  IS_FREE_LOCK('fb_ad_brain:cron:execute_rules') AS is_free_after,
  IS_USED_LOCK('fb_ad_brain:cron:execute_rules') AS connection_id_after;

