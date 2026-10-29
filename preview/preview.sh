#!/usr/bin/env bash
# Deploy, stop or check the preview on the Beelink, from anywhere on the tailnet.
#   preview/preview.sh [REF] [--fresh] | stop | status
# The deploy script always comes from origin/main, so push before asking for a preview.
set -euo pipefail
HOST="${FLIGHT_SCRAPER_PREVIEW_HOST:-beelink}"
run="cd ~/projects/flight-scraper && git fetch -q origin && git show origin/main:preview/deploy.sh | bash -s --"
for arg in "$@"; do run+=" $(printf '%q' "$arg")"; done
if [ "$(hostname)" = beelink-home ]; then
  bash -c "$run"
else
  ssh "$HOST" "$run"
fi
