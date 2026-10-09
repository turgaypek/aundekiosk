#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SERVICES_DIR="$SCRIPT_DIR/../../services"

# Pi 4/5 on Raspberry Pi OS Bookworm defaults to Wayland (labwc). If the
# runner/switcher units never set WAYLAND_DISPLAY, detect_display_server
# (platform/lib.sh) always falls back to "x11", so the switcher always
# picks xdotool in production even on the primary, fully-supported target.
for unit in aundekiosk-runner.service.template aundekiosk-switcher.service.template; do
  grep -q "^Environment=WAYLAND_DISPLAY=" "$SERVICES_DIR/$unit"
  assert_status 0 $? "$unit sets WAYLAND_DISPLAY so Wayland is detected on Pi 4/5"
done

# The dashboard unit must start the Deno binary where install.sh actually
# puts it (DENO_INSTALL=/usr/local -> /usr/local/bin/deno), not a path
# nothing ever creates.
grep -q "^ExecStart=/usr/local/bin/deno " "$SERVICES_DIR/aundekiosk-dashboard.service.template"
assert_status 0 $? "aundekiosk-dashboard.service.template starts the Deno binary from the path install.sh actually installs it to"

assert_summary
