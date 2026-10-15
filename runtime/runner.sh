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

mapfile -t URLS < <(extract_urls_from_config "$CONFIG_FILE")

# Every URL is passed as its own array element (never interpolated into a
# plain string) so none of them is word-split or glob-expanded, and "--"
# marks the end of chromium's own switches so a URL value can never be
# parsed as a flag even if one somehow began with "--".
exec chromium \
  --disable-component-update \
  --disable-composited-antialiasing \
  --disable-dev-shm-usage \
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
  --user-data-dir="$CHROMIUM_CACHE_DIR" \
  -- \
  "${URLS[@]}"
