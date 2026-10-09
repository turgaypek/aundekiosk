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

# The 'aundekiosk' service user has no $HOME (--no-create-home), so Deno's
# default cache dir can't be created; DENO_DIR must point inside the
# install tree instead, which install.sh's blanket chown already covers.
grep -q "^Environment=DENO_DIR=/opt/aundekiosk/.deno$" "$SERVICES_DIR/aundekiosk-dashboard.service.template"
assert_status 0 $? "aundekiosk-dashboard.service.template sets DENO_DIR to a path the service user actually owns"

# --cached-only means the service can never silently reach the npm
# registry at runtime; the one dependency it needs is pre-cached and
# integrity-checked by install.sh during setup, while there's still
# network access and an operator watching.
DASHBOARD_UNIT_CONTENT=$(cat "$SERVICES_DIR/aundekiosk-dashboard.service.template")
case "$DASHBOARD_UNIT_CONTENT" in
  *"--cached-only"*) assert_eq "has-cached-only" "has-cached-only" "aundekiosk-dashboard.service.template runs with --cached-only (never fetches at runtime)" ;;
  *) assert_eq "has-cached-only" "missing" "aundekiosk-dashboard.service.template runs with --cached-only (never fetches at runtime)" ;;
esac

assert_summary
