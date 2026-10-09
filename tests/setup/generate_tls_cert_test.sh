#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

GENERATOR="$SCRIPT_DIR/../../scripts/setup/generate-tls-cert.sh"
WORKDIR=$(mktemp -d)
CERT_DIR="$WORKDIR/tls"

bash "$GENERATOR" "$CERT_DIR" > "$WORKDIR/output1.txt" 2>&1
assert_status 0 $? "generate-tls-cert.sh exits 0 on first run"

[[ -f "$CERT_DIR/cert.pem" ]]
assert_status 0 $? "generate-tls-cert.sh creates cert.pem"

[[ -f "$CERT_DIR/key.pem" ]]
assert_status 0 $? "generate-tls-cert.sh creates key.pem"

first_cert_contents=$(cat "$CERT_DIR/cert.pem")

bash "$GENERATOR" "$CERT_DIR" > "$WORKDIR/output2.txt" 2>&1
assert_status 0 $? "generate-tls-cert.sh exits 0 on second run"

second_cert_contents=$(cat "$CERT_DIR/cert.pem")
assert_eq "$first_cert_contents" "$second_cert_contents" "generate-tls-cert.sh does not regenerate an existing certificate (idempotent)"

rm -rf "$WORKDIR"
assert_summary
