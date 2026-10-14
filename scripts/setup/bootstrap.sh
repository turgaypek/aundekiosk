#!/usr/bin/env bash
# Public one-line entry point for a brand-new Pi, mirroring xiosk's own
# curl | bash UX:
#   curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --install
#   curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --update
# Only two modes exist — AundeKiosk has no backup/cleanup equivalent of
# xiosk's --backup/--cleanup (yet). All the real work still happens in
# install.sh/update.sh; this only clones the repo once and hands off.
set -euo pipefail

INSTALL_DIR="/opt/aundekiosk"
REPO_URL="https://github.com/turgaypek/aundekiosk.git"

usage() {
    echo "Usage: bootstrap.sh --install | --update" >&2
    exit 1
}

[ "$#" -eq 1 ] || usage

case "$1" in
    --install|--update) ;;
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
esac
