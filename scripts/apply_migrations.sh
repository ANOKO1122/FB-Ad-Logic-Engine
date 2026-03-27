#!/usr/bin/env bash
# 将 server/db/migrations/ 下 001_*.sql～040_*.sql 按版本顺序应用到 DB_NAME（默认 fb_ad_brain）。
# 使用 --force 忽略「重复列/重复索引」等可恢复错误（适合已有库补迁移）。
# 用法：在仓库根目录执行
#   chmod +x scripts/apply_migrations.sh
#   ./scripts/apply_migrations.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -f .env ]]; then
  echo "缺少 .env" >&2
  exit 1
fi
# shellcheck disable=SC2046
PW=$(grep '^DB_PASS=' .env | cut -d= -f2-)
DB="${DB_NAME:-fb_ad_brain}"
CONTAINER="${MYSQL_CONTAINER:-mysql}"
for f in $(ls server/db/migrations/[0-9][0-9][0-9]_*.sql | sort -V); do
  echo ">>> $f"
  docker exec -i "$CONTAINER" mysql -uroot -p"$PW" "$DB" --force < "$f" 2>&1 | grep -E '^ERROR' || true
done
echo "--- 验证关键表 ---"
docker exec -i "$CONTAINER" mysql -uroot -p"$PW" "$DB" -e \
  "SHOW TABLES LIKE 'rule_ad_execution_state'; SHOW TABLES LIKE 'structure_sync_status';"
