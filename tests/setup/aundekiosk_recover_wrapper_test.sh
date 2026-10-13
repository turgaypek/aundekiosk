#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

WRAPPER="$SCRIPT_DIR/../../scripts/setup/aundekiosk-recover-wrapper.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/deno" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_DENO_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/deno"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_DENO_LOG="$WORKDIR/deno.log"

bash "$WRAPPER" > "$WORKDIR/output.txt" 2>&1
assert_status 0 $? "aundekiosk-recover-wrapper.sh exits 0 when deno exits 0"

grep -q "run" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh invokes 'deno run'"

grep -qF -- "--allow-net=127.0.0.1:8099" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows network access on loopback, port 8099"

grep -qF -- "--allow-read=/opt/aundekiosk" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows reading under /opt/aundekiosk"

grep -qF -- "--allow-write=/opt/aundekiosk" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows writing under /opt/aundekiosk"

grep -qF -- "--cached-only" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh never reaches the network for dependencies at runtime"

grep -qF "/opt/aundekiosk/recovery/server.ts" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh runs the recovery tool's server.ts from the installed path"

rm -rf "$WORKDIR"
assert_summary
