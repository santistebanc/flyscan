#!/usr/bin/env bash
# The dev loop on the Beelink, for working from a phone (T3 Code runs there). Run it from the
# checkout being edited and open http://beelink-home:1420 on the tailnet: TypeScript edits restart
# the service, UI edits show at once, nothing needs committing. A check opens in a real
# Chromium on a phone-shaped virtual screen, streamed by noVNC; Verify opens the stream.
#
#   beelink/dev.sh          point the dev slot at this checkout and (re)start it
#   beelink/dev.sh stop     stop it all: service, UI, virtual screen, stream
#   beelink/dev.sh status
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

CHECKOUT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/.local/share/flyscan-dev"
UNITS="$HOME/.config/systemd/user"
HOST_IP="$(tailscale ip -4)"
HOST_NAME="$(hostname)"
API_PORT=5111
WEB_PORT=1420
NOVNC_PORT=6080
VNC_PORT=5998
DISPLAY_NUMBER=98
#: Phone-shaped, so a streamed check fills a phone's screen. The check window is sized to it.
SCREEN=520x900
SERVICES=(flyscan-dev-web flyscan-dev-api flyscan-dev-novnc flyscan-dev-vnc flyscan-dev-display)

case "${1:-}" in
  stop)
    systemctl --user disable --now "${SERVICES[@]/%/.service}" 2>/dev/null || true
    echo "Dev slot stopped."
    exit 0
    ;;
  status)
    systemctl --user show flyscan-dev-api.service -p WorkingDirectory --value | sed 's/^/Checkout: /'
    systemctl --user is-active "${SERVICES[@]/%/.service}" | paste -d' ' <(printf '%s\n' "${SERVICES[@]}") -
    exit 0
    ;;
  "") ;;
  *) echo "usage: beelink/dev.sh [stop|status]" >&2; exit 2 ;;
esac

echo "Preparing $CHECKOUT…"
(cd "$CHECKOUT" && uv sync -q)
npm ci --prefix "$CHECKOUT/backend" --silent --no-audit --no-fund
(cd "$CHECKOUT/backend" && npx --no-install playwright install chromium >/dev/null)
lock="$CHECKOUT/desktop/package-lock.json"
installed="$CHECKOUT/desktop/node_modules/.package-lock.json"
if [ ! -f "$installed" ] || [ "$lock" -nt "$installed" ]; then
  npm ci --prefix "$CHECKOUT/desktop" --silent --no-audit --no-fund
fi
mkdir -p "$DATA" "$UNITS"

VIEWER="http://$HOST_NAME:$NOVNC_PORT/vnc.html?autoconnect=1&reconnect=1&resize=scale"
cat >"$UNITS/flyscan-dev-display.service" <<EOF
[Unit]
Description=flyscan dev: virtual screen :$DISPLAY_NUMBER
[Service]
ExecStart=/usr/bin/Xvfb :$DISPLAY_NUMBER -screen 0 ${SCREEN}x24 -nolisten tcp
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flyscan-dev-vnc.service" <<EOF
[Unit]
Description=flyscan dev: VNC of the virtual screen, local only
BindsTo=flyscan-dev-display.service
After=flyscan-dev-display.service
[Service]
ExecStart=/usr/bin/x11vnc -display :$DISPLAY_NUMBER -rfbport $VNC_PORT -localhost -forever -shared -nopw -quiet
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flyscan-dev-novnc.service" <<EOF
[Unit]
Description=flyscan dev: noVNC stream on the tailnet
BindsTo=flyscan-dev-vnc.service
After=flyscan-dev-vnc.service
[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc $HOST_IP:$NOVNC_PORT 127.0.0.1:$VNC_PORT
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flyscan-dev-api.service" <<EOF
[Unit]
Description=flyscan dev: service ($CHECKOUT)
Wants=flyscan-dev-novnc.service
After=flyscan-dev-novnc.service
[Service]
WorkingDirectory=$CHECKOUT
Environment=FLYSCAN_DATA_DIR=$DATA
Environment=FLYSCAN_PYTHON=$CHECKOUT/.venv/bin/python
Environment=FLYSCAN_OFFLINE=${FLYSCAN_OFFLINE:-1}
Environment=DISPLAY=:$DISPLAY_NUMBER
Environment=FLYSCAN_CHECK_SCREEN=$SCREEN
Environment="FLYSCAN_CHALLENGE_VIEWER_URL=$VIEWER"
ExecStart=$(command -v npm) run dev --prefix $CHECKOUT/backend -- --host 127.0.0.1 --port $API_PORT
# The Beelink is shared and often busy; a check's browser starts a third faster with priority.
CPUWeight=1000
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
cat >"$UNITS/flyscan-dev-web.service" <<EOF
[Unit]
Description=flyscan dev: UI with hot reload ($CHECKOUT)
Wants=flyscan-dev-api.service
After=flyscan-dev-api.service
[Service]
WorkingDirectory=$CHECKOUT/desktop
Environment=FLYSCAN_DEV_HOST=$HOST_NAME
Environment=FLYSCAN_API=http://127.0.0.1:$API_PORT
ExecStart=$CHECKOUT/desktop/node_modules/.bin/vite --host $HOST_IP
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable -q "${SERVICES[@]/%/.service}"
# Restarting the screen stops what is bound to it, so bring the stream back explicitly.
systemctl --user restart flyscan-dev-display.service
systemctl --user start flyscan-dev-vnc.service flyscan-dev-novnc.service
systemctl --user restart flyscan-dev-api.service flyscan-dev-web.service

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://$HOST_IP:$WEB_PORT/v1/health" && break
  sleep 1
done
curl -sf -o /dev/null "http://$HOST_IP:$WEB_PORT/v1/health" || {
  echo "The dev slot did not come up:" >&2
  journalctl --user -u flyscan-dev-api.service -u flyscan-dev-web.service -n 30 --no-pager >&2
  exit 1
}
echo "Dev slot on $CHECKOUT: http://$HOST_NAME:$WEB_PORT"
