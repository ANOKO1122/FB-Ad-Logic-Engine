@echo off
chcp 65001 >nul
echo ========================================
echo Facebook Marketing API 监控系统
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查环境配置...
if not exist .env (
    echo [警告] 未找到 .env 文件，正在创建...
    copy .env.example .env >nul
    echo 请编辑 .env 文件，填入你的 FACEBOOK_ACCESS_TOKEN
    echo.
    pause
    exit /b 1
)

echo [2/3] 安装/更新依赖...
call npm install
if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)

echo.
echo [3/3] 启动项目...
echo.
echo 前端地址: http://localhost:3000
echo 后端API: http://localhost:3001/api
echo.
echo 按 Ctrl+C 停止服务器
echo.

call npm run dev:all

pause

