#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/recover-config.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$WORKDIR/systemctl.log"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export WORKDIR
export AUNDEKIOSK_TEST_CONFIG_PATH="$WORKDIR/config.json"
export AUNDEKIOSK_TEST_AUDIT_LOG="$WORKDIR/audit.log"

# Case 1: no backup exists → exits 1 with error message
bash "$HELPER" 2>"$WORKDIR/stderr.txt"
assert_status 1 $? "recover-config.sh exits 1 when no backup exists"
grep -q "No backup" "$WORKDIR/stderr.txt"
assert_status 0 $? "recover-config.sh prints a clear message when no backup exists"

# Case 2: backup exists → config restored, systemctl called, audit log written
echo '{"urls":[{"url":"https://backup.test","duration":5,"cycles":0}]}' > "${AUNDEKIOSK_TEST_CONFIG_PATH}.backup"
bash "$HELPER"
assert_status 0 $? "recover-config.sh exits 0 when backup exists"

[ -f "$AUNDEKIOSK_TEST_CONFIG_PATH" ]
assert_status 0 $? "config.json is restored from backup"

grep -q '"url":"https://backup.test"' "$AUNDEKIOSK_TEST_CONFIG_PATH"
assert_status 0 $? "restored config.json contains the backup content"

grep -q "reset-failed aundekiosk-runner" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl reset-failed aundekiosk-runner was called"

grep -q "start aundekiosk-runner" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl start aundekiosk-runner was called"

grep -q '"event":"crash_recovery"' "$AUNDEKIOSK_TEST_AUDIT_LOG"
assert_status 0 $? "audit log contains a crash_recovery event"

rm -rf "$WORKDIR"
assert_summary
