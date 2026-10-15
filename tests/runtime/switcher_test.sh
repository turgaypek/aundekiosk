#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SWITCHER="$SCRIPT_DIR/../../runtime/switcher.sh"
WORKDIR=$(mktemp -d)

# Write-then-rename (mirrors config_api.ts's own atomic write) for every
# rewrite made WHILE the switcher is already running and reading the same
# file: a plain "cat > file" truncates before it writes, and a jq read
# that lands in that window gets invalid/partial JSON, which — under
# switcher.sh's own "set -e" — silently kills the switcher rather than
# just erroring one read. Found exactly this way: these tests flaked only
# under the full suite's CPU contention, never standalone.
write_config_atomically() {
  local target="$1"
  cat > "$target.tmp" <<< "$2"
  mv "$target.tmp" "$target"
}

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

# --- case 3: every switch re-types the URL into the address bar (Ctrl+L),
# never using a plain reload. Reported live on the real device: a signage
# page (an ASP.NET WebForms dashboard using __doPostBack) ends up with a
# POST as its current history entry, so a plain Ctrl+R reload pops
# Chromium's "Confirm Form Resubmission" dialog and blocks the kiosk
# display until someone clicks through it by hand. Re-typing is always a
# fresh GET, so this can never happen for any URL added to the kiosk. ---
cat > "$WORKDIR/config_nav.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/page", "duration": 1, "cycles": 0 } ] }
EOF

FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/xdotool" <<'EOF'
#!/usr/bin/env bash
echo "xdotool $*" >> "$XDOTOOL_LOG"
EOF
chmod +x "$FAKE_BIN/xdotool"

export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_nav.json"
export AUNDEKIOSK_STARTUP_DELAY=0
export XDOTOOL_LOG="$WORKDIR/xdotool.log"
: > "$XDOTOOL_LOG"
unset WAYLAND_DISPLAY || true
export DISPLAY=":0"

PATH="$FAKE_BIN:$PATH" timeout 20 bash "$SWITCHER" > "$WORKDIR/output_nav.txt" 2>&1 &
SWITCHER_PID=$!

# Poll for the whole 3-step navigate_to_url sequence (ctrl+l, type,
# Return — each its own xdotool subprocess) to finish, not just its
# first step: killing right after the first write races the remaining
# two, which previously made this test flake. How long process/
# subprocess spawn takes varies a lot by machine, so this polls instead
# of assuming a fixed timeout is enough.
waited=0
while ! grep -q "xdotool key Return" "$XDOTOOL_LOG" 2>/dev/null && (( waited < 150 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

kill "$SWITCHER_PID" 2>/dev/null || true
wait "$SWITCHER_PID" 2>/dev/null || true

grep -q "xdotool key ctrl+l" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh opens the address bar (ctrl+l) on every switch, instead of sending a plain reload"

grep -qF "xdotool type --clearmodifiers -- https://example.test/page" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh types the URL into the address bar on every switch"

grep -q "xdotool key Return" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh presses Return to submit the typed URL"

grep -q "xdotool key ctrl+r" "$XDOTOOL_LOG"
assert_status 1 $? "switcher.sh never sends a plain ctrl+r reload (it would hit Confirm Form Resubmission on a POSTed page)"

grep -q "xdotool key ctrl+Tab" "$XDOTOOL_LOG"
assert_status 1 $? "switcher.sh never sends ctrl+Tab (single-tab navigation, no multi-tab cycling)"

# --- case 4: a duration edited via the dashboard takes effect on the
# switcher's very next loop iteration, without restarting the service.
# Found live: the admin changed a URL's duration from 10s to 30s and
# applied it through the dashboard, but the already-running switcher
# kept using the 10s it had loaded once at its own startup, minutes
# earlier. One URL, duration starts at 1s so the first navigate_to_url
# (xdotool type) happens quickly; the moment it's observed, the
# duration is rewritten to 60s. If the switcher is still using its
# stale starting value, it keeps navigating about once a second; if it
# re-reads the file, it goes quiet for the rest of the test. Waits for
# the first event instead of assuming a fixed startup delay. ---
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

write_config_atomically "$WORKDIR/config_live.json" \
  '{ "urls": [ { "url": "https://example.test/live", "duration": 60, "cycles": 0 } ] }'

# An iteration that was already mid-read when this rewrite landed can
# still see the stale 1s duration once more — an inherent race between
# an external edit and an already-running read loop (same race a real
# admin's save has in production). 2.5s gives that one straggler room
# to finish. A further 3s with the count unchanged is what proves the
# new 60s duration took hold — if the bug were back the switcher would
# keep typing a new URL about once a second instead of going quiet.
sleep 2.5
count_after_grace=$(grep -c "xdotool type" "$XDOTOOL_LOG" || echo 0)
sleep 3
count_final=$(grep -c "xdotool type" "$XDOTOOL_LOG" || echo 0)

kill "$SWITCHER_PID" 2>/dev/null || true
wait "$SWITCHER_PID" 2>/dev/null || true

if [[ "$count_after_grace" -le 2 ]]; then
  assert_eq "yes" "yes" "switcher.sh picks up an edited duration within at most one in-flight (stale-read) iteration"
else
  assert_eq "yes" "no (saw $count_after_grace navigations within the grace window)" "switcher.sh picks up an edited duration within at most one in-flight (stale-read) iteration"
fi

assert_eq "$count_after_grace" "$count_final" "switcher.sh re-reads duration from the config file every iteration, so an edit (1s -> 60s) takes effect without a service restart"

# --- case 5: a URL ADDED via the dashboard is picked up without
# restarting the switcher. Found live on the real device: config.json
# went from 1 URL to 2, aundekiosk-runner was restarted (so Chromium
# correctly opened a second tab), but aundekiosk-switcher was not — its
# startup log still said "Managing 1 tabs" from hours earlier, so it
# never visited the new URL at all.  With the single-tab address-bar
# approach, the switcher always types the URL for the current index, so
# when it advances to index 1 it types https://example.test/second —
# an unambiguous signal that URL_COUNT was re-read live. ---
cat > "$WORKDIR/config_grow.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/first", "duration": 1, "cycles": 0 } ] }
EOF

