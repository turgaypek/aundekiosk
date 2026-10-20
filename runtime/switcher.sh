#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STATE_DIR="${AUNDEKIOSK_STATE_DIR:-/opt/aundekiosk/state}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-15}"
DASHBOARD_BASE="${AUNDEKIOSK_DASHBOARD_BASE:-https://127.0.0.1:8080}"
# Maximum seconds to wait for a video-done signal before moving on.
VIDEO_WAIT_MAX="${AUNDEKIOSK_VIDEO_WAIT_MAX:-3600}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

CDP_NAVIGATE="$SCRIPT_DIR/cdp-navigate.py"

navigate_to_url() {
  local url="$1"
  python3 "$CDP_NAVIGATE" "$url"
}

# Play a video item in automatic mode: navigate Chromium to the video player
# page and block until the player signals completion (or VIDEO_WAIT_MAX elapses).
play_video_item() {
  local filename="$1"
  local done_file="$STATE_DIR/video-done"

  rm -f "$done_file" 2>/dev/null || true

  local encoded
  encoded=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$filename")
  navigate_to_url "${DASHBOARD_BASE}/video-player.html?f=${encoded}&mode=auto" || true

  echo "Playing video: $filename (waiting for completion)."
  local waited=0
  while (( waited < VIDEO_WAIT_MAX )); do
    if [[ -f "$done_file" ]]; then
      rm -f "$done_file" 2>/dev/null || true
      echo "Video finished: $filename."
      return
    fi
    sleep 1
    (( waited++ )) || true
  done
  echo "Video wait timeout after ${VIDEO_WAIT_MAX}s, continuing." >&2
  rm -f "$done_file" 2>/dev/null || true
}

if ! has_urls "$CONFIG_FILE"; then
  echo "No URLs configured. Exiting switcher."
  exit 0
fi

CURRENT_TAB_INDEX=0

echo "Switcher waiting ${STARTUP_DELAY}s for the browser to initialize..."
sleep "$STARTUP_DELAY"

echo "AundeKiosk switcher started."

while true; do
  # One atomic read of type + url/filename + duration — never separate reads.
  # _cycles is intentionally unused.
  IFS=$'\x1f' read -r ITEM_COUNT item_type url duration _cycles filename < <(item_snapshot "$CONFIG_FILE" "$CURRENT_TAB_INDEX")

  if [[ "$ITEM_COUNT" -le 0 ]]; then
    echo "No items configured. Exiting switcher."
    exit 0
  fi

  if (( CURRENT_TAB_INDEX >= ITEM_COUNT )); then
    CURRENT_TAB_INDEX=0
    continue
  fi

  if [[ "$item_type" == "video" ]]; then
    echo "Video item $((CURRENT_TAB_INDEX + 1))/$ITEM_COUNT: $filename"
    play_video_item "$filename"
  else
    echo "URL item $((CURRENT_TAB_INDEX + 1))/$ITEM_COUNT."
    navigate_to_url "$url"
    sleep "$duration"
  fi

  CURRENT_TAB_INDEX=$(next_tab_index "$CURRENT_TAB_INDEX" "$ITEM_COUNT")
done
