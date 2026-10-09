#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/reboot-device.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" > "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE="$WORKDIR/systemctl_args.txt"

bash "$HELPER"
assert_status 0 $? "reboot-device.sh exits 0 on success"

args=$(cat "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE")
assert_eq "reboot" "$args" "reboot-device.sh calls systemctl reboot"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject_output.txt" 2>&1
assert_status 1 $? "reboot-device.sh rejects any argument"

rm -rf "$WORKDIR"
assert_summary
