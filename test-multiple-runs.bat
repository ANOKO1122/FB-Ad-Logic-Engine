@echo off
REM 多次执行统一心跳任务，验证锁能正常获取和释放
REM 使用方法：在项目根目录执行 test-multiple-runs.bat

echo ========================================
echo 多次执行统一心跳任务验证（验证锁不泄漏）
echo ========================================
echo.

for /L %%i in (1,1,3) do (
    echo.
    echo ========================================
    echo 第 %%i 次执行
    echo ========================================
    node -e "import('./server/services/cronService.js').then(m => m.manualUnifiedHeartbeat()).catch(err => {console.error('执行失败:', err.message); process.exit(1);})"
    
    if %%i LSS 3 (
        echo.
        echo 等待 2 秒后执行下一次...
        timeout /t 2 /nobreak >nul
    )
)

echo.
echo ========================================
echo 验证完成
echo ========================================
echo.
echo 请检查：
echo 1. 每次执行都能正常完成（没有"锁已被占用"错误）
echo 2. 每次执行后都显示"统一心跳锁已释放"
echo 3. 执行 node server/scripts/check-lock-status.js 应该显示锁状态正常

pause
