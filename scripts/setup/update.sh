#!/usr/bin/env bash
# Pulls the latest commits for an already-installed AundeKiosk (cloned
# directly into /opt/aundekiosk) and re-runs install.sh, which is safe
# to re-run: it never recreates the system user or overwrites an
# existing config.json/monitor-config.json, but it DOES refresh
# executable bits, the sudoers whitelist, systemd unit files, cached
# Deno dependencies, and (via install.sh's own restart, not start) the
# running dashboard/monitor services — so a plan's worth of changes
# actually takes effect, not just a `git pull`.
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

if [ "$EUID" -ne 0 ]; then
    msg "$ERROR" "update.sh must be run as root (sudo), same as install.sh."
    exit 1
fi

if [ ! -d "$AUNDEKIOSK_INSTALL_DIR/.git" ]; then
    msg "$ERROR" "$AUNDEKIOSK_INSTALL_DIR is not a git checkout; nothing to pull. Was AundeKiosk installed by cloning the repo directly into that path?"
    exit 1
fi

# Git's dubious-ownership check looks at the WORKING TREE root
# ($AUNDEKIOSK_INSTALL_DIR itself, deliberately owned by aundekiosk so
# the dashboard can write config.json), not just .git — without this,
# `git pull` as root refuses with "detected dubious ownership" even
# though .git itself stays root-owned (install.sh's own defense in
# depth against the dashboard user tampering with history/hooks).
git config --global --add safe.directory "$AUNDEKIOSK_INSTALL_DIR"

msg "$INFO" "Pulling the latest AundeKiosk commits..."
git -C "$AUNDEKIOSK_INSTALL_DIR" pull --ff-only

msg "$INFO" "Re-running install.sh to apply the update..."
exec bash "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/install.sh" "$@"
