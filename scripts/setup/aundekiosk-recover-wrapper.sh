#!/usr/bin/env bash
# Standalone recovery tool for AundeKiosk's dashboard credentials.
# Never installed as a systemd service — run this manually (as root,
# e.g. "sudo aundekiosk-recover") only when nobody can log into the
# dashboard at all. Binds to 127.0.0.1 only: open it from the Pi's own
# browser, or via an SSH port-forward
# (ssh -L 8099:localhost:8099 pi@<this-pi>).
#
# auth.db is owned by the unprivileged 'aundekiosk' user, mode 0600 —
# running this without root/sudo fails with a plain permission error
# from Deno itself, which is enforcement enough; this script adds none
# of its own.
set -euo pipefail

export DENO_DIR="/opt/aundekiosk/.deno"
exec deno run \
    --cached-only \
    --lock=/opt/aundekiosk/dashboard/deno.lock \
    --allow-net=127.0.0.1:8099 \
    --allow-read=/opt/aundekiosk \
    --allow-write=/opt/aundekiosk \
    /opt/aundekiosk/recovery/server.ts
