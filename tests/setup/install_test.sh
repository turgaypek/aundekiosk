#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

INSTALL_SH="$SCRIPT_DIR/../../scripts/setup/install.sh"

# This only exercises the very first check (resolving PI_USER), which exits
# before any apt-get/useradd/systemctl call — safe to run directly, unlike
# the rest of install.sh (see spec §11: real execution is Pi-only).
output=$(env -u SUDO_USER bash "$INSTALL_SH" 2>&1)
status=$?

assert_status 1 "$status" "install.sh exits non-zero when no user can be resolved"

case "$output" in
  *"unbound variable"*)
    assert_eq "friendly error" "unbound variable crash" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
  *"Could not determine target user"*)
    assert_eq "friendly error" "friendly error" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
  *)
    assert_eq "friendly error" "unexpected output: $output" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
esac

# The dashboard's one npm dependency must be pre-cached (with its lock
# file, for integrity) during install, while there's still network access
# and before the --cached-only service unit would otherwise fail to start.
grep -q "deno cache" "$INSTALL_SH"
assert_status 0 $? "install.sh pre-caches the dashboard's Deno dependencies"

grep -q -- "--lock=" "$INSTALL_SH"
assert_status 0 $? "install.sh verifies the cached dependency against deno.lock"

assert_summary
