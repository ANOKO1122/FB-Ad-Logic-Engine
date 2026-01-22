# PowerShell 脚本：执行唯一索引迁移
# 使用方法：在 PowerShell 中执行
# .\执行迁移脚本.ps1

$sqlFile = "server\db\migrations\005_add_unique_index_to_daily_stats.sql"
$database = "fb_ad_brain"
$user = "root"

Write-Host "正在执行迁移脚本: $sqlFile" -ForegroundColor Green
Write-Host "数据库: $database" -ForegroundColor Green
Write-Host ""

# 方法：使用 Get-Content 读取文件，然后通过管道传递给 mysql
# 注意：需要在 CMD 中执行，因为 PowerShell 的重定向语法不同
Write-Host "正在切换到 CMD 执行..." -ForegroundColor Yellow
cmd /c "mysql -u $user -p $database < $sqlFile"

Write-Host ""
Write-Host "迁移脚本执行完成！" -ForegroundColor Green
Write-Host ""
Write-Host "验证命令（在 MySQL 中执行）：" -ForegroundColor Yellow
Write-Host "SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';" -ForegroundColor Cyan

