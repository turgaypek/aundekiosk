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

# --- case 3: refreshing re-types the tab's own URL via the address bar,
# instead of sending a plain reload. Reported live on the real device: a
# signage page (an ASP.NET WebForms dashboard using __doPostBack) ends up
# with a POST as its current history entry, so a plain Ctrl+R reload pops
# Chromium's "Confirm Form Resubmission" dialog and blocks the kiosk
# display until someone clicks through it by hand. Re-typing the URL is
# always a fresh GET, so this can never happen again for this page or any
# future one added the same way. ---
cat > "$WORKDIR/config_refresh.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/page", "duration": 1, "cycles": 1 } ] }
EOF

FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/xdotool" <<'EOF'
#!/usr/bin/env bash
echo "xdotool $*" >> "$XDOTOOL_LOG"
EOF
chmod +x "$FAKE_BIN/xdotool"

export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_refresh.json"
export AUNDEKIOSK_STARTUP_DELAY=0
export XDOTOOL_LOG="$WORKDIR/xdotool.log"
: > "$XDOTOOL_LOG"
unset WAYLAND_DISPLAY || true
export DISPLAY=":0"

PATH="$FAKE_BIN:$PATH" timeout 3 bash "$SWITCHER" > "$WORKDIR/output_refresh.txt" 2>&1 || true

grep -q "xdotool key ctrl+l" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh opens the address bar (ctrl+l) to refresh, instead of sending a plain reload"

grep -qF "xdotool type --clearmodifiers -- https://example.test/page" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh re-types the tab's own URL into the address bar when refreshing"

grep -q "xdotool key Return" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh presses Return to submit the re-typed URL"

grep -q "xdotool key ctrl+r" "$XDOTOOL_LOG"
assert_status 1 $? "switcher.sh never sends a plain ctrl+r reload (it would hit Confirm Form Resubmission on a POSTed page)"

rm -rf "$WORKDIR"
assert_summary
