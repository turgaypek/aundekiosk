#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
FAIL=0

for t in \
  "$SCRIPT_DIR/platform/lib_test.sh" \
  "$SCRIPT_DIR/runtime/runner_test.sh" \
  "$SCRIPT_DIR/runtime/switcher_test.sh" \
  "$SCRIPT_DIR/privileged/restart_kiosk_services_test.sh" \
  "$SCRIPT_DIR/privileged/sudoers_test.sh" \
  "$SCRIPT_DIR/services/templates_test.sh" \
  "$SCRIPT_DIR/setup/install_test.sh" \
  "$SCRIPT_DIR/setup/generate_tls_cert_test.sh"; do
  echo "=== $t ==="
  bash "$t" || FAIL=1
  echo ""
done

if [[ "$FAIL" -eq 0 ]]; then
  echo "All bash test suites passed."
else
  echo "One or more bash test suites failed."
fi

exit $FAIL
