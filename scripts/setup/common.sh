#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "This script should be sourced, not executed." >&2
    exit 1
fi

readonly AUNDEKIOSK_INSTALL_DIR="/opt/aundekiosk"
readonly AUNDEKIOSK_CONFIG_FILE="$AUNDEKIOSK_INSTALL_DIR/config.json"

# Root-owned, mode 0700, and deliberately OUTSIDE $AUNDEKIOSK_INSTALL_DIR
# (which the dashboard's unprivileged user owns in full). Anything a
# privileged helper trusts without re-validating it against dashboard
# input — the one username change-os-password.sh is allowed to target,
# the network-config backup a rollback restores from — must live here,
# never under the dashboard-owned tree, or a compromised dashboard could
# rewrite it and walk straight through the restriction it's meant to
# enforce (final review: Critical C2).
readonly AUNDEKIOSK_PRIV_DIR="/etc/aundekiosk-priv"

RESET='\033[0m'
ERROR='\033[1;31m'
SUCCESS='\033[1;32m'
WARNING='\033[1;33m'
INFO='\033[1;34m'
CALLOUT='\033[1;35m'
DEBUG='\033[1;36m'

msg() {
    local color="$1"
    local text="$2"
    echo -e "${color}${text}${RESET}"
}
