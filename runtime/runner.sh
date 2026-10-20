#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-5}"
# RAM-backed, set up by install.sh — chromium's whole profile (cache
# included) lives here instead of the SD card. Found live: the default
# ~/.config/chromium location had grown to 1.7GB of constant SD-card
# rewrites from switcher.sh cycling pages every few seconds. A kiosk
# showing fixed public URLs never needs this profile to survive a
# reboot, so losing it on reboot (tmpfs) is not a tradeoff here.
CHROMIUM_CACHE_DIR="${AUNDEKIOSK_CHROMIUM_CACHE_DIR:-/var/cache/aundekiosk-chromium}"

export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

sleep "$STARTUP_DELAY"

if ! has_urls "$CONFIG_FILE"; then
  echo "No URLs found in $CONFIG_FILE. Exiting runner."
  exit 0
fi

# Open a single tab with the first URL-type item; switcher.sh then cycles
# through all items (URL and video) via CDP.  Video items are never passed
# directly to Chromium at startup — only URL items are.
FIRST_URL=$(first_url_in_config "$CONFIG_FILE")

# Hide the mouse cursor after 3 seconds of inactivity.
if command -v unclutter-xfixes > /dev/null 2>&1; then
  unclutter-xfixes --timeout 3 &
fi

# "--" marks the end of Chromium's own switches so the URL can never be
# parsed as a flag even if it somehow begins with "--".
exec chromium \
  --autoplay-policy=no-user-gesture-required \
  --ignore-certificate-errors \
  --disable-background-networking \
  --disable-component-update \
  --disable-composited-antialiasing \
  --disable-default-apps \
  --disable-dev-shm-usage \
  --disable-extensions \
  --disable-infobars \
  --disable-low-res-tiling \
  --disable-pinch \
  --disable-session-crashed-bubble \
  --disable-smooth-scrolling \
  --enable-accelerated-video-decode \
  --enable-gpu-rasterization \
  --force-device-scale-factor=1 \
  --kiosk \
  --no-first-run \
  --noerrdialogs \
  --ozone-platform=wayland \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --renderer-process-limit=1 \
  --user-data-dir="$CHROMIUM_CACHE_DIR" \
  -- \
  "$FIRST_URL"
