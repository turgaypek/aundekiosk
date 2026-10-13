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

# Real runuser (root only) drops privileges and execs its argument list;
# this fake does the same without needing real root, so the chain still
# reaches the fake deno above and records what it was called with.
cat > "$FAKE_BIN/runuser" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_RUNUSER_LOG"
shift 2  # drop "-u" "<user>"
[ "${1:-}" = "--" ] && shift
exec "$@"
EOF
chmod +x "$FAKE_BIN/runuser"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_DENO_LOG="$WORKDIR/deno.log"
export AUNDEKIOSK_TEST_RUNUSER_LOG="$WORKDIR/runuser.log"

# --- Not run as root ---

cat > "$FAKE_BIN/id" <<'EOF'
#!/usr/bin/env bash
echo "1000"
EOF
chmod +x "$FAKE_BIN/id"

output=$(bash "$WRAPPER" 2>&1)
assert_status 1 $? "aundekiosk-recover-wrapper.sh exits non-zero when not run as root"

case "$output" in
  *sudo*)
    assert_eq "mentions sudo" "mentions sudo" "aundekiosk-recover-wrapper.sh tells the operator to use sudo when not run as root"
    ;;
  *)
    assert_eq "mentions sudo" "unexpected output: $output" "aundekiosk-recover-wrapper.sh tells the operator to use sudo when not run as root"
    ;;
esac

[ ! -s "$AUNDEKIOSK_TEST_DENO_LOG" ]
assert_status 0 $? "aundekiosk-recover-wrapper.sh never invokes deno when not run as root"

# --- Run as root ---

cat > "$FAKE_BIN/id" <<'EOF'
#!/usr/bin/env bash
echo "0"
EOF
chmod +x "$FAKE_BIN/id"

bash "$WRAPPER" > "$WORKDIR/output.txt" 2>&1
assert_status 0 $? "aundekiosk-recover-wrapper.sh exits 0 when run as root and deno exits 0"

grep -qF -- "-u aundekiosk" "$WORKDIR/runuser.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh drops root privileges to the aundekiosk user before starting deno"

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
