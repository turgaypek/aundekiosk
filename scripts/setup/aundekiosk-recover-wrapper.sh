#!/usr/bin/env bash
# Standalone recovery tool for AundeKiosk's dashboard credentials.
# Never installed as a systemd service — run this manually (as root,
# e.g. "sudo aundekiosk-recover") only when nobody can log into the
# dashboard at all. Binds to 127.0.0.1 only: open it from the Pi's own
# browser, or via an SSH port-forward
# (ssh -L 8099:localhost:8099 pi@<this-pi>).
#
# Requires root only to switch to the aundekiosk user below — the
# server itself then runs as aundekiosk, same as the dashboard, so a
# recovery write can never leave auth.db/audit.log root-owned (which
# would lock the dashboard out of its own files right after a recovery)
# and so a dashboard-level compromise that edits dashboard/ code (which
# this server imports) can never escalate to root just because an
# admin later runs this tool (final review: Critical C1/C2).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "aundekiosk-recover must be run as root: sudo aundekiosk-recover" >&2
    exit 1
fi

exec runuser -u aundekiosk -- env DENO_DIR="/opt/aundekiosk/.deno" deno run \
    --cached-only \
    --lock=/opt/aundekiosk/dashboard/deno.lock \
    --allow-net=127.0.0.1:8099 \
    --allow-read=/opt/aundekiosk \
    --allow-write=/opt/aundekiosk \
    /opt/aundekiosk/recovery/server.ts
