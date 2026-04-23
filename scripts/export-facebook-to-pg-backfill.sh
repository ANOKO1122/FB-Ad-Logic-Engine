#!/usr/bin/env bash
set -euo pipefail

# 这个脚本是“调度壳”，不自己处理业务数据，
# 而是统一负责：参数校验、加载 PG 环境变量、防重入加锁、调用现有 Node 导出器。
# 这样做的好处是：导出逻辑只有一份，后续修口径时不会出现“两套脚本各改各的”问题。

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${LOCK_FILE:-/tmp/fb-export-to-pg-backfill.lock}"
LOG_FILE="${LOG_FILE:-/var/log/fb-export-to-pg-backfill.log}"
DEFAULT_BATCH_SIZE="${DEFAULT_BATCH_SIZE:-800}"

usage() {
  cat <<'EOF'
用法：
  ./scripts/export-facebook-to-pg-backfill.sh <回填天数> [batch_size]

示例：
  ./scripts/export-facebook-to-pg-backfill.sh 3
  ./scripts/export-facebook-to-pg-backfill.sh 7 1000

说明：
  1. <回填天数> 必须是正整数。
  2. 脚本会以“昨天”为结束日，向前回填 N 天（包含昨天）。
  3. 如需只补某一天，请直接执行：
     node server/scripts/export-facebook-to-pg.js --date=YYYY-MM-DD
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BACKFILL_DAYS="${1:-}"
BATCH_SIZE="${2:-$DEFAULT_BATCH_SIZE}"

# 先做参数校验，避免把非法参数直接传给底层导出器。
# 这里把“错误尽量拦在入口处”，用户一眼就能知道是命令写错，而不是误以为数据库或脚本内部坏了。
if [[ -z "$BACKFILL_DAYS" || ! "$BACKFILL_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误：回填天数必须是正整数。" >&2
  usage
  exit 1
fi

if [[ ! "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误：batch_size 必须是正整数。" >&2
  usage
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：当前环境未找到 node 命令，请先确认 Node.js 已安装。" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

# 这里加载 .env.pg，是为了把同事 PostgreSQL 的连接参数传给 node 导出器。
# set -a 的底层作用是：source 进来的变量会自动 export 给子进程，不需要一行行手写 export。
if [[ -f ./.env.pg ]]; then
  set -a
  . ./.env.pg
  set +a
else
  echo "错误：未找到 $PROJECT_ROOT/.env.pg，无法连接同事 PostgreSQL。" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

# flock 的原理可以把它理解成“拿锁再开车”：
# 先拿到锁的进程才能执行；如果上一次任务还没结束，这次会直接退出，防止重复回填同一批数据。
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] skip: 已有一个 PG 回填任务正在运行，当前执行被跳过。" | tee -a "$LOG_FILE"
  exit 0
fi

echo "[$(date '+%F %T')] start: backfill ${BACKFILL_DAYS} day(s), batch_size=${BATCH_SIZE}" | tee -a "$LOG_FILE"

node server/scripts/export-facebook-to-pg.js \
  --backfill-days="$BACKFILL_DAYS" \
  --batch-size="$BATCH_SIZE" 2>&1 | tee -a "$LOG_FILE"

echo "[$(date '+%F %T')] done: backfill ${BACKFILL_DAYS} day(s) finished." | tee -a "$LOG_FILE"
