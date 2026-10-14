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
  # One read of the file for everything this iteration needs — count,
  # url, duration, and cycles together — never four separate reads.
  # Separate reads left a window where a config rewrite landing between
  # them could make an in-range count's read race a since-shrunk array's
  # per-field read, surfacing jq's "null" for every field, which this
  # script's own "set -u" then aborted on as an unbound variable.
  #
  # Re-reading the count itself (not just url/duration/cycles) every
  # iteration also means a URL ADDED OR REMOVED via the dashboard takes
  # effect on the next tab switch, not only after the switcher service is
  # restarted. Found live: config.json went from 1 URL to 2 and
  # aundekiosk-runner was restarted (Chromium correctly opened a second
  # tab), but aundekiosk-switcher was not — it kept cycling as if there
  # were still only the one tab it had loaded at its own startup, hours
  # earlier, and never visited the new one at all.
  IFS=$'\x1f' read -r URL_COUNT url duration cycle_target < <(tab_snapshot "$CONFIG_FILE" "$CURRENT_TAB_INDEX")

  if [[ "$URL_COUNT" -le 0 ]]; then
    echo "No URLs configured. Exiting switcher."
    exit 0
  fi

  if (( CURRENT_TAB_INDEX >= URL_COUNT )); then
    # The snapshot above was taken at an index that no longer exists (a
    # shrink landed since the last iteration) — its url/duration/cycles
    # are placeholders, not real data. Correct the index and read the
    # real first tab on the very next iteration instead of acting on them.
    CURRENT_TAB_INDEX=0
    continue
  fi

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
