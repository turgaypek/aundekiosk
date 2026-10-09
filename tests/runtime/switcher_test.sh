#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SWITCHER="$SCRIPT_DIR/../../runtime/switcher.sh"
WORKDIR=$(mktemp -d)

# --- case 1: no URLs -> exits immediately, never loops ---
cat > "$WORKDIR/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_empty.json"
export AUNDEKIOSK_STARTUP_DELAY=0
export WAYLAND_DISPLAY="wayland-0"
unset DISPLAY || true

timeout 5 bash "$SWITCHER" > "$WORKDIR/output_empty.txt" 2>&1
assert_status 0 $? "switcher.sh exits (does not hang) when config has no URLs"

grep -q "No URLs configured" "$WORKDIR/output_empty.txt"
assert_status 0 $? "switcher.sh logs a clear message when config has no URLs"

# --- case 2: unknown display server logs a clear warning but still exits cleanly ---
unset WAYLAND_DISPLAY || true
unset DISPLAY || true

timeout 5 bash "$SWITCHER" > "$WORKDIR/output_unknown.txt" 2>&1
assert_status 0 $? "switcher.sh still exits cleanly with no display server detected"

grep -q "WARNING: could not detect a display server" "$WORKDIR/output_unknown.txt"
assert_status 0 $? "switcher.sh warns clearly when display server cannot be detected"

rm -rf "$WORKDIR"
assert_summary
