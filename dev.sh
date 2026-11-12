#!/usr/bin/env bash
# The dev loop: the backend restarts on TypeScript edits, the UI hot-reloads.
#   ./dev.sh     then open http://localhost:1420
# A check opens in a Chromium window here (Playwright, a dev dependency). Data lives in
# ./data, apart from any installed app. On a remote dev server, use remote-dev/dev.sh instead.
set -euo pipefail
cd "$(dirname "$0")"
export FLYSCAN_DATA_DIR="${FLYSCAN_DATA_DIR:-$PWD/data}"
export FLYSCAN_OFFLINE="${FLYSCAN_OFFLINE:-1}"

uv sync -q
[ -d desktop/node_modules ] || npm ci --prefix desktop --no-audit --no-fund
[ -d backend/node_modules ] || npm ci --prefix backend --no-audit --no-fund
if [ -f .venv/Scripts/python.exe ]; then
  export FLYSCAN_PYTHON="$PWD/.venv/Scripts/python.exe"
else
  export FLYSCAN_PYTHON="$PWD/.venv/bin/python"
fi

# The service watches this script and exits with it, reloader child included. Git Bash
# has its own pids; the service needs the Windows one.
parent=$$
[ -r /proc/$$/winpid ] && parent="$(cat /proc/$$/winpid)"
npm run dev --prefix backend -- --port 5111 --exit-with-parent "$parent" &
trap 'kill $! 2>/dev/null || true' EXIT

npm run dev --prefix desktop
