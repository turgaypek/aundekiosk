#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

RUNNER="$SCRIPT_DIR/../../runtime/runner.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/chromium" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
EOF
chmod +x "$FAKE_BIN/chromium"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_STARTUP_DELAY=0
export AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE="$WORKDIR/chromium_args.txt"

# --- case 1: config with URLs launches chromium with them ---
cat > "$WORKDIR/config_with_urls.json" <<'EOF'
{ "urls": [ { "url": "https://a.test", "duration": 10, "cycles": 5 } ] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_with_urls.json"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output.txt" 2>&1 || true

if [[ -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE" ]] && grep -q "https://a.test" "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"; then
  assert_eq "called" "called" "runner.sh launches chromium with the configured URL"
else
  assert_eq "called" "not-called" "runner.sh launches chromium with the configured URL"
fi

# --- case 2: config with no URLs exits without launching chromium ---
cat > "$WORKDIR/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_empty.json"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output_empty.txt" 2>&1 || true

if [[ -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE" ]]; then
  assert_eq "not-called" "called" "runner.sh does not launch chromium when config has no URLs"
else
  assert_eq "not-called" "not-called" "runner.sh does not launch chromium when config has no URLs"
fi

grep -q "No URLs found" "$WORKDIR/runner_output_empty.txt"
assert_status 0 $? "runner.sh logs a clear message when config has no URLs"

# --- case 3: a URL containing a space arrives as a single argv entry, after a literal "--" ---
# Defense in depth: config_api.ts should already reject a value like this,
# but runner.sh must not rely on that — e.g. someone could hand-edit
# config.json directly on disk, bypassing the API entirely.
cat > "$WORKDIR/config_tricky_url.json" <<'EOF'
{ "urls": [ { "url": "https://ok.test/page --flag", "duration": 10, "cycles": 5 } ] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_tricky_url.json"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output_tricky.txt" 2>&1 || true

mapfile -t chromium_args < "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"

found_as_one_arg="no"
for arg in "${chromium_args[@]}"; do
  if [[ "$arg" == "https://ok.test/page --flag" ]]; then
    found_as_one_arg="yes"
  fi
done
assert_eq "yes" "$found_as_one_arg" "runner.sh passes a space-containing URL to chromium as a single argv entry, not word-split"

found_separator="no"
for arg in "${chromium_args[@]}"; do
  if [[ "$arg" == "--" ]]; then
    found_separator="yes"
  fi
done
assert_eq "yes" "$found_separator" "runner.sh passes a literal -- before the URL list so a value can never be parsed as a chromium flag"

# --- case 4: chromium's whole profile (cache included) is pointed at the
# RAM-backed tmpfs install.sh sets up, never the default ~/.config/chromium
# on the SD card. Found live: that default location had grown to 1.7GB on
# the real device, rewritten constantly as switcher.sh cycles pages every
# few seconds — exactly the write pattern that wears out or stalls a
# slower SD card. A kiosk showing fixed public URLs never needs that
# profile to survive a reboot, so tmpfs (gone on reboot) is strictly
# better here, not just a workaround. ---
export AUNDEKIOSK_CHROMIUM_CACHE_DIR="$WORKDIR/chromium-cache"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output_cache.txt" 2>&1 || true

mapfile -t chromium_args_cache < "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
found_user_data_dir="no"
for arg in "${chromium_args_cache[@]}"; do
  if [[ "$arg" == "--user-data-dir=$WORKDIR/chromium-cache" ]]; then
    found_user_data_dir="yes"
  fi
done
assert_eq "yes" "$found_user_data_dir" "runner.sh points chromium's whole profile (--user-data-dir) at the tmpfs cache dir, not the SD-card default"

rm -rf "$WORKDIR"
assert_summary
