#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="${1:?Usage: generate-tls-cert.sh <cert_dir>}"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  echo "TLS certificate already exists at $CERT_DIR, leaving it in place."
  exit 0
fi

mkdir -p "$CERT_DIR"

# MSYS2_ARG_CONV_EXCL is a no-op on Linux (the real target). On a Windows/Git
# Bash dev machine, MSYS otherwise rewrites "/CN=aundekiosk" into a bogus
# Windows path (e.g. "C:/Program Files/Git/CN=aundekiosk") before openssl
# ever sees it, because it looks like an absolute POSIX path.
MSYS2_ARG_CONV_EXCL="/CN=" openssl req -x509 -newkey rsa:2048 -days 825 -nodes \
  -subj "/CN=aundekiosk" \
  -keyout "$KEY_FILE" -out "$CERT_FILE" 2>/dev/null

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"
echo "Generated a new self-signed TLS certificate at $CERT_DIR."
