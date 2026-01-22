-- 验证步骤 3：检查 ad_snapshots 表中的时区是否已更新
-- 
-- 这个 SQL 查询对应截图中的第三步验证步骤
-- 
-- 使用方法：
-- 1. 在 MySQL 客户端中执行
-- 2. 或者在命令行执行：mysql -u root -p fb_ad_brain < 验证步骤3-检查ad_snapshots时区.sql
-- 3. 或者在 PowerShell 中使用：Get-Content 验证步骤3-检查ad_snapshots时区.sql | mysql -u root -p fb_ad_brain

SELECT 
    account_id, 
    timezone_name, 
    COUNT(*) as count, 
    MAX(synced_at) as latest_sync
FROM ad_snapshots
WHERE account_id = 'act_927139705822379'
GROUP BY account_id, timezone_name
ORDER BY latest_sync DESC;

