#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-15}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

CDP_NAVIGATE="$SCRIPT_DIR/cdp-navigate.py"

# Navigate via Chromium DevTools Protocol (CDP).  Chromium is started with
# --remote-debugging-port=9222 by runner.sh so cdp-navigate.py can send a
# Page.navigate command directly over a WebSocket.  This is more reliable
# than wtype/xdotool because it does not depend on window focus, display
# server type, or whether kiosk mode intercepts keyboard shortcuts.
navigate_to_url() {
  local url="$1"
  python3 "$CDP_NAVIGATE" "$url"
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
  # One read of the file for everything this iteration needs — count, url,
  # and duration together — never separate reads.  Separate reads left a
  # window where a config rewrite landing between them could make an
  # in-range count's read race a since-shrunk array's per-field read.
  # _cycles is intentionally unused: the address-bar navigation on every
  # switch already guarantees a fresh GET, making periodic forced reloads
  # redundant.
  IFS=$'\x1f' read -r URL_COUNT url duration _cycles < <(tab_snapshot "$CONFIG_FILE" "$CURRENT_TAB_INDEX")

  if [[ "$URL_COUNT" -le 0 ]]; then
    echo "No URLs configured. Exiting switcher."
    exit 0
  fi

  if (( CURRENT_TAB_INDEX >= URL_COUNT )); then
    # The snapshot was taken at an index that no longer exists (a shrink
    # landed since the last iteration) — its url/duration are placeholders.
    # Correct the index and read real data on the next iteration.
    CURRENT_TAB_INDEX=0
    continue
  fi

  echo "Displaying URL $((CURRENT_TAB_INDEX + 1))/$URL_COUNT."
  navigate_to_url "$url"

  sleep "$duration"

  CURRENT_TAB_INDEX=$(next_tab_index "$CURRENT_TAB_INDEX" "$URL_COUNT")
done
