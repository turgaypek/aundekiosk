#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

BOOTSTRAP_SH="$SCRIPT_DIR/../../scripts/setup/bootstrap.sh"

# These exercise real early-exit paths only (bad args; not root) — safe to
# run directly, unlike --install/--update themselves (a real git clone and
# a real install.sh/update.sh run, Pi-only, same convention as install.sh's
# own tests: see tests/setup/install_test.sh).
output=$(bash "$BOOTSTRAP_SH" 2>&1)
assert_status 1 $? "bootstrap.sh exits non-zero with no arguments"

case "$output" in
  *"Usage:"*)
    assert_eq "usage shown" "usage shown" "bootstrap.sh prints a usage message with no arguments"
    ;;
  *)
    assert_eq "usage shown" "unexpected output: $output" "bootstrap.sh prints a usage message with no arguments"
    ;;
esac

output=$(bash "$BOOTSTRAP_SH" --bogus-flag 2>&1)
assert_status 1 $? "bootstrap.sh exits non-zero on an unrecognized flag"

case "$output" in
  *"Usage:"*)
    assert_eq "usage shown" "usage shown" "bootstrap.sh prints a usage message on an unrecognized flag, not a crash deep inside --install/--update logic"
    ;;
  *)
    assert_eq "usage shown" "unexpected output: $output" "bootstrap.sh prints a usage message on an unrecognized flag, not a crash deep inside --install/--update logic"
    ;;
esac

output=$(bash "$BOOTSTRAP_SH" --install 2>&1)
assert_status 1 $? "bootstrap.sh --install exits non-zero when not run as root"

case "$output" in
  *sudo*)
    assert_eq "mentions sudo" "mentions sudo" "bootstrap.sh tells the operator to use sudo when not run as root"
    ;;
  *)
    assert_eq "mentions sudo" "unexpected output: $output" "bootstrap.sh tells the operator to use sudo when not run as root"
    ;;
esac

grep -qF 'REPO_URL="https://github.com/turgaypek/aundekiosk.git"' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh clones from the correct GitHub repository"

grep -qF 'INSTALL_DIR="/opt/aundekiosk"' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh installs to /opt/aundekiosk, matching install.sh/update.sh/common.sh"

grep -qE 'git clone "\$REPO_URL" "\$INSTALL_DIR"' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh --install clones the repository before running install.sh"

grep -qF 'exec bash "$INSTALL_DIR/scripts/setup/install.sh"' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh --install runs install.sh after cloning"

grep -qF 'exec bash "$INSTALL_DIR/scripts/setup/update.sh"' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh --update runs update.sh"

grep -qE 'if \[ -d "\$INSTALL_DIR/\.git" \]' "$BOOTSTRAP_SH"
assert_status 0 $? "bootstrap.sh --install refuses to run (not re-clone over) an already-installed AundeKiosk"

assert_summary
