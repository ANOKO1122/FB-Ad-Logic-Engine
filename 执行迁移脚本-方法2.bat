@echo off
REM Windows 批处理脚本：执行唯一索引迁移
REM 使用方法：双击运行或在 CMD 中执行
REM 注意：这个脚本需要在 CMD 中运行，不是 PowerShell

echo 正在执行迁移脚本...
echo 数据库: fb_ad_brain
echo.

mysql -u root -p fb_ad_brain < server\db\migrations\005_add_unique_index_to_daily_stats.sql

echo.
echo 迁移脚本执行完成！
echo.
echo 验证命令（在 MySQL 中执行）：
echo SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
echo.
pause

