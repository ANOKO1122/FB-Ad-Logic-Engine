#!/bin/bash
# 规则执行摘要查询接口测试脚本（curl 版本）
# 使用方法：先登录获取 token，然后运行本脚本

BASE_URL="http://localhost:3000"

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== 规则执行摘要查询接口测试（curl）===${NC}\n"

# 提示输入 token
read -p "请输入 admin token: " ADMIN_TOKEN
if [ -z "$ADMIN_TOKEN" ]; then
  echo -e "${RED}❌ token 不能为空${NC}"
  exit 1
fi

echo ""

# 1. 测试查询摘要列表
echo -e "${BLUE}1. 测试查询摘要列表（默认分页）...${NC}"
curl -s -X GET "${BASE_URL}/api/rule-execution-summaries?page=1&limit=5" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  | jq '.' || echo "（如果没安装 jq，去掉 | jq '.' 即可）"
echo ""

# 2. 测试按账户筛选
echo -e "${BLUE}2. 测试按账户筛选...${NC}"
read -p "请输入要查询的 account_id（或按回车跳过）: " ACCOUNT_ID
if [ -n "$ACCOUNT_ID" ]; then
  curl -s -X GET "${BASE_URL}/api/rule-execution-summaries?account_id=${ACCOUNT_ID}&page=1&limit=5" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    | jq '.' || echo ""
  echo ""
fi

# 3. 测试按状态筛选
echo -e "${BLUE}3. 测试按状态筛选（status=skipped）...${NC}"
curl -s -X GET "${BASE_URL}/api/rule-execution-summaries?status=skipped&page=1&limit=5" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  | jq '.' || echo ""
echo ""

# 4. 测试按跳过原因筛选
echo -e "${BLUE}4. 测试按跳过原因筛选（skip_reason=account_mismatch）...${NC}"
curl -s -X GET "${BASE_URL}/api/rule-execution-summaries?skip_reason=account_mismatch&page=1&limit=5" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  | jq '.' || echo ""
echo ""

# 5. 测试查询统计
echo -e "${BLUE}5. 测试查询统计...${NC}"
curl -s -X GET "${BASE_URL}/api/rule-execution-summaries/stats" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  | jq '.' || echo ""
echo ""

# 6. 测试权限验证（非 admin）
echo -e "${BLUE}6. 测试权限验证（非 admin 应该返回 403）...${NC}"
read -p "请输入 staff token（test2）: " STAFF_TOKEN
if [ -n "$STAFF_TOKEN" ]; then
  curl -s -X GET "${BASE_URL}/api/rule-execution-summaries?page=1&limit=5" \
    -H "Authorization: Bearer ${STAFF_TOKEN}" \
    -H "Content-Type: application/json" \
    | jq '.' || echo ""
  echo ""
fi

echo -e "${GREEN}✅ 测试完成${NC}"
