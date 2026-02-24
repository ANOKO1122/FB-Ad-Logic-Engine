@echo off
chcp 65001 >nul
echo ========================================
echo Multiple Heartbeat Test (3 times)
echo ========================================
echo.

for /L %%i in (1,1,3) do (
    echo.
    echo ========================================
    echo Run %%i of 3
    echo ========================================
    node -e "import('./server/services/cronService.js').then(m => m.manualUnifiedHeartbeat()).catch(err => {console.error('Error:', err.message); process.exit(1);})"
    
    if %%i LSS 3 (
        echo.
        echo Waiting 2 seconds before next run...
        timeout /t 2 /nobreak >nul
    )
)

echo.
echo ========================================
echo Test Complete
echo ========================================
echo.
echo Please check:
echo 1. Each run completed successfully (no "lock busy" error)
echo 2. Each run shows "unified heartbeat lock released"
echo 3. Run: node server/scripts/check-lock-status.js (should show lock is normal)

pause
