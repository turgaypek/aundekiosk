#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/restart-kiosk-services.sh"
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
assert_status 0 $? "restart-kiosk-services.sh exits 0 on success"

args=$(cat "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE")
assert_eq "restart aundekiosk-runner.service aundekiosk-switcher.service" "$args" "restart-kiosk-services.sh restarts exactly the two kiosk services"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject_output.txt" 2>&1
assert_status 1 $? "restart-kiosk-services.sh rejects any argument"

rm -rf "$WORKDIR"
assert_summary
