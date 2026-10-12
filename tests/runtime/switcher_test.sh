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

PATH="$FAKE_BIN:$PATH" timeout 20 bash "$SWITCHER" > "$WORKDIR/output_refresh.txt" 2>&1 &
SWITCHER_PID=$!

# Poll for the whole 3-step navigate_to_url sequence (ctrl+l, type,
# Return — each its own xdotool subprocess) to finish, not just its
# first step: killing right after the first write races the remaining
# two, which previously made this test flake. How long process/
# subprocess spawn takes (several jq calls per loop iteration, now that
# duration/cycles/url are read live every time) varies a lot by
# machine, so this polls instead of assuming a fixed timeout is enough.
waited=0
while ! grep -q "xdotool key Return" "$XDOTOOL_LOG" 2>/dev/null && (( waited < 150 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

kill "$SWITCHER_PID" 2>/dev/null || true
wait "$SWITCHER_PID" 2>/dev/null || true

grep -q "xdotool key ctrl+l" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh opens the address bar (ctrl+l) to refresh, instead of sending a plain reload"

grep -qF "xdotool type --clearmodifiers -- https://example.test/page" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh re-types the tab's own URL into the address bar when refreshing"

grep -q "xdotool key Return" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh presses Return to submit the re-typed URL"

grep -q "xdotool key ctrl+r" "$XDOTOOL_LOG"
assert_status 1 $? "switcher.sh never sends a plain ctrl+r reload (it would hit Confirm Form Resubmission on a POSTed page)"

# --- case 4: a duration edited via the dashboard takes effect on the
# switcher's very next loop iteration, without restarting the service.
# Found live: the admin changed a URL's duration from 10s to 30s and
# applied it through the dashboard, but the already-running switcher
# kept using the 10s it had loaded once at its own startup, minutes
# earlier — config.json's mtime was 5 minutes after the switcher had
# started. One URL, duration starts at 1s so the first "switch to next
# tab" (ctrl+Tab) happens quickly; the moment it's observed, the
# duration is rewritten to 60s. If the switcher is still using its
# stale starting value, it keeps sending ctrl+Tab about once a second;
# if it re-reads the file, it goes quiet for the rest of the test.
# Waits for the first event instead of assuming a fixed startup delay,
# so this isn't sensitive to how slow process/subprocess spawn is on
# whatever machine runs the suite. ---
cat > "$WORKDIR/config_live.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/live", "duration": 1, "cycles": 0 } ] }
EOF

: > "$XDOTOOL_LOG"
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_live.json"

PATH="$FAKE_BIN:$PATH" timeout 20 bash "$SWITCHER" > "$WORKDIR/output_live.txt" 2>&1 &
SWITCHER_PID=$!

waited=0
while [[ ! -s "$XDOTOOL_LOG" ]] && (( waited < 100 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

cat > "$WORKDIR/config_live.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/live", "duration": 60, "cycles": 0 } ] }
EOF
sleep 3

kill "$SWITCHER_PID" 2>/dev/null || true
wait "$SWITCHER_PID" 2>/dev/null || true

ctrl_tab_count=$(grep -c "xdotool key ctrl+Tab" "$XDOTOOL_LOG")
assert_eq "1" "$ctrl_tab_count" "switcher.sh re-reads duration from the config file every iteration, so an edit (1s -> 60s) takes effect without a service restart"

rm -rf "$WORKDIR"
assert_summary
