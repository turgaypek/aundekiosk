#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../assert.sh
source "$SCRIPT_DIR/../assert.sh"
# shellcheck source=../../platform/lib.sh
source "$SCRIPT_DIR/../../platform/lib.sh"

FIXTURES="$SCRIPT_DIR/fixtures"
mkdir -p "$FIXTURES"

# --- detect_pi_model ---
echo "Raspberry Pi 5 Model B Rev 1.0" > "$FIXTURES/model_pi5.txt"
result=$(detect_pi_model "$FIXTURES/model_pi5.txt")
assert_eq "Raspberry Pi 5 Model B Rev 1.0" "$result" "detect_pi_model reads Pi 5 model string"

result=$(detect_pi_model "$FIXTURES/does_not_exist.txt")
assert_eq "unknown" "$result" "detect_pi_model falls back to unknown when file missing"

# --- detect_display_server ---
result=$(detect_display_server "wayland-0" "")
assert_eq "wayland" "$result" "detect_display_server prefers wayland when WAYLAND_DISPLAY is set"

result=$(detect_display_server "" ":0")
assert_eq "x11" "$result" "detect_display_server falls back to x11 when only DISPLAY is set"

result=$(detect_display_server "" "")
assert_eq "unknown" "$result" "detect_display_server reports unknown when neither is set"

# --- select_switch_tool ---
result=$(select_switch_tool "wayland")
assert_eq "wtype" "$result" "select_switch_tool picks wtype for wayland"

result=$(select_switch_tool "x11")
assert_eq "xdotool" "$result" "select_switch_tool picks xdotool for x11"

result=$(select_switch_tool "unknown")
assert_eq "xdotool" "$result" "select_switch_tool defaults to xdotool when display server is unknown"

# --- detect_ram_mb ---
cat > "$FIXTURES/meminfo_4gb.txt" <<'EOF'
MemTotal:        4050000 kB
MemFree:          120000 kB
MemAvailable:    2500000 kB
EOF
result=$(detect_ram_mb "$FIXTURES/meminfo_4gb.txt")
assert_eq "3955" "$result" "detect_ram_mb converts kB to MB"

# --- extract_urls_from_config / has_urls ---
cat > "$FIXTURES/config_two_urls.json" <<'EOF'
{
  "urls": [
    { "url": "https://example.com", "duration": 10, "cycles": 5 },
    { "url": "https://example.org", "duration": 20, "cycles": 0 }
  ]
}
EOF
mapfile -t url_array < <(extract_urls_from_config "$FIXTURES/config_two_urls.json")
assert_eq "2" "${#url_array[@]}" "extract_urls_from_config yields one array element per URL"
assert_eq "https://example.com" "${url_array[0]}" "extract_urls_from_config preserves the first URL as its own element"
assert_eq "https://example.org" "${url_array[1]}" "extract_urls_from_config preserves the second URL as its own element"

if has_urls "$FIXTURES/config_two_urls.json"; then
  assert_eq "yes" "yes" "has_urls returns true when config has URLs"
else
  assert_eq "yes" "no" "has_urls returns true when config has URLs"
fi

cat > "$FIXTURES/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
if has_urls "$FIXTURES/config_empty.json"; then
  assert_eq "no" "yes" "has_urls returns false when config has no URLs"
else
  assert_eq "no" "no" "has_urls returns false when config has no URLs"
fi

# --- url_count_in_config ---
result=$(url_count_in_config "$FIXTURES/config_two_urls.json")
assert_eq "2" "$result" "url_count_in_config counts the urls array"

# --- url_at_index / duration_at_index / cycles_at_index ---
# These read straight from the file on every call (no cached array) —
# switcher.sh uses them so a dashboard edit (new duration, new cycles,
# even a changed URL) takes effect on the very next loop iteration,
# instead of only after the switcher service is restarted. Found live:
# the admin changed a URL's duration from 10s to 30s and applied it, but
# the already-running switcher kept using the 10s it had loaded at its
# own startup, minutes earlier.
result=$(url_at_index "$FIXTURES/config_two_urls.json" 1)
assert_eq "https://example.org" "$result" "url_at_index reads the URL at the given index directly from the file"

result=$(duration_at_index "$FIXTURES/config_two_urls.json" 0)
assert_eq "10" "$result" "duration_at_index reads the duration at the given index directly from the file"

result=$(cycles_at_index "$FIXTURES/config_two_urls.json" 0)
assert_eq "5" "$result" "cycles_at_index reads the cycles at the given index directly from the file"

# Rewriting the file between two calls must change what the next call
# returns — proving these are live reads, not a value cached at the
# first call (which is exactly the bug being fixed).
cat > "$FIXTURES/config_live_edit.json" <<'EOF'
{ "urls": [ { "url": "https://before.test", "duration": 10, "cycles": 0 } ] }
EOF
result=$(duration_at_index "$FIXTURES/config_live_edit.json" 0)
assert_eq "10" "$result" "duration_at_index returns the original value before the file is edited"

cat > "$FIXTURES/config_live_edit.json" <<'EOF'
{ "urls": [ { "url": "https://after.test", "duration": 30, "cycles": 0 } ] }
EOF
result=$(duration_at_index "$FIXTURES/config_live_edit.json" 0)
assert_eq "30" "$result" "duration_at_index reflects an edit made after the first call, without any restart"

# --- should_refresh ---
if should_refresh 5 10; then
  assert_eq "false" "true" "should_refresh is false before reaching the target"
else
  assert_eq "false" "false" "should_refresh is false before reaching the target"
fi

if should_refresh 10 10; then
  assert_eq "true" "true" "should_refresh is true once the target is reached"
else
  assert_eq "true" "false" "should_refresh is true once the target is reached"
fi

if should_refresh 3 0; then
  assert_eq "false" "true" "should_refresh is always false when target is 0 (disabled)"
else
  assert_eq "false" "false" "should_refresh is always false when target is 0 (disabled)"
fi

# --- next_tab_index ---
result=$(next_tab_index 0 3)
assert_eq "1" "$result" "next_tab_index advances by one"

result=$(next_tab_index 2 3)
assert_eq "0" "$result" "next_tab_index wraps around to zero"

rm -rf "$FIXTURES"
assert_summary
