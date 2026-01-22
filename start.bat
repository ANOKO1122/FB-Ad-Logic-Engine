@echo off
chcp 65001 >nul
echo ========================================
echo Facebook Marketing API 监控系统
echo ========================================
echo.

cd /d "%~dp0"

echo 检查环境变量配置...
if not exist .env (
    echo.
    echo [警告] 未找到 .env 文件
    echo 请复制 .env.example 为 .env 并配置 FACEBOOK_ACCESS_TOKEN
    echo.
    pause
    exit /b 1
)

echo.
echo 启动服务器...
echo 前端: http://localhost:3000
echo 后端API: http://localhost:3001/api
echo.

npm run dev:all

pause

