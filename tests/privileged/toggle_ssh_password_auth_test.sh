#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/toggle-ssh-password-auth.sh"
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
export AUNDEKIOSK_SSHD_DROPIN_FILE="$WORKDIR/aundekiosk-password-auth.conf"

bash "$HELPER" disable
assert_status 0 $? "toggle-ssh-password-auth.sh disable exits 0"
grep -q "^PasswordAuthentication no$" "$WORKDIR/aundekiosk-password-auth.conf"
assert_status 0 $? "toggle-ssh-password-auth.sh disable writes PasswordAuthentication no"

bash "$HELPER" enable
assert_status 0 $? "toggle-ssh-password-auth.sh enable exits 0"
grep -q "^PasswordAuthentication yes$" "$WORKDIR/aundekiosk-password-auth.conf"
assert_status 0 $? "toggle-ssh-password-auth.sh enable writes PasswordAuthentication yes"

bash "$HELPER" "maybe" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "toggle-ssh-password-auth.sh rejects any argument other than enable/disable"

rm -rf "$WORKDIR"
assert_summary
