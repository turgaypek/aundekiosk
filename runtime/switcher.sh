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

# Ctrl+R (plain reload) re-submits the tab's current history entry.
# Reported live on the real device: a signage page (an ASP.NET WebForms
# dashboard using __doPostBack) ends up with a POST as that entry, so a
# plain reload pops Chromium's "Confirm Form Resubmission" dialog and
# blocks the display until someone clicks through it by hand. Re-typing
# the URL into the address bar is always a fresh GET, so this can never
# happen again — for this page or any future one added the same way.
navigate_to_url() {
  local url="$1"
  if [[ "$SWITCH_TOOL" == "wtype" ]]; then
    wtype -M ctrl -P l -m ctrl
    wtype -- "$url"
    wtype -P Return
  else
    xdotool key ctrl+l
    xdotool type --clearmodifiers -- "$url"
    xdotool key Return
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

URL_COUNT=$(url_count_in_config "$CONFIG_FILE")

REFRESH_COUNTS=()
for ((i = 0; i < URL_COUNT; i++)); do
  REFRESH_COUNTS+=(0)
done

CURRENT_TAB_INDEX=0

echo "Switcher waiting ${STARTUP_DELAY}s for the browser to initialize..."
sleep "$STARTUP_DELAY"

echo "AundeKiosk switcher started. Managing $URL_COUNT tabs."

while true; do
  # Read straight from the file on every iteration, never from an array
  # loaded once at startup — a duration/cycle/URL edited and applied via
  # the dashboard must take effect on the next tab switch, not only
  # after the switcher service is restarted (found live: an admin's
  # 10s -> 30s duration edit was silently ignored by an already-running
  # switcher for the rest of its uptime).
  url=$(url_at_index "$CONFIG_FILE" "$CURRENT_TAB_INDEX")
  duration=$(duration_at_index "$CONFIG_FILE" "$CURRENT_TAB_INDEX")
  cycle_target=$(cycles_at_index "$CONFIG_FILE" "$CURRENT_TAB_INDEX")

  REFRESH_COUNTS[$CURRENT_TAB_INDEX]=$(( REFRESH_COUNTS[CURRENT_TAB_INDEX] + 1 ))

  if should_refresh "${REFRESH_COUNTS[$CURRENT_TAB_INDEX]}" "$cycle_target"; then
    echo "Refreshing tab $((CURRENT_TAB_INDEX + 1))."
    navigate_to_url "$url"
    REFRESH_COUNTS[$CURRENT_TAB_INDEX]=0
  fi

  sleep "$duration"

  send_next_tab
  CURRENT_TAB_INDEX=$(next_tab_index "$CURRENT_TAB_INDEX" "$URL_COUNT")
done
