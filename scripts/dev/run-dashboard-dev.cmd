@echo off
rem Local dev server for dashboard/server.ts: HTTP (no TLS cert needed) with
rem auth/config/audit state isolated under .devdata/ (gitignored) instead of
rem the real /opt/aundekiosk/ paths used in production.
cd /d "%~dp0..\.."
if not exist ".devdata" mkdir ".devdata"
set "AUNDEKIOSK_ALLOW_HTTP=1"
set "AUNDEKIOSK_CONFIG_FILE=%CD:\=/%/.devdata/config.json"
set "AUNDEKIOSK_AUTH_STORE_FILE=%CD:\=/%/.devdata/auth.db"
set "AUNDEKIOSK_AUDIT_LOG_FILE=%CD:\=/%/.devdata/audit.log"
set "AUNDEKIOSK_MONITOR_CONFIG_FILE=%CD:\=/%/.devdata/monitor-config.json"
set "PORT=8080"
deno run --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/server.ts