: > "$XDOTOOL_LOG"
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_grow.json"

PATH="$FAKE_BIN:$PATH" timeout 40 bash "$SWITCHER" > "$WORKDIR/output_grow.txt" 2>&1 &
SWITCHER_PID=$!

waited=0
while [[ ! -s "$XDOTOOL_LOG" ]] && (( waited < 200 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

write_config_atomically "$WORKDIR/config_grow.json" '{
  "urls": [
    { "url": "https://example.test/first", "duration": 1, "cycles": 0 },
    { "url": "https://example.test/second", "duration": 1, "cycles": 0 }
  ]
}'

# Several jq spawns per switcher iteration make this slower under full-suite
# CPU contention than alone — poll generously instead of a fixed timeout.
waited=0
while ! grep -qF "https://example.test/second" "$XDOTOOL_LOG" 2>/dev/null && (( waited < 300 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

kill "$SWITCHER_PID" 2>/dev/null || true
wait "$SWITCHER_PID" 2>/dev/null || true

grep -qF "https://example.test/second" "$XDOTOOL_LOG"
assert_status 0 $? "switcher.sh re-reads the URL COUNT from the config file every iteration, so a URL added via the dashboard is visited without restarting the switcher"

# --- case 6: every URL removed via the dashboard while the switcher is
# already running (config.json goes from N URLs to zero) makes it exit
# cleanly, the same way it does when it never had any URLs to begin with
# — not crash on a division-by-zero computing the next tab index. ---
cat > "$WORKDIR/config_shrink.json" <<'EOF'
{ "urls": [ { "url": "https://example.test/only", "duration": 1, "cycles": 0 } ] }
EOF

: > "$XDOTOOL_LOG"
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_shrink.json"

PATH="$FAKE_BIN:$PATH" timeout 20 bash "$SWITCHER" > "$WORKDIR/output_shrink.txt" 2>&1 &
SWITCHER_PID=$!

waited=0
while [[ ! -s "$XDOTOOL_LOG" ]] && (( waited < 100 )); do
  sleep 0.1
  waited=$(( waited + 1 ))
done

write_config_atomically "$WORKDIR/config_shrink.json" '{ "urls": [] }'

wait "$SWITCHER_PID" 2>/dev/null
shrink_status=$?
assert_status 0 "$shrink_status" "switcher.sh exits cleanly (not a crash) when every URL is removed while it's already running"

grep -q "No URLs configured" "$WORKDIR/output_shrink.txt"
assert_status 0 $? "switcher.sh logs the same clear message whether it starts with no URLs or loses them all while running"

rm -rf "$WORKDIR"
assert_summary
