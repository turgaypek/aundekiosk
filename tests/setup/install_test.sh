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

# snmpd must be installed so the SNMPv3 privileged helper (Plan 4) has
# something to configure and enable.
grep -qE "^apt-get install -y .*\bsnmpd\b" "$INSTALL_SH"
assert_status 0 $? "install.sh installs the snmpd package"

# change-os-password.sh (Plan 4) refuses to act on any username other
# than the one recorded here at install time — this is what makes that
# refusal possible, not a config the dashboard can influence at runtime.
grep -q "pi-user.txt" "$INSTALL_SH"
assert_status 0 $? "install.sh records the target user for change-os-password.sh"

# Final review (Critical C2): the whole-tree "chown -R aundekiosk:aundekiosk
# $AUNDEKIOSK_INSTALL_DIR" hands ownership of EVERYTHING under
# /opt/aundekiosk to the dashboard's own unprivileged user. Writing
# pi-user.txt (or the network rollback backup) under that same tree means
# a compromised dashboard process could simply overwrite
# "pi-user.txt" with "root" and then use the already-whitelisted
# change-os-password.sh to set root's password — the "one recorded
# username" restriction would be entirely cosmetic. Both files must live
# in a directory the dashboard user never owns and can never write to.
grep -qE "pi-user\.txt.*AUNDEKIOSK_PRIV_DIR|AUNDEKIOSK_PRIV_DIR.*pi-user\.txt" "$INSTALL_SH"
assert_status 0 $? "install.sh writes pi-user.txt into the root-owned privileged-state directory, not the dashboard-owned tree"

grep -qE "install -d -m 0700 -o root -g root \"\\\$AUNDEKIOSK_PRIV_DIR\"" "$INSTALL_SH"
assert_status 0 $? "install.sh creates the privileged-state directory as root-owned, mode 0700"

# The order matters: the directory and its root-owned contents must be
# created BEFORE the blanket chown, and the chown must never reach back
# over it (the directory lives outside $AUNDEKIOSK_INSTALL_DIR entirely,
# so the existing "chown -R ... $AUNDEKIOSK_INSTALL_DIR" line cannot touch
# it either way, but this pins "it is created" positively rather than by
# the absence of a mistake).
grep -q "AUNDEKIOSK_PRIV_DIR" "$SCRIPT_DIR/../../scripts/setup/common.sh"
assert_status 0 $? "common.sh defines AUNDEKIOSK_PRIV_DIR"

assert_summary
