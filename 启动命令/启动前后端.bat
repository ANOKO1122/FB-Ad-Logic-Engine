@echo off
cd /d "%~dp0"
start "后端" cmd /k "cd /d ""%~dp0."" && npm run dev:server:logs"
start "前端" cmd /k "cd /d ""%~dp0."" && npm run dev"
exit
