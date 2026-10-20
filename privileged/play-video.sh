#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/aundekiosk"
STATE_DIR="$INSTALL_DIR/state"
VIDEOS_DIR="$INSTALL_DIR/videos"
CDP_NAVIGATE="$INSTALL_DIR/runtime/cdp-navigate.py"
CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-$INSTALL_DIR/config.json}"
DASHBOARD_BASE="${AUNDEKIOSK_DASHBOARD_BASE:-https://127.0.0.1:8080}"
MAX_WAIT_SECONDS=7200  # 2 saat — manuel mod için üst limit

REQUEST_FILE="$STATE_DIR/video-request"
STOP_FILE="$STATE_DIR/video-stop"
DONE_FILE="$STATE_DIR/video-done"

if [[ ! -f "$REQUEST_FILE" ]]; then
  echo "No video-request file found. Exiting." >&2
  exit 1
fi

FILENAME=$(cat "$REQUEST_FILE")
rm -f "$REQUEST_FILE"

# Güvenlik: yalnızca izin verilen karakter seti + .mp4 uzantısı.
if [[ ! "$FILENAME" =~ ^[A-Za-z0-9._\ -]+\.mp4$ ]]; then
  echo "Invalid filename: $FILENAME" >&2
  exit 1
fi

VIDEO_PATH="$VIDEOS_DIR/$FILENAME"
if [[ ! -f "$VIDEO_PATH" ]]; then
  echo "Video file not found: $VIDEO_PATH" >&2
  exit 1
fi

rm -f "$STOP_FILE" "$DONE_FILE"

# Switcher'ı durdur — yoksa URL döngüsü video player'dan uzaklaşır.
systemctl stop aundekiosk-switcher.service || true
sleep 1

ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FILENAME")
python3 "$CDP_NAVIGATE" "${DASHBOARD_BASE}/video-player.html?f=${ENCODED}&mode=manual" || true

echo "Playing (manual loop): $FILENAME"

# Stop sinyali gelene kadar bekle (dashboard /stop-video endpoint'i yazar).
for (( i=0; i<MAX_WAIT_SECONDS; i++ )); do
  if [[ -f "$STOP_FILE" ]]; then
    echo "Stop signal received."
    break
  fi
  sleep 1
done

rm -f "$STOP_FILE" "$DONE_FILE"

# İlk URL-tipi öğeye geri dön.
FIRST_URL=$(jq -r '[.urls[] | select(.type != "video")] | .[0].url // empty' "$CONFIG_FILE" 2>/dev/null || true)
if [[ -n "$FIRST_URL" ]]; then
  python3 "$CDP_NAVIGATE" "$FIRST_URL" || true
fi

# Switcher'ı yeniden başlat.
systemctl start aundekiosk-switcher.service || true
echo "Playback ended, switcher restarted."
