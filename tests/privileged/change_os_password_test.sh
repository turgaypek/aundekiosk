#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/change-os-password.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/chpasswd" <<'EOF'
#!/usr/bin/env bash
cat >> "$AUNDEKIOSK_TEST_CHPASSWD_LOG"
EOF
chmod +x "$FAKE_BIN/chpasswd"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_CHPASSWD_LOG="$WORKDIR/chpasswd.log"
echo "pi" > "$WORKDIR/pi-user.txt"
export AUNDEKIOSK_PI_USER_FILE="$WORKDIR/pi-user.txt"

echo '{"username":"pi","newPassword":"a-long-enough-password"}' | bash "$HELPER"
assert_status 0 $? "change-os-password.sh exits 0 for the allowed user with a long enough password"
grep -q "^pi:a-long-enough-password$" "$WORKDIR/chpasswd.log"
assert_status 0 $? "change-os-password.sh pipes 'username:password' to chpasswd"

rm -f "$WORKDIR/chpasswd.log"
echo '{"username":"root","newPassword":"a-long-enough-password"}' | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a username other than the one recorded at install time"
[[ ! -f "$WORKDIR/chpasswd.log" ]]
assert_status 0 $? "change-os-password.sh never calls chpasswd for a disallowed username"

echo '{"username":"pi","newPassword":"short"}' | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a password shorter than 12 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "change-os-password.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
