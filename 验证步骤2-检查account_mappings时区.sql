-- 验证步骤 2：检查数据库中的时区是否已更新
-- 
-- 这个 SQL 查询对应截图中的第二步验证步骤
-- 
-- 使用方法：
-- 1. 在 MySQL 客户端中执行
-- 2. 或者在命令行执行：mysql -u root -p fb_ad_brain < 验证步骤2-检查account_mappings时区.sql
-- 3. 或者在 PowerShell 中使用：Get-Content 验证步骤2-检查account_mappings时区.sql | mysql -u root -p fb_ad_brain

SELECT 
    fb_account_id, 
    timezone_name,
    is_active,
    updated_at
FROM account_mappings
WHERE fb_account_id = 'act_927139705822379';

