#!/usr/bin/env bash
# The preview: one copy of the app on the Beelink, deployed only when asked, reachable over
# Tailscale from any device, phone included. A check it meets opens in a real Chromium on a
# virtual screen that noVNC streams to the browser, so it can be solved from a phone.
#
# Runs on the Beelink (preview.sh sends it there). Usage:
#   deploy.sh [REF] [--fresh]   deploy REF (default: main), optionally with an empty database
#   deploy.sh stop              stop it all: app, virtual screen, stream
#   deploy.sh status            what is deployed, and whether it is running
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

REPO="$HOME/projects/flight-scraper"
HOME_DIR="$HOME/.local/share/flight-scraper-preview"
RELEASES="$HOME_DIR/releases"
DATA="$HOME_DIR/data"
UNITS="$HOME/.config/systemd/user"
HOST_IP="$(tailscale ip -4)"
HOST_NAME="$(hostname)"
PORT=8800
NOVNC_PORT=6080
VNC_PORT=5998
DISPLAY_NUMBER=98
#: Phone-shaped, so a streamed check fills a phone's screen. The check window is sized to it.
SCREEN=520x900
#: Must match the Chromium build already in ~/.cache/ms-playwright.
PLAYWRIGHT=playwright==1.64.0
SERVICES=(flight-scraper-preview flight-scraper-preview-novnc flight-scraper-preview-vnc flight-scraper-preview-display)

case "${1:-}" in
  stop)
    systemctl --user disable --now "${SERVICES[@]/%/.service}" 2>/dev/null || true
    echo "Preview stopped."
    exit 0
    ;;
  status)
    readlink "$HOME_DIR/current" 2>/dev/null | xargs -r basename | sed 's/^/Deployed: /' || echo "Nothing deployed."
    systemctl --user is-active "${SERVICES[@]/%/.service}" | paste -d' ' <(printf '%s\n' "${SERVICES[@]}") -
    exit 0
    ;;
esac

REF=main
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done

git -C "$REPO" fetch -q --prune origin
SHA="$(git -C "$REPO" rev-parse --verify -q "origin/$REF^{commit}" || git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:12}"
RELEASE="$RELEASES/$SHORT"
echo "Deploying $REF ($SHORT)…"

# Each commit gets its own folder, built beside the running one: a failed build leaves the
# preview as it was.
if [ ! -f "$RELEASE/.built" ]; then
  rm -rf "$RELEASE"
  mkdir -p "$RELEASE"
  git -C "$REPO" archive "$SHA" | tar -x -C "$RELEASE"
  (cd "$RELEASE" && uv sync -q --frozen --no-dev && uv pip install -q "$PLAYWRIGHT" \
    && .venv/bin/python -m playwright install chromium)
  (cd "$RELEASE/desktop" && npm ci --silent --no-audit --no-fund && npm run --silent build >/dev/null)
  touch "$RELEASE/.built"
fi

mkdir -p "$DATA" "$UNITS"
if [ "$FRESH" = 1 ]; then
  systemctl --user stop flight-scraper-preview.service 2>/dev/null || true
  rm -rf "$DATA.previous"
  mv "$DATA" "$DATA.previous"
  mkdir -p "$DATA"
  echo "Started with an empty database; the old data is in $DATA.previous."
fi
ln -sfn "$RELEASE" "$HOME_DIR/current"
touch "$RELEASE"  # newest, so the clean-up below never takes the one running

VIEWER="http://$HOST_NAME:$NOVNC_PORT/vnc.html?autoconnect=1&reconnect=1&resize=scale"
cat >"$UNITS/flight-scraper-preview-display.service" <<EOF
[Unit]
Description=flight-scraper preview: virtual screen :$DISPLAY_NUMBER
[Service]
ExecStart=/usr/bin/Xvfb :$DISPLAY_NUMBER -screen 0 ${SCREEN}x24 -nolisten tcp
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flight-scraper-preview-vnc.service" <<EOF
[Unit]
Description=flight-scraper preview: VNC of the virtual screen, local only
BindsTo=flight-scraper-preview-display.service
After=flight-scraper-preview-display.service
[Service]
ExecStart=/usr/bin/x11vnc -display :$DISPLAY_NUMBER -rfbport $VNC_PORT -localhost -forever -shared -nopw -quiet
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flight-scraper-preview-novnc.service" <<EOF
[Unit]
Description=flight-scraper preview: noVNC stream on the tailnet
BindsTo=flight-scraper-preview-vnc.service
After=flight-scraper-preview-vnc.service
[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc $HOST_IP:$NOVNC_PORT 127.0.0.1:$VNC_PORT
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flight-scraper-preview.service" <<EOF
[Unit]
Description=flight-scraper preview ($REF, $SHORT)
Wants=flight-scraper-preview-novnc.service
After=flight-scraper-preview-novnc.service
[Service]
WorkingDirectory=$HOME_DIR/current
Environment=FLIGHT_SCRAPER_DATA_DIR=$DATA
Environment=DISPLAY=:$DISPLAY_NUMBER
Environment=FLIGHT_SCRAPER_CHECK_SCREEN=$SCREEN
Environment="FLIGHT_SCRAPER_CHALLENGE_VIEWER_URL=$VIEWER"
ExecStart=$HOME_DIR/current/.venv/bin/flight-scraper serve --host $HOST_IP --port $PORT
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable -q "${SERVICES[@]/%/.service}"
# Restarting the screen stops what is bound to it, so bring the stream back explicitly.
systemctl --user restart flight-scraper-preview-display.service
systemctl --user start flight-scraper-preview-vnc.service flight-scraper-preview-novnc.service
systemctl --user restart flight-scraper-preview.service

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://$HOST_IP:$PORT/v1/health" && break
  sleep 1
done
curl -sf -o /dev/null "http://$HOST_IP:$PORT/v1/health" || {
  echo "The preview did not come up:" >&2
  journalctl --user -u flight-scraper-preview.service -n 30 --no-pager >&2
  exit 1
}

# Two builds back is enough to go back to by hand; older ones only take space.
ls -1dt "$RELEASES"/*/ | tail -n +4 | xargs -r rm -rf

echo "Preview of $REF ($SHORT): http://$HOST_NAME:$PORT"
