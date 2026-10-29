#!/usr/bin/env bash
# The dev loop on this machine: the service restarts on Python edits, the UI hot-reloads.
#   ./dev.sh     then open http://localhost:1420
# A check opens in a Chromium window here (Playwright, a dev dependency). Data lives in
# ./data, apart from any installed app. On the Beelink, use beelink/dev.sh instead.
set -euo pipefail
cd "$(dirname "$0")"
export FLIGHT_SCRAPER_DATA_DIR="${FLIGHT_SCRAPER_DATA_DIR:-$PWD/data}"

uv sync -q
[ -d desktop/node_modules ] || npm ci --prefix desktop --no-audit --no-fund

# The service watches this script and exits with it, reloader child included. Git Bash
# has its own pids; the service needs the Windows one.
parent=$$
[ -r /proc/$$/winpid ] && parent="$(cat /proc/$$/winpid)"
uv run flight-scraper serve --debug --port 5111 --exit-with-parent "$parent" &
trap 'kill $! 2>/dev/null || true' EXIT

npm run dev --prefix desktop
