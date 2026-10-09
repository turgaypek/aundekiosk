#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "This script should be sourced, not executed." >&2
    exit 1
fi

readonly AUNDEKIOSK_INSTALL_DIR="/opt/aundekiosk"
readonly AUNDEKIOSK_CONFIG_FILE="$AUNDEKIOSK_INSTALL_DIR/config.json"

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
