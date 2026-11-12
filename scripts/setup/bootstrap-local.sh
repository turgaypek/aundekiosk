#!/usr/bin/env bash
# AundeKiosk — Local IIS Bootstrap
#
# Installs or updates AundeKiosk from the internal distribution server
# instead of GitHub.  Use this on networks where the Pi cannot reach
# the internet (or you prefer not to depend on GitHub).
#
# Usage:
#   curl http://192.168.6.80/aundekiosk-dist/bootstrap-local.sh | sudo bash -s -- --install
#   sudo bash /path/to/bootstrap-local.sh --update
#
# MUST run as root (sudo).
set -euo pipefail

DIST_URL="http://192.168.6.80/aundekiosk-dist"
INSTALL_DIR="/opt/aundekiosk"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

if [ "$EUID" -ne 0 ]; then
    error "This script must be run as root: sudo bash $0 $*"
fi

case "${1:-}" in
    --install)
        echo ""
        info "=== AundeKiosk Local Installation ==="
        info "Distribution server: $DIST_URL"
        info "Install directory:   $INSTALL_DIR"
        echo ""

        info "Downloading package..."
        mkdir -p "$INSTALL_DIR"
        if ! curl -fsSL --connect-timeout 30 "$DIST_URL/aundekiosk-latest.tar.gz" \
                | tar xz -C "$INSTALL_DIR"; then
            error "Download failed — is $DIST_URL reachable from this Pi?"
        fi

        # Show bundled version
        if [ -f "$INSTALL_DIR/VERSION" ]; then
            success "Package version: $(cat "$INSTALL_DIR/VERSION")"
        fi

        info "Running installer (LOCAL_INSTALL mode — no internet required for Deno)..."
        export LOCAL_INSTALL=1
        exec bash "$INSTALL_DIR/scripts/setup/install.sh"
        ;;

    --update)
        echo ""
        info "=== AundeKiosk Local Update ==="
        if [ ! -f "$INSTALL_DIR/scripts/setup/update.sh" ]; then
            error "$INSTALL_DIR/scripts/setup/update.sh not found — run --install first."
        fi
        export LOCAL_INSTALL=1
        exec bash "$INSTALL_DIR/scripts/setup/update.sh"
        ;;

    *)
        echo ""
        echo "Usage: sudo bash $0 --install | --update"
        echo ""
        echo "  --install   Fresh installation from $DIST_URL"
        echo "  --update    Update an existing local installation"
        echo ""
        echo "One-liner install:"
        echo "  curl $DIST_URL/bootstrap-local.sh | sudo bash -s -- --install"
        echo ""
        exit 1
        ;;
esac
