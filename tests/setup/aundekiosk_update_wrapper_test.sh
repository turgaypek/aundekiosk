#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

WRAPPER="$SCRIPT_DIR/../../scripts/setup/aundekiosk-update-wrapper.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

# The fake's own shebang must be an absolute, non-PATH-resolved
# interpreter (#!/bin/sh, not #!/usr/bin/env bash) — env would look up
# "bash" on PATH again, find this very fake, and recurse forever.
cat > "$FAKE_BIN/bash" <<'EOF'
#!/bin/sh
echo "$@" >> "$AUNDEKIOSK_TEST_BASH_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/bash"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_BASH_LOG="$WORKDIR/bash.log"

/bin/bash "$WRAPPER" --dry-run > "$WORKDIR/output.txt" 2>&1
assert_status 0 $? "aundekiosk-update-wrapper.sh exits 0 when update.sh exits 0"

grep -qF "/opt/aundekiosk/scripts/setup/update.sh" "$WORKDIR/bash.log"
assert_status 0 $? "aundekiosk-update-wrapper.sh runs update.sh from the installed path"

grep -qF -- "--dry-run" "$WORKDIR/bash.log"
assert_status 0 $? "aundekiosk-update-wrapper.sh passes its own arguments through to update.sh"

rm -rf "$WORKDIR"
assert_summary
