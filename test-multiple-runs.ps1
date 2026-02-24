# PowerShell script to test multiple heartbeat runs
# Usage: powershell -ExecutionPolicy Bypass -File test-multiple-runs.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Multiple Heartbeat Test (3 times)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

for ($i = 1; $i -le 3; $i++) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "Run $i of 3" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    
    node -e "import('./server/services/cronService.js').then(m => m.manualUnifiedHeartbeat()).catch(err => {console.error('Error:', err.message); process.exit(1);})"
    
    if ($i -lt 3) {
        Write-Host ""
        Write-Host "Waiting 2 seconds before next run..." -ForegroundColor Gray
        Start-Sleep -Seconds 2
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Test Complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Please check:" -ForegroundColor Cyan
Write-Host "1. Each run completed successfully (no 'lock busy' error)" -ForegroundColor White
Write-Host "2. Each run shows 'unified heartbeat lock released'" -ForegroundColor White
Write-Host "3. Run: node server/scripts/check-lock-status.js (should show lock is normal)" -ForegroundColor White
