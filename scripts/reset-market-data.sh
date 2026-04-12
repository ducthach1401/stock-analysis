#!/usr/bin/env bash
# Dọn stock_prices, signals, backtest, sync meta — rồi bạn sync lại từ UI hoặc API.
# Usage:
#   ./scripts/reset-market-data.sh
#   ./scripts/reset-market-data.sh --positions   # thêm: xóa bảng positions
#
# Cần Docker: container MySQL đang chạy (vd. docker compose -f docker-compose.dev.yml up -d mysql).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

DB="${DB_NAME:-stock_analysis}"
PASS="${DB_PASSWORD:-root}"
USER="${DB_USERNAME:-root}"
CONTAINER="${MYSQL_CONTAINER:-stock-analysis-mysql-dev}"

WITH_POS=0
for a in "$@"; do
  if [[ "$a" == "--positions" ]]; then WITH_POS=1; fi
done

run_sql() {
  local file=$1
  docker exec -i -e MYSQL_PWD="$PASS" "$CONTAINER" mysql -u"$USER" "$DB" <"$file"
}

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  run_sql "$ROOT/scripts/reset-market-data.sql"
  if [[ "$WITH_POS" -eq 1 ]]; then
    run_sql "$ROOT/scripts/reset-positions.sql"
    echo "OK: đã xóa cả positions."
  fi
  echo "OK: đã dọn giá / tín hiệu / backtest / meta sync. Watchlist không đổi."
  echo ""
  echo "Sync lại (sau khi DB trống giá, nên full IPO):"
  echo "  - POST /queue/sync?full=1  (JWT admin) — queue job sync toàn watchlist"
  echo "  - Hoặc từng mã: POST /stocks/:TICKER/sync?full=1"
  echo "  - Sau đó: POST /queue/analyze-history (backfill tín hiệu) nếu cần"
  exit 0
fi

echo "Không thấy container Docker: $CONTAINER"
echo "Chạy SQL thủ công:"
echo "  mysql -h\$DB_HOST -P\$DB_PORT -u\$DB_USERNAME -p \$DB_NAME < scripts/reset-market-data.sql"
exit 1
