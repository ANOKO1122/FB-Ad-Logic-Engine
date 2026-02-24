-- ============================================
-- 检查并释放残留的统一心跳锁
-- ============================================
-- 问题：如果进程异常退出，MySQL 的 GET_LOCK 可能不会自动释放
-- 解决方案：手动检查并释放残留锁

-- 1. 检查当前是否有锁被占用
SELECT 
  OBJECT_NAME AS lock_name,
  OBJECT_TYPE,
  LOCK_TYPE,
  LOCK_DURATION,
  LOCK_STATUS
FROM performance_schema.metadata_locks
WHERE OBJECT_NAME LIKE '%heartbeat%' OR OBJECT_NAME LIKE '%fb_ad_brain%';

-- 2. 查看所有活跃的锁（MySQL 8.0+）
SELECT 
  variable_name,
  variable_value
FROM performance_schema.global_status
WHERE variable_name LIKE '%lock%';

-- 3. 强制释放统一心跳锁（如果确认没有进程在使用）
-- 注意：只有在确认没有其他进程在使用时才执行
SELECT RELEASE_LOCK('fb_ad_brain:unified_heartbeat') AS released;

-- 4. 查看所有用户级别的锁
SELECT 
  OBJECT_SCHEMA,
  OBJECT_NAME,
  LOCK_TYPE,
  LOCK_DURATION,
  LOCK_STATUS
FROM performance_schema.metadata_locks
WHERE OBJECT_TYPE = 'USER LEVEL LOCK';
