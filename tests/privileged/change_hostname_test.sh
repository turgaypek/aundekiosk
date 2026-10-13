#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/change-hostname.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/raspi-config" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_RASPICONFIG_LOG"
EOF
chmod +x "$FAKE_BIN/raspi-config"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_RASPICONFIG_LOG="$WORKDIR/raspi-config.log"

echo '{"hostname":"kiosk-lobby"}' | bash "$HELPER"
assert_status 0 $? "change-hostname.sh exits 0 for a valid hostname"
grep -q "nonint do_hostname kiosk-lobby" "$WORKDIR/raspi-config.log"
assert_status 0 $? "change-hostname.sh calls raspi-config nonint do_hostname with the new hostname"

rm -f "$WORKDIR/raspi-config.log"
echo '{"hostname":"kiosk name"}' | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "change-hostname.sh rejects a hostname containing a space"
[[ ! -s "$WORKDIR/raspi-config.log" ]]
assert_status 0 $? "change-hostname.sh never calls raspi-config when the hostname is invalid"

rm -f "$WORKDIR/raspi-config.log"
echo '{"hostname":"kiosk;rm -rf /"}' | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "change-hostname.sh rejects a hostname containing shell metacharacters"
[[ ! -s "$WORKDIR/raspi-config.log" ]]
assert_status 0 $? "change-hostname.sh never calls raspi-config when the hostname has metacharacters"

rm -f "$WORKDIR/raspi-config.log"
echo '{"hostname":"-bad-start"}' | bash "$HELPER" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "change-hostname.sh rejects a hostname starting with a hyphen"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject4.txt" 2>&1
assert_status 1 $? "change-hostname.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
