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
echo "$@" > "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
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

rm -rf "$WORKDIR"
assert_summary
