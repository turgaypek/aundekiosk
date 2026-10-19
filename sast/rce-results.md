# RCE Analysis Results: AundeKiosk

## Executive Summary
- Sinks analyzed: 2
- Vulnerable: 0
- Likely Vulnerable: 2
- Not Vulnerable: 0
- Needs Manual Review: 0

## Findings

### [LIKELY VULNERABLE] nmcli SSID injection via newline in apply-network-config.sh

- **File**: `privileged/apply-network-config.sh` (lines 148-155)
- **Endpoint / function**: POST /api/network/apply → `runPrivilegedCommand("sudo", [".../apply-network-config.sh"], JSON)` → apply-network-config.sh
- **Category**: OS Command Injection (nmcli interactive session injection)
- **Issue**: `WIFI_SSID` is extracted from user-supplied JSON via `jq -r '.wifiSsid'` and passed into an unquoted heredoc sent to `nmcli connection edit`. The validation function `is_valid_wifi_ssid` only checks byte length (1–32 characters). `is_safe_secret_value` (the newline/CR guard) is called on `WIFI_PASSWORD` but **not** on `WIFI_SSID`. A newline character in the SSID is one character long and passes the length check, then expands in the heredoc to inject additional nmcli interactive commands on the following lines.
- **Taint trace**:
  ```
  POST /api/network/apply (JSON body: {wifiSsid: "test\nnmcli_cmd"})
    → network_api.ts:validateNetworkPayload — checks ssid.length 1-32 chars, NO newline check
    → runPrivilegedApply(payload) → runPrivilegedCommand("sudo", [".../apply-network-config.sh"], JSON.stringify(payload))
    → apply-network-config.sh reads stdin JSON via jq
    → WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid')
    → is_valid_wifi_ssid "$WIFI_SSID"  ← only checks length, PASSES
    → (no is_safe_secret_value call)
    → heredoc expansion: set 802-11-wireless.ssid test\n<injected nmcli command>
    → nmcli connection edit receives injected command
  ```
- **Impact**: An authenticated admin can inject additional nmcli interactive commands into the nmcli session. Possible injected directives include: `set wifi-sec.key-mgmt none` (disable WiFi encryption), `set ipv4.method manual ipv4.addresses 0.0.0.0/0` (misconfigure network), or other `nmcli connection` properties. This allows an admin to apply network settings through the UI that the UI itself would not normally permit, and which bypass the TypeScript-level validation. Impact is constrained by what nmcli interactive mode accepts — no OS command execution beyond nmcli operations. Requires admin role + step-up password confirmation.
- **Remediation**: Add `is_safe_secret_value "$WIFI_SSID"` validation in `apply-network-config.sh` immediately after `is_valid_wifi_ssid`, mirroring the pattern already applied to `WIFI_PASSWORD`:
  ```bash
  is_valid_wifi_ssid "$WIFI_SSID" || { echo "Invalid WiFi SSID." >&2; exit 1; }
  is_safe_secret_value "$WIFI_SSID" || { echo "WiFi SSID must not contain a newline." >&2; exit 1; }
  ```
  Also add SSID newline validation in `network_api.ts`'s `validateNetworkPayload` for defense-in-depth:
  ```typescript
  if (ssid.includes('\n') || ssid.includes('\r')) {
    return "wifiSsid must not contain newline characters.";
  }
  ```
- **Dynamic Test**:
  ```bash
  # Requires valid admin session cookie. Inject a newline into the SSID to
  # send an extra nmcli command (here: disable WiFi security as a PoC).
  # Note: JSON \n is a literal newline in the string value.
  curl -k -b "aundekiosk_session=<ADMIN_SESSION>" \
    -H "Content-Type: application/json" \
    -d '{"interface":"wlan0","mode":"dhcp","wifiSsid":"test\nset wifi-sec.key-mgmt none","wifiPassword":"validpass123","confirmPassword":"<ADMIN_PASSWORD>"}' \
    https://192.168.14.128:8080/api/network/apply
  # Expected if vulnerable: nmcli processes "set wifi-sec.key-mgmt none" as a
  # second command, disabling WiFi encryption regardless of wifiPassword value.
  # Verify by checking: nmcli connection show <connection-id> | grep key-mgmt
  ```

---

### [LIKELY VULNERABLE] nmcli SSID injection in rollback-network.sh (second-order)

- **File**: `privileged/rollback-network.sh` (lines 51-57)
- **Endpoint / function**: systemd transient timer (scheduled by apply-network-config.sh; fires if network config is not confirmed within 60s)
- **Category**: OS Command Injection (nmcli interactive session injection — second order)
- **Issue**: `rollback-network.sh` reads `WIFI_SSID` from the root-owned backup file `/etc/aundekiosk-priv/network-backup.json`. This backup stores the nmcli-reported values of the **previous** connection — specifically `nmcli -g 802-11-wireless.ssid connection show "$CONNECTION_ID"`. In the normal rollback path, the SSID in the backup came from the real, pre-change NetworkManager state and is unlikely to contain newlines. However, `rollback-network.sh` has the same missing `is_safe_secret_value` guard as `apply-network-config.sh`. If a malicious SSID was successfully applied (via the sink in finding #1) and then the rollback timer fires, the backup file may contain the injected SSID, which would then be re-injected through the rollback heredoc.
- **Taint trace**:
  ```
  (Prior apply ran with SSID containing "\n")
    → apply-network-config.sh backed up the CURRENT settings (before change) — backup is safe in this path
    → BUT: apply-network-config.sh reads current WIFI_SSID from nmcli output into backup
    → If the CURRENT WiFi profile already had an injected SSID in NM (from a prior successful inject):
    → backup file contains SSID with newline
    → rollback-network.sh reads WIFI_SSID from backup without is_safe_secret_value
    → heredoc expands the newline → nmcli injection in rollback
  ```
- **Concern**: Even without the first-order exploit, the absence of the guard in rollback means the same class of bug exists in both scripts and should be fixed together. In practice, the backup contains the pre-change SSID (from nmcli output), so this becomes exploitable only if a malicious SSID was previously stored in NetworkManager — which the first-order exploit enables.
- **Remediation**: Add the same `is_safe_secret_value` guard in `rollback-network.sh` for `WIFI_SSID`:
  ```bash
  WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid // ""')
  # ADD:
  if [[ -n "$WIFI_SSID" ]]; then
    is_safe_secret_value "$WIFI_SSID" || { echo "Backup SSID contains an unsafe character; refusing to roll back WiFi settings." >&2; WIFI_SSID=""; INTERFACE_SKIP_WIFI=1; }
  fi
  ```
- **Dynamic Test**:
  ```bash
  # Prerequisite: trigger the first-order finding to apply an SSID with "\n"
  # into NetworkManager. Then wait for the 60s rollback timer to fire.
  # Check nmcli for unexpected property changes introduced by rollback heredoc.
  sudo journalctl -u aundekiosk-network-rollback.service --no-pager | tail -20
  nmcli connection show <connection-id> | grep -E 'key-mgmt|ssid'
  ```
