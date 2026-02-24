@echo off
REM 规则执行摘要查询接口测试脚本（curl 版本，Windows）
REM 使用方法：先登录获取 token，然后运行本脚本

set BASE_URL=http://localhost:3000

echo === 规则执行摘要查询接口测试（curl）===
echo.

REM 提示输入 token
set /p ADMIN_TOKEN="请输入 admin token: "

if "%ADMIN_TOKEN%"=="" (
    echo 错误：token 不能为空
    exit /b 1
)

echo.
echo 1. 测试查询摘要列表（默认分页）...
curl -s -X GET "%BASE_URL%/api/rule-execution-summaries?page=1&limit=5" ^
  -H "Authorization: Bearer %ADMIN_TOKEN%" ^
  -H "Content-Type: application/json"
echo.
echo.

echo 2. 测试按状态筛选（status=skipped）...
curl -s -X GET "%BASE_URL%/api/rule-execution-summaries?status=skipped&page=1&limit=5" ^
  -H "Authorization: Bearer %ADMIN_TOKEN%" ^
  -H "Content-Type: application/json"
echo.
echo.

echo 3. 测试按跳过原因筛选（skip_reason=account_mismatch）...
curl -s -X GET "%BASE_URL%/api/rule-execution-summaries?skip_reason=account_mismatch&page=1&limit=5" ^
  -H "Authorization: Bearer %ADMIN_TOKEN%" ^
  -H "Content-Type: application/json"
echo.
echo.

echo 4. 测试查询统计...
curl -s -X GET "%BASE_URL%/api/rule-execution-summaries/stats" ^
  -H "Authorization: Bearer %ADMIN_TOKEN%" ^
  -H "Content-Type: application/json"
echo.
echo.

echo 5. 测试权限验证（非 admin 应该返回 403）...
set /p STAFF_TOKEN="请输入 staff token（test2，或按回车跳过）: "
if not "%STAFF_TOKEN%"=="" (
    curl -s -X GET "%BASE_URL%/api/rule-execution-summaries?page=1&limit=5" ^
      -H "Authorization: Bearer %STAFF_TOKEN%" ^
      -H "Content-Type: application/json"
    echo.
    echo.
)

echo 测试完成
