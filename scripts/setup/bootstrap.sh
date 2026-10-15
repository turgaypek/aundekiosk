#!/usr/bin/env bash
# Public one-line entry point for a brand-new Pi:
#   curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --install
#   curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --update
#   curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --uninstall
# All the real work happens in install.sh/update.sh/uninstall.sh;
# this only clones the repo once and hands off.
set -euo pipefail

INSTALL_DIR="/opt/aundekiosk"
REPO_URL="https://github.com/turgaypek/aundekiosk.git"

usage() {
    echo "Usage: bootstrap.sh --install | --update | --uninstall" >&2
    exit 1
}

[ "$#" -eq 1 ] || usage

case "$1" in
    --install|--update|--uninstall) ;;
    *) usage ;;
esac

if [ "$EUID" -ne 0 ]; then
    echo "bootstrap.sh must be run as root: sudo bash -s -- $1" >&2
    exit 1
fi

case "$1" in
    --install)
        if [ -d "$INSTALL_DIR/.git" ]; then
            echo "AundeKiosk is already installed at $INSTALL_DIR — use --update instead." >&2
            exit 1
        fi
        git clone "$REPO_URL" "$INSTALL_DIR"
        exec bash "$INSTALL_DIR/scripts/setup/install.sh"
        ;;
    --update)
        exec bash "$INSTALL_DIR/scripts/setup/update.sh"
        ;;
    --uninstall)
        if [ ! -d "$INSTALL_DIR/.git" ]; then
            echo "AundeKiosk is not installed at $INSTALL_DIR — nothing to remove." >&2
            exit 1
        fi
        exec bash "$INSTALL_DIR/scripts/setup/uninstall.sh"
        ;;
esac
