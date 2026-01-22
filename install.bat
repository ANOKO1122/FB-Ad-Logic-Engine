@echo off
chcp 65001 >nul
echo 正在安装项目依赖...
echo.

cd /d "%~dp0"
npm install

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo 安装完成！
    echo ========================================
    echo.
    echo 下一步：
    echo 1. 创建 .env 文件并配置 Supabase 信息
    echo 2. 运行 npm run dev 启动开发服务器
    echo.
) else (
    echo.
    echo 安装失败，请检查：
    echo 1. 是否已安装 Node.js 和 npm
    echo 2. 网络连接是否正常
    echo.
)

pause

