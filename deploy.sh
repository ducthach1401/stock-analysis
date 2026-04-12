#!/usr/bin/env bash
# Build Docker image và chạy stack (app + MySQL + Redis).
# Production: ./deploy.sh
# Dev (bind-mount, không build image app): ./deploy.sh --dev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "⚠️  Chưa có file .env — copy từ .env.example và chỉnh trước khi deploy."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

COMPOSE_CMD=(docker compose)
if ! docker compose version &>/dev/null; then
  if command -v docker-compose &>/dev/null; then
    COMPOSE_CMD=(docker-compose)
  else
    echo "Cần Docker Compose (plugin: docker compose hoặc lệnh docker-compose)."
    exit 1
  fi
fi

FILE="${COMPOSE_FILE:-docker-compose.yml}"
DEV=0
NOCACHE=()

usage() {
  cat <<EOF
Usage: $0 [--dev] [--no-cache]
  --dev       Dùng docker-compose.dev.yml (hot reload, không build image app)
  --no-cache  docker build không dùng cache (chỉ production)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      DEV=1
      FILE="docker-compose.dev.yml"
      shift
      ;;
    --no-cache)
      NOCACHE=(--no-cache)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Không hiểu: $1"
      usage
      exit 1
      ;;
  esac
done

echo "📦 Compose file: $FILE"
echo "📛 Compose project: ${COMPOSE_PROJECT_NAME:-stock-analysis}"

if [[ "$DEV" -eq 1 ]]; then
  echo "▶️  Khởi động stack dev (MySQL + Redis + Node bind-mount)..."
  "${COMPOSE_CMD[@]}" -f "$FILE" up -d
else
  echo "🔨 Build image app..."
  "${COMPOSE_CMD[@]}" -f "$FILE" build "${NOCACHE[@]}"
  echo "▶️  Chạy containers..."
  "${COMPOSE_CMD[@]}" -f "$FILE" up -d
fi

echo ""
echo "📋 Trạng thái:"
"${COMPOSE_CMD[@]}" -f "$FILE" ps
echo ""
echo "✅ Xong. App: http://localhost:${PORT:-3000}"
