#!/usr/bin/env bash
set -uo pipefail

# Final review (Important I8, I9): confirm-network-config.sh previously
# reported success ("confirmed") whether or not a rollback was actually
# pending — "systemctl stop ... || true" swallows every outcome. If the
# user confirms AFTER the timer already fired, they'd see "confirmed"
# even though the device has already reverted. This script also had no
# test coverage at all before this.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/confirm-network-config.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "is-active" ]]; then
  [[ "${AUNDEKIOSK_TEST_ROLLBACK_PENDING:-}" == "1" ]]
  exit $?
fi
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"

export AUNDEKIOSK_TEST_ROLLBACK_PENDING=1
bash "$HELPER"
assert_status 0 $? "confirm-network-config.sh exits 0 when a rollback was actually pending"
grep -q "stop" "$WORKDIR/systemctl.log"
assert_status 0 $? "confirm-network-config.sh stops the pending rollback timer"

unset AUNDEKIOSK_TEST_ROLLBACK_PENDING
rm -f "$WORKDIR/systemctl.log"
bash "$HELPER" > "$WORKDIR/already-rolled-back.txt" 2>&1
assert_status 2 $? "confirm-network-config.sh exits with a distinct code when nothing was pending (already rolled back, or never scheduled)"
grep -qi "no pending\|already" "$WORKDIR/already-rolled-back.txt"
assert_status 0 $? "confirm-network-config.sh's message says nothing was pending, not a bare success"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "confirm-network-config.sh rejects any command-line argument"

rm -rf "$WORKDIR"
assert_summary
