#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/toggle-vnc.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"

bash "$HELPER" enable
assert_status 0 $? "toggle-vnc.sh enable exits 0"
grep -q "enable --now wayvnc" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-vnc.sh enable calls systemctl enable --now wayvnc"

rm -f "$WORKDIR/systemctl.log"
bash "$HELPER" disable
assert_status 0 $? "toggle-vnc.sh disable exits 0"
grep -q "disable --now wayvnc" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-vnc.sh disable calls systemctl disable --now wayvnc"

bash "$HELPER" "start-everything" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "toggle-vnc.sh rejects any argument other than enable/disable"

bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "toggle-vnc.sh rejects a missing argument"

rm -rf "$WORKDIR"
assert_summary
