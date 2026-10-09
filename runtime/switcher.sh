#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-15}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

DISPLAY_SERVER=$(detect_display_server "${WAYLAND_DISPLAY:-}" "${DISPLAY:-}")
SWITCH_TOOL=$(select_switch_tool "$DISPLAY_SERVER")

if [[ "$DISPLAY_SERVER" == "unknown" ]]; then
  echo "WARNING: could not detect a display server (neither WAYLAND_DISPLAY nor DISPLAY is set). Falling back to '$SWITCH_TOOL'."
fi

echo "Detected display server: $DISPLAY_SERVER (using $SWITCH_TOOL)"

send_refresh() {
  if [[ "$SWITCH_TOOL" == "wtype" ]]; then
    wtype -M ctrl r -m ctrl
  else
    xdotool key ctrl+r
  fi
}

send_next_tab() {
  if [[ "$SWITCH_TOOL" == "wtype" ]]; then
    wtype -M ctrl -P Tab -m ctrl
  else
    xdotool key ctrl+Tab
  fi
}

if ! has_urls "$CONFIG_FILE"; then
  echo "No URLs configured. Exiting switcher."
  exit 0
fi

mapfile -t DURATIONS < <(extract_durations_from_config "$CONFIG_FILE")
mapfile -t CYCLES < <(extract_cycles_from_config "$CONFIG_FILE")
URL_COUNT=${#DURATIONS[@]}

REFRESH_COUNTS=()
for ((i = 0; i < URL_COUNT; i++)); do
  REFRESH_COUNTS+=(0)
done

CURRENT_TAB_INDEX=0

echo "Switcher waiting ${STARTUP_DELAY}s for the browser to initialize..."
sleep "$STARTUP_DELAY"

echo "AundeKiosk switcher started. Managing $URL_COUNT tabs."

while true; do
  duration=${DURATIONS[$CURRENT_TAB_INDEX]}
  cycle_target=${CYCLES[$CURRENT_TAB_INDEX]}

  REFRESH_COUNTS[$CURRENT_TAB_INDEX]=$(( REFRESH_COUNTS[CURRENT_TAB_INDEX] + 1 ))

  if should_refresh "${REFRESH_COUNTS[$CURRENT_TAB_INDEX]}" "$cycle_target"; then
    echo "Refreshing tab $((CURRENT_TAB_INDEX + 1))."
    send_refresh
    REFRESH_COUNTS[$CURRENT_TAB_INDEX]=0
  fi

  sleep "$duration"

  send_next_tab
  CURRENT_TAB_INDEX=$(next_tab_index "$CURRENT_TAB_INDEX" "$URL_COUNT")
done
