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

echo '{"newPassword":"a-long-enough-password"}' | bash "$HELPER"
assert_status 0 $? "change-os-password.sh exits 0 for a long enough password"
grep -q "^pi:a-long-enough-password$" "$WORKDIR/chpasswd.log"
assert_status 0 $? "change-os-password.sh pipes 'username:password' to chpasswd, using the username recorded at install time"

# Final review (Critical C2): the payload no longer carries a username at
# all — the helper always targets the ONE user recorded in
# AUNDEKIOSK_PI_USER_FILE, so there is nothing in the request for an
# attacker (or a compromised dashboard) to spoof. A "username" field in
# the payload, even if it names a different user, is silently ignored.
rm -f "$WORKDIR/chpasswd.log"
echo '{"username":"root","newPassword":"a-long-enough-password"}' | bash "$HELPER"
assert_status 0 $? "change-os-password.sh ignores a username field entirely and still succeeds"
grep -q "^pi:a-long-enough-password$" "$WORKDIR/chpasswd.log"
assert_status 0 $? "change-os-password.sh targets the recorded user even when the payload claims a different one"

rm -f "$WORKDIR/chpasswd.log"
echo '{"newPassword":"short"}' | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a password shorter than 12 characters"

# Final review (Critical C1): a newline in the new password would be
# interpreted by chpasswd as a SECOND "user:password" line, letting an
# attacker set an arbitrary (e.g. root's) password through a field that
# only checked length.
rm -f "$WORKDIR/chpasswd.log"
printf '%s' '{"newPassword":"a-long-enough-password\nroot:owned-by-attacker"}' | bash "$HELPER" > "$WORKDIR/reject4.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a new password containing a newline"
[[ ! -f "$WORKDIR/chpasswd.log" ]]
assert_status 0 $? "change-os-password.sh never calls chpasswd when the new password contains a newline"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "change-os-password.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
