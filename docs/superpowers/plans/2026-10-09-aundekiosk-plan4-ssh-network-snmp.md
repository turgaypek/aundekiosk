# AundeKiosk Plan 4 — SSH / Ağ / SNMP Modülü — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The last of the four planned subsystems: SSH enable/disable + password-auth hardening, OS account password change, NetworkManager-based IP/WiFi configuration with an auto-rollback safety net, and SNMPv3-only monitoring access — all behind Plan 2's session auth, with SSH/OS-password/network/SNMP changes additionally requiring **step-up** re-authentication (spec §6), and every privileged action still running only through Plan 1's sudoers-whitelisted helper pattern.

**Architecture:** One new shared bash validation library (`privileged/lib.sh`) holds every pure input-format check (interface names, IPv4/CIDR, WiFi SSID/password length, SNMP protocol/username shape) used by the new privileged helpers — same role as `platform/lib.sh` (Plan 1) and `monitor/lib.sh` (Plan 3). Secrets (WiFi password, the new OS password, SNMP passphrases) are **never** passed as command-line arguments to a privileged helper — argv is visible to every local user via `ps`. They go over **stdin as JSON** instead, which only the dashboard process and the helper it spawns ever see. One new shared dashboard module, `dashboard/auth/require_step_up.ts`, wraps Plan 2's `createStepUpGuard` into the one check every new high-risk endpoint performs before doing anything privileged.

**Tech Stack:** Bash (new privileged helpers + `privileged/lib.sh`) + `jq` (stdin JSON parsing) + `nmcli` (NetworkManager, Bookworm's default) + `systemd-run` (kernel-level rollback timer, survives a dashboard crash) + `chpasswd`/`systemctl`, unchanged from Plan 1. Deno/TypeScript for the four new dashboard endpoints, unchanged from Plan 1/2/3.

**Spec:** [docs/superpowers/specs/2026-10-09-aundekiosk-design.md](../specs/2026-10-09-aundekiosk-design.md) (section 8, plus section 6's step-up rule and section 3's OS-password-change goal)

**Scope note (confirmed with the human partner):** like Plan 3's `/monitor-config`, every endpoint in this plan ships as an authenticated JSON API only — no dashboard UI form. The human partner confirmed the API is sufficient for this phase.

## Global Constraints

- Every new endpoint requires a valid Plan 2 session (`authApi.requireSession`) before anything else runs. (Spec §5.1, inherited)
- SSH toggling and OS account password change require **step-up** re-authentication (the current dashboard password, re-entered) even with a valid session. (Spec §6, §8.1)
- `change-os-password.sh` may only ever change the password of the **single** username recorded at install time — never an arbitrary username the dashboard (or a bug, or a compromise) supplies. (Spec §5.1's least-privilege principle, applied)
- Network changes are applied with **NetworkManager (`nmcli`)**, never by editing `dhcpcd.conf`. (Spec §8.2)
- A network config change schedules an **automatic rollback** to the previous settings unless explicitly confirmed within the window; the rollback is a kernel-level `systemd-run` timer, not an in-process timeout, so it survives a dashboard crash or restart. (Spec §8.2)
- SNMP supports **only SNMPv3**; v1/v2c (plaintext community strings) are never offered or accepted. (Spec §8.3)
- Dashboard-supplied data is never interpolated into a shell string; every privileged helper validates its input with a fixed regex/enum and passes parameters as a shell array, never via `eval`. (Spec §5.1, §8.4)
- Secrets (WiFi password, the new OS password, SNMP auth/priv passphrases) are passed to privileged helpers over **stdin**, never as command-line arguments. (New constraint this plan introduces, consistent with §8.4's spirit — argv is visible to any local user via `ps`, stdin is not)

## Review Focus

- SSH toggling and OS password change never succeed without a correct, freshly-submitted current dashboard password — even from an already-logged-in session. A missing or wrong `confirmPassword` is rejected before any privileged helper runs — Task 3, Task 5.
- `change-os-password.sh` refuses to act on any username other than the single one recorded at install time, even if asked to — Task 4.
- Applying a network config always schedules a rollback; the backup file written before applying captures the *previous* working settings, not the new ones — Task 6.
- SNMP configuration rejects anything shaped like v1/v2c (a bare community string with no SNMPv3 fields) and any auth/priv protocol outside the allowed set — Task 8.
- All five new endpoints (`/ssh-config`, `/os-password`, `/network-config`, `/network-confirm`, `/snmp-config`) return 401 with no session, before step-up or any privileged logic ever runs — Task 3, 5, 7, 9.

---

### Task 1: Shared Privileged-Script Validation Library (`privileged/lib.sh`)

**Files:**
- Create: `privileged/lib.sh`
- Test: `tests/privileged/lib_test.sh`

**Interfaces:**
- Produces: `is_valid_interface(value)`, `is_valid_network_mode(value)`, `is_valid_ipv4(value)`, `is_valid_cidr(value)`, `is_valid_wifi_ssid(value)`, `is_valid_wifi_password(value)`, `is_valid_snmp_username(value)`, `is_valid_snmp_auth_protocol(value)`, `is_valid_snmp_priv_protocol(value)` — all exit-status predicates (0 = valid)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/privileged/lib_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"
source "$SCRIPT_DIR/../../privileged/lib.sh"

# --- is_valid_interface ---
for good in eth0 wlan0; do
  if is_valid_interface "$good"; then
    assert_eq "valid" "valid" "is_valid_interface accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_interface accepts '$good'"
  fi
done
if is_valid_interface "eth1"; then
  assert_eq "invalid" "valid" "is_valid_interface rejects an interface outside eth0/wlan0"
else
  assert_eq "invalid" "invalid" "is_valid_interface rejects an interface outside eth0/wlan0"
fi

# --- is_valid_network_mode ---
for good in dhcp static; do
  if is_valid_network_mode "$good"; then
    assert_eq "valid" "valid" "is_valid_network_mode accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_network_mode accepts '$good'"
  fi
done
if is_valid_network_mode "bridge"; then
  assert_eq "invalid" "valid" "is_valid_network_mode rejects an unknown mode"
else
  assert_eq "invalid" "invalid" "is_valid_network_mode rejects an unknown mode"
fi

# --- is_valid_ipv4 ---
for good in "192.168.1.1" "255.255.255.255" "0.0.0.0"; do
  if is_valid_ipv4 "$good"; then
    assert_eq "valid" "valid" "is_valid_ipv4 accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_ipv4 accepts '$good'"
  fi
done
for bad in "999.1.1.1" "1.2.3" "1.2.3.4.5" "abc.1.1.1" "192.168.1.1; rm -rf /"; do
  if is_valid_ipv4 "$bad"; then
    assert_eq "invalid" "valid" "is_valid_ipv4 rejects '$bad'"
  else
    assert_eq "invalid" "invalid" "is_valid_ipv4 rejects '$bad'"
  fi
done

# --- is_valid_cidr ---
for good in "192.168.1.0/24" "10.0.0.1/32"; do
  if is_valid_cidr "$good"; then
    assert_eq "valid" "valid" "is_valid_cidr accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_cidr accepts '$good'"
  fi
done
for bad in "10.0.0.1/33" "999.1.1.1/24" "192.168.1.0"; do
  if is_valid_cidr "$bad"; then
    assert_eq "invalid" "valid" "is_valid_cidr rejects '$bad'"
  else
    assert_eq "invalid" "invalid" "is_valid_cidr rejects '$bad'"
  fi
done

# --- is_valid_wifi_ssid ---
if is_valid_wifi_ssid "MyNetwork"; then
  assert_eq "valid" "valid" "is_valid_wifi_ssid accepts a normal SSID"
else
  assert_eq "valid" "invalid" "is_valid_wifi_ssid accepts a normal SSID"
fi
if is_valid_wifi_ssid ""; then
  assert_eq "invalid" "valid" "is_valid_wifi_ssid rejects an empty SSID"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_ssid rejects an empty SSID"
fi
TOO_LONG_SSID=$(printf 'a%.0s' $(seq 1 33))
if is_valid_wifi_ssid "$TOO_LONG_SSID"; then
  assert_eq "invalid" "valid" "is_valid_wifi_ssid rejects an SSID over 32 characters"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_ssid rejects an SSID over 32 characters"
fi

# --- is_valid_wifi_password ---
if is_valid_wifi_password "longenough1"; then
  assert_eq "valid" "valid" "is_valid_wifi_password accepts an 11-character password (WPA2 minimum is 8)"
else
  assert_eq "valid" "invalid" "is_valid_wifi_password accepts an 11-character password (WPA2 minimum is 8)"
fi
if is_valid_wifi_password "short12"; then
  assert_eq "invalid" "valid" "is_valid_wifi_password rejects a 7-character password (below WPA2's 8-char minimum)"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_password rejects a 7-character password (below WPA2's 8-char minimum)"
fi
TOO_LONG_PASSWORD=$(printf 'a%.0s' $(seq 1 64))
if is_valid_wifi_password "$TOO_LONG_PASSWORD"; then
  assert_eq "invalid" "valid" "is_valid_wifi_password rejects a password over 63 characters (WPA2/3's maximum)"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_password rejects a password over 63 characters (WPA2/3's maximum)"
fi

# --- is_valid_snmp_username ---
if is_valid_snmp_username "monitor_user-1"; then
  assert_eq "valid" "valid" "is_valid_snmp_username accepts alphanumerics, underscore and hyphen"
else
  assert_eq "valid" "invalid" "is_valid_snmp_username accepts alphanumerics, underscore and hyphen"
fi
if is_valid_snmp_username "bad user"; then
  assert_eq "invalid" "valid" "is_valid_snmp_username rejects a space"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_username rejects a space"
fi
if is_valid_snmp_username ""; then
  assert_eq "invalid" "valid" "is_valid_snmp_username rejects an empty username"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_username rejects an empty username"
fi

# --- is_valid_snmp_auth_protocol / is_valid_snmp_priv_protocol ---
for good in SHA SHA-256; do
  if is_valid_snmp_auth_protocol "$good"; then
    assert_eq "valid" "valid" "is_valid_snmp_auth_protocol accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_snmp_auth_protocol accepts '$good'"
  fi
done
if is_valid_snmp_auth_protocol "MD5"; then
  assert_eq "invalid" "valid" "is_valid_snmp_auth_protocol rejects MD5 (not in the allowed set)"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_auth_protocol rejects MD5 (not in the allowed set)"
fi
if is_valid_snmp_priv_protocol "AES"; then
  assert_eq "valid" "valid" "is_valid_snmp_priv_protocol accepts AES"
else
  assert_eq "valid" "invalid" "is_valid_snmp_priv_protocol accepts AES"
fi
if is_valid_snmp_priv_protocol "DES"; then
  assert_eq "invalid" "valid" "is_valid_snmp_priv_protocol rejects DES (not in the allowed set)"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_priv_protocol rejects DES (not in the allowed set)"
fi

assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/lib_test.sh`
Expected: `privileged/lib.sh` henüz yok olduğu için `source` satırında hata, script sıfır olmayan kodla çıkar.

- [ ] **Step 3: `privileged/lib.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Pure, side-effect-free input validators shared by every SSH/network/SNMP
# privileged helper. Every helper that reads dashboard-supplied data
# validates it with one of these before ever using it in an nmcli/systemctl
# call — never eval, never a shell-interpolated string (spec §5.1, §8.4).

is_valid_interface() {
  [[ "$1" == "eth0" || "$1" == "wlan0" ]]
}

is_valid_network_mode() {
  [[ "$1" == "dhcp" || "$1" == "static" ]]
}

is_valid_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local IFS='.'
  local octets=($ip)
  for octet in "${octets[@]}"; do
    [[ "$octet" -le 255 ]] || return 1
  done
  return 0
}

is_valid_cidr() {
  local cidr="$1"
  [[ "$cidr" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local ip="${BASH_REMATCH[1]}"
  local prefix="${BASH_REMATCH[2]}"
  is_valid_ipv4 "$ip" || return 1
  [[ "$prefix" -ge 0 && "$prefix" -le 32 ]]
}

# IEEE 802.11 allows an SSID of 1-32 bytes.
is_valid_wifi_ssid() {
  local ssid="$1"
  local len=${#ssid}
  [[ "$len" -ge 1 && "$len" -le 32 ]]
}

# WPA2/WPA3-PSK passphrases are 8-63 characters.
is_valid_wifi_password() {
  local password="$1"
  local len=${#password}
  [[ "$len" -ge 8 && "$len" -le 63 ]]
}

is_valid_snmp_username() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{1,32}$ ]]
}

is_valid_snmp_auth_protocol() {
  [[ "$1" == "SHA" || "$1" == "SHA-256" ]]
}

is_valid_snmp_priv_protocol() {
  [[ "$1" == "AES" ]]
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/lib_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add privileged/lib.sh tests/privileged/lib_test.sh
git commit -m "feat: add shared validation library for SSH/network/SNMP helpers"
```

---

### Task 2: SSH Privileged Helpers

**Files:**
- Create: `privileged/toggle-ssh.sh`
- Create: `privileged/toggle-ssh-password-auth.sh`
- Test: `tests/privileged/toggle_ssh_test.sh`
- Test: `tests/privileged/toggle_ssh_password_auth_test.sh`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Produces: `privileged/toggle-ssh.sh enable|disable`, `privileged/toggle-ssh-password-auth.sh enable|disable` (exactly one argument, rejects anything else)

Bu iki script, Plan 1/3'ün argümansız helper'larından farklı olarak **tam olarak bir argüman** alıyor (`enable` veya `disable`). Bu yüzden sudoers whitelist deseni de farklı: path + wildcard değil, path + **her bir izinli argüman için ayrı bir satır** — bu, script'in kendi `$1` kontrolünden önce, sudo'nun kendisi sadece bu iki tam çağrıya izin vermesini sağlar (Plan 2'nin incelemesinde bulunan "sudoers argümansız bırakılırsa herhangi bir argüman kabul edilir" bulgusuna karşı, buradaki tasarım daha sıkı).

- [ ] **Step 1: Başarısız olacak testleri yaz**

`tests/privileged/toggle_ssh_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/toggle-ssh.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"

bash "$HELPER" enable
assert_status 0 $? "toggle-ssh.sh enable exits 0"
grep -q "enable --now ssh" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-ssh.sh enable calls systemctl enable --now ssh"

rm -f "$WORKDIR/systemctl.log"
bash "$HELPER" disable
assert_status 0 $? "toggle-ssh.sh disable exits 0"
grep -q "disable --now ssh" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-ssh.sh disable calls systemctl disable --now ssh"

bash "$HELPER" "start-everything" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "toggle-ssh.sh rejects any argument other than enable/disable"

bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "toggle-ssh.sh rejects a missing argument"

rm -rf "$WORKDIR"
assert_summary
```

`tests/privileged/toggle_ssh_password_auth_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/toggle-ssh-password-auth.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"
export AUNDEKIOSK_SSHD_DROPIN_FILE="$WORKDIR/aundekiosk-password-auth.conf"

bash "$HELPER" disable
assert_status 0 $? "toggle-ssh-password-auth.sh disable exits 0"
grep -q "^PasswordAuthentication no$" "$WORKDIR/aundekiosk-password-auth.conf"
assert_status 0 $? "toggle-ssh-password-auth.sh disable writes PasswordAuthentication no"

bash "$HELPER" enable
assert_status 0 $? "toggle-ssh-password-auth.sh enable exits 0"
grep -q "^PasswordAuthentication yes$" "$WORKDIR/aundekiosk-password-auth.conf"
assert_status 0 $? "toggle-ssh-password-auth.sh enable writes PasswordAuthentication yes"

bash "$HELPER" "maybe" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "toggle-ssh-password-auth.sh rejects any argument other than enable/disable"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/toggle_ssh_test.sh && bash tests/privileged/toggle_ssh_password_auth_test.sh`
Expected: Her ikisi de henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `privileged/toggle-ssh.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: enables or disables the SSH service. Takes exactly
# one argument — "enable" or "disable" — and the sudoers whitelist grants
# NOPASSWD on each exact invocation separately, so sudo itself (not just
# this script) rejects anything else.
set -euo pipefail

ACTION="${1:?Usage: toggle-ssh.sh enable|disable}"

if [[ "$ACTION" != "enable" && "$ACTION" != "disable" ]]; then
  echo "Invalid action '$ACTION'. Use 'enable' or 'disable'." >&2
  exit 1
fi

if [[ "$ACTION" == "enable" ]]; then
  exec systemctl enable --now ssh
else
  exec systemctl disable --now ssh
fi
```

- [ ] **Step 4: `privileged/toggle-ssh-password-auth.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: toggles SSH password authentication on or off via a
# drop-in file (never edits the main sshd_config directly, so this can't
# corrupt an unrelated setting). "Şifre ile girişi kapat, sadece SSH key"
# per spec §8.1.
set -euo pipefail

ACTION="${1:?Usage: toggle-ssh-password-auth.sh enable|disable}"

if [[ "$ACTION" != "enable" && "$ACTION" != "disable" ]]; then
  echo "Invalid action '$ACTION'. Use 'enable' or 'disable'." >&2
  exit 1
fi

DROPIN_FILE="${AUNDEKIOSK_SSHD_DROPIN_FILE:-/etc/ssh/sshd_config.d/aundekiosk-password-auth.conf}"

if [[ "$ACTION" == "enable" ]]; then
  echo "PasswordAuthentication yes" > "$DROPIN_FILE"
else
  echo "PasswordAuthentication no" > "$DROPIN_FILE"
fi

systemctl reload ssh 2>/dev/null || systemctl restart ssh
```

- [ ] **Step 5: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/toggle_ssh_test.sh && bash tests/privileged/toggle_ssh_password_auth_test.sh`
Expected: Her ikisi de tüm satırlar `ok -`, `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add privileged/toggle-ssh.sh privileged/toggle-ssh-password-auth.sh tests/privileged/toggle_ssh_test.sh tests/privileged/toggle_ssh_password_auth_test.sh
git commit -m "feat: add SSH enable/disable and password-auth privileged helpers"
```

- [ ] **Step 7: Sudoers whitelist'ine satırları ve testlerini ekle**

`privileged/sudoers.d/aundekiosk`'a ekle (mevcut satırların altına):

```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh enable
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh disable
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh enable
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh disable
```

`tests/privileged/sudoers_test.sh`'a ekle:

```bash

for line in \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh enable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh disable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh enable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh disable"; do
  grep -qF "$line" "$SUDOERS_FILE"
  assert_status 0 $? "sudoers file grants the exact line: $line"
done
```

- [ ] **Step 8: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`
Expected: `visudo` bu makinede yok, o satır `SKIP` ile atlanır; diğer kontroller (artık 7 adet) `ok -` ile geçer.

- [ ] **Step 9: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: whitelist the SSH toggle helpers' exact invocations"
```

---

### Task 3: SSH Dashboard API (Step-Up Korumalı)

**Files:**
- Create: `dashboard/auth/require_step_up.ts`
- Test: `dashboard/auth/require_step_up_test.ts`
- Create: `dashboard/ssh_api.ts`
- Test: `dashboard/ssh_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Consumes: `dashboard/auth/step_up.ts` → `createStepUpGuard` (Plan 2)
- Produces: `requireStepUp(stepUpGuard, username, confirmPassword, ip): Promise<{ok: true} | {ok: false; status: number; message: string}>`; `createSshApi(opts): { handleStatus(): Promise<Response>; handleToggle(req, username, ip): Promise<Response>; handleToggleCurlPasswordAuth(req, username, ip): Promise<Response> }`

- [ ] **Step 1: `require_step_up.ts` için başarısız olacak testi yaz**

`dashboard/auth/require_step_up_test.ts`:

```typescript
import { createCredentialStore } from "./credential_store.ts";
import { createAuditLog } from "./audit_log.ts";
import { createStepUpGuard } from "./step_up.ts";
import { requireStepUp } from "./require_step_up.ts";
import { assertEquals } from "../test_util.ts";

async function withGuard(fn: (guard: ReturnType<typeof createStepUpGuard>) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const guard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    await fn(guard);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("requireStepUp passes with the correct current password", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", "a-long-enough-password", "203.0.113.1");
    assertEquals(result.ok, true);
  });
});

Deno.test("requireStepUp fails with status 403 for a wrong password", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", "wrong-password", "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 403);
  });
});

Deno.test("requireStepUp fails with status 400 when confirmPassword is missing", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", undefined, "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 400);
  });
});

Deno.test("requireStepUp fails with status 423 once the account is locked", async () => {
  await withGuard(async (guard) => {
    for (let i = 0; i < 5; i++) {
      await requireStepUp(guard, "admin", "wrong-password", "203.0.113.1");
    }
    const result = await requireStepUp(guard, "admin", "a-long-enough-password", "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 423);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/require_step_up_test.ts`
Expected: `require_step_up.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/require_step_up.ts`'i yaz**

```typescript
import type { createStepUpGuard } from "./step_up.ts";

export type StepUpCheckResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

// Every high-risk endpoint in Plan 4 (SSH toggle, OS password change,
// network config, SNMP config) performs exactly this check before doing
// anything privileged — re-verifying the CURRENT dashboard password even
// though the caller already holds a valid session (spec §6).
export async function requireStepUp(
  stepUpGuard: ReturnType<typeof createStepUpGuard>,
  username: string,
  confirmPassword: unknown,
  ip: string,
): Promise<StepUpCheckResult> {
  if (typeof confirmPassword !== "string" || confirmPassword.length === 0) {
    return { ok: false, status: 400, message: "confirmPassword is required." };
  }

  const result = await stepUpGuard.verify(username, confirmPassword, ip);

  if (result.outcome === "success") {
    return { ok: true };
  }
  if (result.outcome === "locked") {
    return { ok: false, status: 423, message: "Account locked. Try again later." };
  }
  return { ok: false, status: 403, message: "Current password is incorrect." };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/require_step_up_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/require_step_up.ts dashboard/auth/require_step_up_test.ts
git commit -m "feat: add the shared step-up check every high-risk endpoint uses"
```

- [ ] **Step 6: `ssh_api.ts` için başarısız olacak testi yaz**

`dashboard/ssh_api_test.ts`:

```typescript
import { createSshApi } from "./ssh_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createSshApi>, dir: string, record: () => string[]) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const calls: string[] = [];
    const api = createSshApi({
      stepUpGuard,
      runPrivilegedToggle: async (action: string) => {
        calls.push(action);
      },
    });
    await fn(api, dir, () => calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/ssh-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleToggle with the correct confirmPassword invokes the privileged toggle", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "enable", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls(), ["enable"]);
  });
});

Deno.test("handleToggle with a wrong confirmPassword returns 403 and never invokes the privileged toggle", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "enable", confirmPassword: "wrong-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle with a missing confirmPassword returns 400 and never invokes the privileged toggle", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(jsonRequest({ action: "enable" }), "admin", "203.0.113.1");
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle rejects an action outside enable/disable", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "destroy", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});
```

- [ ] **Step 7: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/ssh_api_test.ts`
Expected: `ssh_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 8: `dashboard/ssh_api.ts`'i yaz**

```typescript
import type { createStepUpGuard } from "./auth/step_up.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

export interface SshApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Injected so the API logic is testable without ever shelling out to a
  // real privileged helper; server.ts supplies the real sudo-based caller.
  runPrivilegedToggle: (action: "enable" | "disable") => Promise<void>;
}

export function createSshApi(opts: SshApiOptions) {
  const { stepUpGuard, runPrivilegedToggle } = opts;

  async function handleToggle(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { action, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (action !== "enable" && action !== "disable") {
      return new Response("action must be 'enable' or 'disable'.", { status: 400 });
    }

    await runPrivilegedToggle(action);
    return new Response(`SSH ${action}d.`, { status: 200 });
  }

  return { handleToggle };
}
```

- [ ] **Step 9: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/ssh_api_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 10: Commit**

```bash
git add dashboard/ssh_api.ts dashboard/ssh_api_test.ts
git commit -m "feat: add the step-up-protected SSH toggle API"
```

- [ ] **Step 11: `server.ts`'e `/ssh-config` rotasını ekle (başarısız test önce)**

`dashboard/server_test.ts`'e ekle:

```typescript
Deno.test("POST /ssh-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/ssh-config", { method: "POST", body: JSON.stringify({ action: "enable" }) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: `/ssh-config` henüz yönlendirilmediği için static handler'a düşer ve 404 döner, test 401 beklediği için başarısız olur.

- [ ] **Step 12: `dashboard/server.ts`'i güncelle**

```typescript
import { createSshApi } from "./ssh_api.ts";
```

satırını ekle. `createHandler`'ın içine, `authApi` tanımının altına:

```typescript
  const sshApi = createSshApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedToggle: async (action) => {
      const command = new Deno.Command("sudo", { args: [`/opt/aundekiosk/privileged/toggle-ssh.sh`, action] });
      const { code, stderr } = await command.output();
      if (code !== 0) {
        throw new Error(`toggle-ssh.sh ${action} failed: ${new TextDecoder().decode(stderr)}`);
      }
    },
  });
```

`import { createStepUpGuard } from "./auth/step_up.ts";` satırını da import'lara ekle (henüz yoksa).

`/monitor-config` bloğunun altına:

```typescript
    if (url.pathname === "/ssh-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return sshApi.handleToggle(req, session.username, ip);
    }
```

- [ ] **Step 13: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: Tüm testler PASS.

- [ ] **Step 14: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: wire /ssh-config behind session + step-up auth"
```

---

### Task 4: OS Hesabı Şifre Değişimi — Privileged Helper

**Files:**
- Create: `privileged/change-os-password.sh`
- Test: `tests/privileged/change_os_password_test.sh`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Produces: `privileged/change-os-password.sh` (argümansız; `{ "username": string, "newPassword": string }` JSON'unu **stdin**'den okur — asla argv'de değil, çünkü argv `ps` ile her yerel kullanıcıya görünür)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/privileged/change_os_password_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/change-os-password.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/chpasswd" <<'EOF'
#!/usr/bin/env bash
cat >> "$AUNDEKIOSK_TEST_CHPASSWD_LOG"
EOF
chmod +x "$FAKE_BIN/chpasswd"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_CHPASSWD_LOG="$WORKDIR/chpasswd.log"
echo "pi" > "$WORKDIR/pi-user.txt"
export AUNDEKIOSK_PI_USER_FILE="$WORKDIR/pi-user.txt"

echo '{"username":"pi","newPassword":"a-long-enough-password"}' | bash "$HELPER"
assert_status 0 $? "change-os-password.sh exits 0 for the allowed user with a long enough password"
grep -q "^pi:a-long-enough-password$" "$WORKDIR/chpasswd.log"
assert_status 0 $? "change-os-password.sh pipes 'username:password' to chpasswd"

rm -f "$WORKDIR/chpasswd.log"
echo '{"username":"root","newPassword":"a-long-enough-password"}' | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a username other than the one recorded at install time"
[[ ! -f "$WORKDIR/chpasswd.log" ]]
assert_status 0 $? "change-os-password.sh never calls chpasswd for a disallowed username"

echo '{"username":"pi","newPassword":"short"}' | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "change-os-password.sh refuses a password shorter than 12 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "change-os-password.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/change_os_password_test.sh`
Expected: script henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `privileged/change-os-password.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: changes the OS account password for the ONE username
# recorded at install time (AUNDEKIOSK_PI_USER_FILE) — never an arbitrary
# username, even if asked to. The new password arrives over stdin as JSON,
# never as a command-line argument (argv is visible to any local user via
# `ps`; stdin is not).
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; the username/password are read from stdin as JSON." >&2
  exit 1
fi

ALLOWED_USER_FILE="${AUNDEKIOSK_PI_USER_FILE:-/opt/aundekiosk/pi-user.txt}"

if [[ ! -f "$ALLOWED_USER_FILE" ]]; then
  echo "No target user recorded at $ALLOWED_USER_FILE; cannot change a password." >&2
  exit 1
fi

ALLOWED_USER=$(cat "$ALLOWED_USER_FILE")

PAYLOAD=$(cat)
USERNAME=$(echo "$PAYLOAD" | jq -r '.username')
NEW_PASSWORD=$(echo "$PAYLOAD" | jq -r '.newPassword')

if [[ "$USERNAME" != "$ALLOWED_USER" ]]; then
  echo "This helper can only change the password for '$ALLOWED_USER', not '$USERNAME'." >&2
  exit 1
fi

if [[ "${#NEW_PASSWORD}" -lt 12 ]]; then
  echo "New password must be at least 12 characters." >&2
  exit 1
fi

echo "${USERNAME}:${NEW_PASSWORD}" | chpasswd
echo "Password changed for ${USERNAME}."
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/change_os_password_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add privileged/change-os-password.sh tests/privileged/change_os_password_test.sh
git commit -m "feat: add the OS account password-change privileged helper"
```

- [ ] **Step 6: Sudoers'a ekle**

`privileged/sudoers.d/aundekiosk`'a ekle:

```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/change-os-password.sh
```

`tests/privileged/sudoers_test.sh`'a ekle:

```bash

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/change-os-password.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the change-os-password.sh line"
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`

- [ ] **Step 8: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: whitelist change-os-password.sh in the sudoers file"
```

---

### Task 5: OS Hesabı Şifre Değişimi — Dashboard API

**Files:**
- Create: `dashboard/os_password_api.ts`
- Test: `dashboard/os_password_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Consumes: `dashboard/auth/require_step_up.ts` → `requireStepUp`
- Produces: `createOsPasswordApi(opts): { handleChange(req, username, ip): Promise<Response> }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/os_password_api_test.ts`:

```typescript
import { createOsPasswordApi } from "./os_password_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createOsPasswordApi>, record: () => string[]) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const calls: string[] = [];
    const api = createOsPasswordApi({
      stepUpGuard,
      runPrivilegedChange: async (newPassword: string) => {
        calls.push(newPassword);
      },
    });
    await fn(api, () => calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/os-password", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleChange with the right confirmPassword and a long enough new password succeeds", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-new-long-enough-password", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls(), ["a-new-long-enough-password"]);
  });
});

Deno.test("handleChange rejects a wrong confirmPassword and never invokes the privileged change", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-new-long-enough-password", confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange rejects a new password shorter than 12 characters", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "short", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/os_password_api_test.ts`
Expected: `os_password_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/os_password_api.ts`'i yaz**

```typescript
import type { createStepUpGuard } from "./auth/step_up.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const MIN_OS_PASSWORD_LENGTH = 12;

export interface OsPasswordApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Injected for testability — server.ts supplies the real sudo-based
  // caller, which pipes { username, newPassword } to change-os-password.sh
  // over stdin (never as a command-line argument).
  runPrivilegedChange: (newPassword: string) => Promise<void>;
}

export function createOsPasswordApi(opts: OsPasswordApiOptions) {
  const { stepUpGuard, runPrivilegedChange } = opts;

  async function handleChange(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { newPassword, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (typeof newPassword !== "string" || newPassword.length < MIN_OS_PASSWORD_LENGTH) {
      return new Response(`newPassword must be at least ${MIN_OS_PASSWORD_LENGTH} characters.`, { status: 400 });
    }

    await runPrivilegedChange(newPassword);
    return new Response("OS account password changed.", { status: 200 });
  }

  return { handleChange };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/os_password_api_test.ts`
Expected: 3 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/os_password_api.ts dashboard/os_password_api_test.ts
git commit -m "feat: add the step-up-protected OS password change API"
```

- [ ] **Step 6: `server.ts`'e `/os-password` rotasını ekle**

`dashboard/server_test.ts`'e ekle:

```typescript
Deno.test("POST /os-password without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/os-password", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

Run (başarısız olduğunu doğrulamak için): `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`

`dashboard/server.ts`'e ekle: `import { createOsPasswordApi } from "./os_password_api.ts";`, `authApi`'nin altına:

```typescript
  const osPasswordApi = createOsPasswordApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedChange: async (newPassword) => {
      const piUser = Deno.env.get("AUNDEKIOSK_PI_USER") ?? "pi";
      const command = new Deno.Command("sudo", {
        args: ["/opt/aundekiosk/privileged/change-os-password.sh"],
        stdin: "piped",
      });
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify({ username: piUser, newPassword })));
      await writer.close();
      const { code, stderr } = await child.output();
      if (code !== 0) {
        throw new Error(`change-os-password.sh failed: ${new TextDecoder().decode(stderr)}`);
      }
    },
  });
```

`/ssh-config` bloğunun altına:

```typescript
    if (url.pathname === "/os-password" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return osPasswordApi.handleChange(req, session.username, ip);
    }
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: Tüm testler PASS.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: wire /os-password behind session + step-up auth"
```

---

### Task 6: Ağ Yapılandırması — Privileged Helper'lar

**Files:**
- Create: `privileged/apply-network-config.sh`
- Create: `privileged/confirm-network-config.sh`
- Create: `privileged/rollback-network.sh`
- Test: `tests/privileged/network_config_test.sh`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Consumes: `privileged/lib.sh` → `is_valid_interface`, `is_valid_network_mode`, `is_valid_cidr`, `is_valid_ipv4`, `is_valid_wifi_ssid`, `is_valid_wifi_password`
- Produces: `privileged/apply-network-config.sh` (argümansız; config JSON'u stdin'den okur, önceki ayarları yedekler, uygular, 60s sonra otomatik geri alma zamanlar); `privileged/confirm-network-config.sh` (argümansız; bekleyen geri almayı iptal eder); `privileged/rollback-network.sh` (argümansız; yedekten geri yükler)

**Not:** Bu görevin gerçek `nmcli`/`systemd-run` çağrıları (Plan 1/3'teki `chromium`/`systemctl` çağrıları gibi) bu makinede çalıştırılamaz/test edilemez — spec §11'e göre gerçek Pi donanımında manuel QA gerektirir. Test kapsamı, stdin JSON'unun **doğrulama mantığına** odaklanır (geçersiz girdi asla `nmcli`'ye ulaşmamalı).

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/privileged/network_config_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/apply-network-config.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/nmcli" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_NMCLI_LOG"
# Fake enough output for the backup step's `nmcli -g ... connection show` reads.
if [[ "$1" == "-g" ]]; then echo ""; fi
EOF
chmod +x "$FAKE_BIN/nmcli"

cat > "$FAKE_BIN/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG"
EOF
chmod +x "$FAKE_BIN/systemd-run"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_NMCLI_LOG="$WORKDIR/nmcli.log"
export AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG="$WORKDIR/systemd-run.log"
export AUNDEKIOSK_NETWORK_BACKUP_FILE="$WORKDIR/network-backup.json"

echo '{"interface":"eth0","mode":"static","staticIp":"192.168.1.50/24","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}' \
  | bash "$HELPER"
assert_status 0 $? "apply-network-config.sh exits 0 for a valid static eth0 config"
grep -q "192.168.1.50/24" "$WORKDIR/nmcli.log"
assert_status 0 $? "apply-network-config.sh passes the validated static IP to nmcli"
[[ -f "$WORKDIR/network-backup.json" ]]
assert_status 0 $? "apply-network-config.sh writes a backup file before applying the new config"
grep -q "aundekiosk-network-rollback" "$WORKDIR/systemd-run.log"
assert_status 0 $? "apply-network-config.sh schedules the rollback timer"

rm -f "$WORKDIR/nmcli.log" "$WORKDIR/network-backup.json"
echo '{"interface":"eth0","mode":"static","staticIp":"not-an-ip","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}' \
  | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects an invalid static IP"
[[ ! -f "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "apply-network-config.sh never calls nmcli when validation fails"

echo '{"interface":"wlan0","mode":"dhcp","staticIp":null,"gateway":null,"dns":null,"wifiSsid":"MyNet","wifiPassword":"short"}' \
  | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects a WiFi password shorter than 8 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/network_config_test.sh`
Expected: script henüz yok, başarısız olur.

- [ ] **Step 3: `privileged/apply-network-config.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: applies a new network configuration via NetworkManager
# (nmcli — Bookworm's default, never dhcpcd.conf), after backing up the
# CURRENT settings and scheduling an automatic rollback (spec §8.2). The
# config arrives over stdin as JSON, never as command-line arguments —
# the WiFi password especially must never appear in `ps` output.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; configuration is read from stdin as JSON." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/opt/aundekiosk/network-backup.json}"
ROLLBACK_UNIT="aundekiosk-network-rollback"
ROLLBACK_SCRIPT="${AUNDEKIOSK_ROLLBACK_SCRIPT:-/opt/aundekiosk/privileged/rollback-network.sh}"
ROLLBACK_DELAY_SECONDS="${AUNDEKIOSK_ROLLBACK_DELAY_SECONDS:-60}"

PAYLOAD=$(cat)
INTERFACE=$(echo "$PAYLOAD" | jq -r '.interface')
MODE=$(echo "$PAYLOAD" | jq -r '.mode')
STATIC_IP=$(echo "$PAYLOAD" | jq -r '.staticIp // ""')
GATEWAY=$(echo "$PAYLOAD" | jq -r '.gateway // ""')
DNS=$(echo "$PAYLOAD" | jq -r '.dns // ""')
WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid // ""')
WIFI_PASSWORD=$(echo "$PAYLOAD" | jq -r '.wifiPassword // ""')

is_valid_interface "$INTERFACE" || { echo "Invalid interface '$INTERFACE'." >&2; exit 1; }
is_valid_network_mode "$MODE" || { echo "Invalid mode '$MODE'." >&2; exit 1; }

if [[ "$MODE" == "static" ]]; then
  is_valid_cidr "$STATIC_IP" || { echo "Invalid static IP/CIDR '$STATIC_IP'." >&2; exit 1; }
  is_valid_ipv4 "$GATEWAY" || { echo "Invalid gateway '$GATEWAY'." >&2; exit 1; }
  is_valid_ipv4 "$DNS" || { echo "Invalid DNS '$DNS'." >&2; exit 1; }
fi

if [[ "$INTERFACE" == "wlan0" ]]; then
  is_valid_wifi_ssid "$WIFI_SSID" || { echo "Invalid WiFi SSID." >&2; exit 1; }
  is_valid_wifi_password "$WIFI_PASSWORD" || { echo "Invalid WiFi password (must be 8-63 characters)." >&2; exit 1; }
fi

# Back up the CURRENT settings before changing anything — this is what
# rollback-network.sh restores if the new config is never confirmed.
CURRENT_MODE=$(nmcli -g ipv4.method connection show "$INTERFACE" 2>/dev/null || echo "auto")
CURRENT_IP=$(nmcli -g ipv4.addresses connection show "$INTERFACE" 2>/dev/null || echo "")
CURRENT_GATEWAY=$(nmcli -g ipv4.gateway connection show "$INTERFACE" 2>/dev/null || echo "")
CURRENT_DNS=$(nmcli -g ipv4.dns connection show "$INTERFACE" 2>/dev/null || echo "")

jq -n \
  --arg interface "$INTERFACE" \
  --arg mode "$CURRENT_MODE" \
  --arg staticIp "$CURRENT_IP" \
  --arg gateway "$CURRENT_GATEWAY" \
  --arg dns "$CURRENT_DNS" \
  '{interface: $interface, mode: $mode, staticIp: $staticIp, gateway: $gateway, dns: $dns}' \
  > "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

# Apply the new settings as an nmcli argument array — never a shell-
# interpolated string — so none of these validated-but-still-dashboard-
# supplied values can be read as an extra nmcli flag.
if [[ "$MODE" == "dhcp" ]]; then
  nmcli connection modify "$INTERFACE" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$INTERFACE" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi

if [[ "$INTERFACE" == "wlan0" ]]; then
  nmcli connection modify "$INTERFACE" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WIFI_PASSWORD" 802-11-wireless.ssid "$WIFI_SSID"
fi

nmcli connection up "$INTERFACE"

# Kernel-level timer (not an in-process JS timeout) so the rollback still
# fires even if the dashboard process crashes or restarts in the meantime.
systemd-run --unit="$ROLLBACK_UNIT" --on-active="${ROLLBACK_DELAY_SECONDS}s" "$ROLLBACK_SCRIPT"

echo "Network configuration applied to $INTERFACE. Automatic rollback scheduled in ${ROLLBACK_DELAY_SECONDS}s unless confirmed."
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/network_config_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`.

- [ ] **Step 5: `privileged/confirm-network-config.sh` ve `privileged/rollback-network.sh`'ı yaz**

`privileged/confirm-network-config.sh`:

```bash
#!/usr/bin/env bash
# Privileged helper: cancels the pending automatic network rollback
# (spec §8.2's "onayla" action). Argument-free.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

ROLLBACK_UNIT="aundekiosk-network-rollback"

systemctl stop "${ROLLBACK_UNIT}.timer" 2>/dev/null || true
echo "Pending network rollback cancelled (if any); configuration confirmed."
```

`privileged/rollback-network.sh`:

```bash
#!/usr/bin/env bash
# Privileged helper: restores the network settings apply-network-config.sh
# backed up before its last change. This is what the scheduled
# systemd-run timer calls if the change is never confirmed in time
# (spec §8.2). Argument-free — it only ever reads its own backup file.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/opt/aundekiosk/network-backup.json}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "No network backup found; nothing to roll back." >&2
  exit 0
fi

PAYLOAD=$(cat "$BACKUP_FILE")
INTERFACE=$(echo "$PAYLOAD" | jq -r '.interface')
MODE=$(echo "$PAYLOAD" | jq -r '.mode')
STATIC_IP=$(echo "$PAYLOAD" | jq -r '.staticIp')
GATEWAY=$(echo "$PAYLOAD" | jq -r '.gateway')
DNS=$(echo "$PAYLOAD" | jq -r '.dns')

if [[ "$MODE" == "auto" || "$MODE" == "dhcp" || -z "$STATIC_IP" ]]; then
  nmcli connection modify "$INTERFACE" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$INTERFACE" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi
nmcli connection up "$INTERFACE"

rm -f "$BACKUP_FILE"
echo "Network configuration rolled back to the previous settings on $INTERFACE."
```

- [ ] **Step 6: Söz dizimini doğrula**

Run: `bash -n privileged/confirm-network-config.sh && bash -n privileged/rollback-network.sh`
Expected: Çıktı yok, exit code 0. (Gerçek `nmcli`/`systemctl` çağrıları spec §11'e göre gerçek donanımda doğrulanır.)

- [ ] **Step 7: Commit**

```bash
git add privileged/apply-network-config.sh privileged/confirm-network-config.sh privileged/rollback-network.sh tests/privileged/network_config_test.sh
git commit -m "feat: add network config apply/confirm/rollback privileged helpers"
```

- [ ] **Step 8: Sudoers'a ekle**

`privileged/sudoers.d/aundekiosk`'a ekle:

```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/apply-network-config.sh
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/confirm-network-config.sh
```

(`rollback-network.sh`'a dashboard'dan sudo ile erişilmez — sadece `apply-network-config.sh`'ın kendisinin root olarak zamanladığı `systemd-run` çağırır; bu yüzden ayrıca whitelist'e girmesi gerekmiyor.)

`tests/privileged/sudoers_test.sh`'a ekle:

```bash

for line in \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/apply-network-config.sh" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/confirm-network-config.sh"; do
  grep -qF "$line" "$SUDOERS_FILE"
  assert_status 0 $? "sudoers file grants the exact line: $line"
done
```

- [ ] **Step 9: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`

- [ ] **Step 10: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: whitelist the network config apply/confirm helpers"
```

---

### Task 7: Ağ Yapılandırması — Dashboard API

**Files:**
- Create: `dashboard/network_api.ts`
- Test: `dashboard/network_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Produces: `createNetworkApi(opts): { handleApply(req, username, ip): Promise<Response>; handleConfirm(req, username, ip): Promise<Response> }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/network_api_test.ts`:

```typescript
import { createNetworkApi } from "./network_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createNetworkApi>,
    applyCalls: () => unknown[],
    confirmCalls: () => number,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const applyCalls: unknown[] = [];
    let confirmCalls = 0;
    const api = createNetworkApi({
      stepUpGuard,
      runPrivilegedApply: async (payload: unknown) => {
        applyCalls.push(payload);
      },
      runPrivilegedConfirm: async () => {
        confirmCalls++;
      },
    });
    await fn(api, () => applyCalls, () => confirmCalls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_NETWORK_CONFIG = {
  interface: "eth0",
  mode: "static",
  staticIp: "192.168.1.50/24",
  gateway: "192.168.1.1",
  dns: "8.8.8.8",
  wifiSsid: null,
  wifiPassword: null,
};

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleApply with a valid config and correct confirmPassword invokes the privileged apply", async () => {
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", { ...VALID_NETWORK_CONFIG, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(applyCalls().length, 1);
  });
});

Deno.test("handleApply with a wrong confirmPassword returns 403 and never invokes the privileged apply", async () => {
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", { ...VALID_NETWORK_CONFIG, confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(applyCalls().length, 0);
  });
});

Deno.test("handleApply rejects an invalid interface before step-up even matters", async () => {
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", {
        ...VALID_NETWORK_CONFIG,
        interface: "eth99",
        confirmPassword: "a-long-enough-password",
      }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(applyCalls().length, 0);
  });
});

Deno.test("handleConfirm with the correct confirmPassword invokes the privileged confirm", async () => {
  await withApi(async (api, _applyCalls, confirmCalls) => {
    const res = await api.handleConfirm(
      jsonRequest("/network-confirm", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(confirmCalls(), 1);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/network_api_test.ts`
Expected: `network_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/network_api.ts`'i yaz**

```typescript
import type { createStepUpGuard } from "./auth/step_up.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const VALID_INTERFACES = new Set(["eth0", "wlan0"]);
const VALID_MODES = new Set(["dhcp", "static"]);
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_PATTERN = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

interface NetworkConfigPayload {
  interface: string;
  mode: string;
  staticIp: string | null;
  gateway: string | null;
  dns: string | null;
  wifiSsid: string | null;
  wifiPassword: string | null;
}

function isValidOctetString(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  const ipPart = value.split("/")[0];
  return ipPart.split(".").every((octet) => Number(octet) <= 255);
}

function validateNetworkPayload(body: Record<string, unknown>): string | null {
  const iface = body.interface;
  const mode = body.mode;
  if (typeof iface !== "string" || !VALID_INTERFACES.has(iface)) {
    return "interface must be 'eth0' or 'wlan0'.";
  }
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    return "mode must be 'dhcp' or 'static'.";
  }
  if (mode === "static") {
    const staticIp = body.staticIp;
    const gateway = body.gateway;
    const dns = body.dns;
    if (typeof staticIp !== "string" || !isValidOctetString(staticIp, CIDR_PATTERN)) {
      return "staticIp must be a valid CIDR address.";
    }
    if (typeof gateway !== "string" || !isValidOctetString(gateway, IPV4_PATTERN)) {
      return "gateway must be a valid IPv4 address.";
    }
    if (typeof dns !== "string" || !isValidOctetString(dns, IPV4_PATTERN)) {
      return "dns must be a valid IPv4 address.";
    }
  }
  if (iface === "wlan0") {
    const ssid = body.wifiSsid;
    const password = body.wifiPassword;
    if (typeof ssid !== "string" || ssid.length < 1 || ssid.length > 32) {
      return "wifiSsid must be 1-32 characters.";
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 63) {
      return "wifiPassword must be 8-63 characters.";
    }
  }
  return null;
}

export interface NetworkApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Both injected for testability; server.ts supplies real sudo-based
  // callers. runPrivilegedApply pipes the validated payload to
  // apply-network-config.sh over stdin as JSON.
  runPrivilegedApply: (payload: NetworkConfigPayload) => Promise<void>;
  runPrivilegedConfirm: () => Promise<void>;
}

export function createNetworkApi(opts: NetworkApiOptions) {
  const { stepUpGuard, runPrivilegedApply, runPrivilegedConfirm } = opts;

  async function handleApply(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const validationError = validateNetworkPayload(record);
    if (validationError) {
      return new Response(validationError, { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, record.confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    await runPrivilegedApply({
      interface: record.interface as string,
      mode: record.mode as string,
      staticIp: (record.staticIp as string | null) ?? null,
      gateway: (record.gateway as string | null) ?? null,
      dns: (record.dns as string | null) ?? null,
      wifiSsid: (record.wifiSsid as string | null) ?? null,
      wifiPassword: (record.wifiPassword as string | null) ?? null,
    });

    return new Response(
      "Network configuration applied. It will automatically revert in 60 seconds unless you confirm access.",
      { status: 200 },
    );
  }

  async function handleConfirm(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    await runPrivilegedConfirm();
    return new Response("Network configuration confirmed.", { status: 200 });
  }

  return { handleApply, handleConfirm };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/network_api_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/network_api.ts dashboard/network_api_test.ts
git commit -m "feat: add the step-up-protected network config apply/confirm API"
```

- [ ] **Step 6: `server.ts`'e `/network-config` ve `/network-confirm` rotalarını ekle**

`dashboard/server_test.ts`'e ekle:

```typescript
Deno.test("POST /network-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/network-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /network-confirm without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/network-confirm", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

`dashboard/server.ts`'e ekle: `import { createNetworkApi } from "./network_api.ts";`, `osPasswordApi`'nin altına:

```typescript
  const networkApi = createNetworkApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedApply: async (payload) => {
      const command = new Deno.Command("sudo", {
        args: ["/opt/aundekiosk/privileged/apply-network-config.sh"],
        stdin: "piped",
      });
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
      await writer.close();
      const { code, stderr } = await child.output();
      if (code !== 0) {
        throw new Error(`apply-network-config.sh failed: ${new TextDecoder().decode(stderr)}`);
      }
    },
    runPrivilegedConfirm: async () => {
      const command = new Deno.Command("sudo", { args: ["/opt/aundekiosk/privileged/confirm-network-config.sh"] });
      const { code, stderr } = await command.output();
      if (code !== 0) {
        throw new Error(`confirm-network-config.sh failed: ${new TextDecoder().decode(stderr)}`);
      }
    },
  });
```

`/os-password` bloğunun altına:

```typescript
    if (url.pathname === "/network-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return networkApi.handleApply(req, session.username, ip);
    }

    if (url.pathname === "/network-confirm" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return networkApi.handleConfirm(req, session.username, ip);
    }
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: Tüm testler PASS.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: wire /network-config and /network-confirm behind session + step-up"
```

---

### Task 8: SNMPv3 Yapılandırması — Privileged Helper

**Files:**
- Create: `privileged/configure-snmp.sh`
- Test: `tests/privileged/configure_snmp_test.sh`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Consumes: `privileged/lib.sh` → `is_valid_snmp_username`, `is_valid_snmp_auth_protocol`, `is_valid_snmp_priv_protocol`, `is_valid_cidr`, `is_valid_ipv4`
- Produces: `privileged/configure-snmp.sh` (argümansız; `{ "enabled": boolean, "username", "authProtocol", "authPassphrase", "privProtocol", "privPassphrase", "allowedSource" }` JSON'unu stdin'den okur)

**Açık risk (spec §12 ile aynı ruhta, bu planda netleştirilecek):** net-snmp'nin SNMPv3 kullanıcıları için config dosyası konumu (`createUser` satırları geleneksel olarak `/var/lib/snmp/snmpd.conf`'a, `rouser`/`agentAddress` ise `/etc/snmp/snmpd.conf`'a yazılır) ve kaynak-IP kısıtlamasının tam mekanizması (SNMPv3'ün VACM modeli, v1/v2c'nin `rocommunity <string> <subnet>` kadar basit bir "kaynak alt ağ" parametresine sahip değil) gerçek donanımda doğrulanmadan %100 kesin değildir. Bu script, bilinen en iyi pratiği uygular (kaynak kısıtlaması için `iptables`), ama spec §11 gereği gerçek Pi'de `snmpwalk` ile test edilmelidir.

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/privileged/configure_snmp_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/configure-snmp.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

for cmd in systemctl iptables; do
  cat > "$FAKE_BIN/$cmd" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "\$AUNDEKIOSK_TEST_${cmd^^}_LOG"
EOF
  chmod +x "$FAKE_BIN/$cmd"
done

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"
export AUNDEKIOSK_TEST_IPTABLES_LOG="$WORKDIR/iptables.log"
export AUNDEKIOSK_SNMPD_CONF="$WORKDIR/snmpd.conf"
export AUNDEKIOSK_SNMPD_USER_CONF="$WORKDIR/snmpd-user.conf"

VALID_PAYLOAD='{"enabled":true,"username":"monitor_user","authProtocol":"SHA-256","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'

echo "$VALID_PAYLOAD" | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh exits 0 for a valid SNMPv3-only payload"
grep -q "createUser monitor_user SHA-256" "$WORKDIR/snmpd-user.conf"
assert_status 0 $? "configure-snmp.sh writes a createUser line with the chosen protocols"
grep -q "^rouser monitor_user priv$" "$WORKDIR/snmpd.conf"
assert_status 0 $? "configure-snmp.sh grants read-only access to the SNMPv3 user only"
grep -qE "(rocommunity|com2sec)" "$WORKDIR/snmpd.conf"
if [[ $? -eq 0 ]]; then
  assert_eq "no-v1v2c" "has-v1v2c" "configure-snmp.sh never writes a v1/v2c community-string directive"
else
  assert_eq "no-v1v2c" "no-v1v2c" "configure-snmp.sh never writes a v1/v2c community-string directive"
fi
grep -q "192.168.1.0/24" "$WORKDIR/iptables.log"
assert_status 0 $? "configure-snmp.sh restricts UDP 161 to the allowed source via a firewall rule"

rm -f "$WORKDIR/snmpd.conf" "$WORKDIR/snmpd-user.conf"
BAD_PROTOCOL='{"enabled":true,"username":"monitor_user","authProtocol":"MD5","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$BAD_PROTOCOL" | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth protocol outside SHA/SHA-256 (e.g. MD5)"
[[ ! -f "$WORKDIR/snmpd.conf" ]]
assert_status 0 $? "configure-snmp.sh never writes snmpd.conf when validation fails"

SHORT_PASSPHRASE='{"enabled":true,"username":"monitor_user","authProtocol":"SHA","authPassphrase":"short","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$SHORT_PASSPHRASE" | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth passphrase shorter than 8 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects any command-line argument (data comes from stdin only)"

rm -f "$WORKDIR/systemctl.log"
echo '{"enabled":false}' | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh disabled:true path exits 0"
grep -q "disable --now snmpd" "$WORKDIR/systemctl.log"
assert_status 0 $? "configure-snmp.sh stops and disables snmpd when enabled:false"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/configure_snmp_test.sh`
Expected: script henüz yok, başarısız olur.

- [ ] **Step 3: `privileged/configure-snmp.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: configures net-snmp for SNMPv3-only access (spec
# §8.3 — v1/v2c community strings are never written). Credentials arrive
# over stdin as JSON, never as command-line arguments.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; configuration is read from stdin as JSON." >&2
  exit 1
fi

SNMPD_CONF="${AUNDEKIOSK_SNMPD_CONF:-/etc/snmp/snmpd.conf}"
# net-snmp expects createUser directives in its persistent state directory,
# not the main config file — it rewrites this file at runtime, replacing
# the plaintext passphrase with a derived key after first use.
SNMPD_USER_CONF="${AUNDEKIOSK_SNMPD_USER_CONF:-/var/lib/snmp/snmpd.conf}"

PAYLOAD=$(cat)
ENABLED=$(echo "$PAYLOAD" | jq -r '.enabled')

if [[ "$ENABLED" == "false" ]]; then
  systemctl disable --now snmpd
  echo "SNMP disabled."
  exit 0
fi

USERNAME=$(echo "$PAYLOAD" | jq -r '.username')
AUTH_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.authProtocol')
AUTH_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.authPassphrase')
PRIV_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.privProtocol')
PRIV_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.privPassphrase')
ALLOWED_SOURCE=$(echo "$PAYLOAD" | jq -r '.allowedSource')

is_valid_snmp_username "$USERNAME" || { echo "Invalid SNMP username." >&2; exit 1; }
is_valid_snmp_auth_protocol "$AUTH_PROTOCOL" || { echo "Invalid auth protocol (use SHA or SHA-256)." >&2; exit 1; }
is_valid_snmp_priv_protocol "$PRIV_PROTOCOL" || { echo "Invalid priv protocol (use AES)." >&2; exit 1; }
[[ "${#AUTH_PASSPHRASE}" -ge 8 ]] || { echo "Auth passphrase must be at least 8 characters." >&2; exit 1; }
[[ "${#PRIV_PASSPHRASE}" -ge 8 ]] || { echo "Priv passphrase must be at least 8 characters." >&2; exit 1; }
if ! is_valid_cidr "$ALLOWED_SOURCE" && ! is_valid_ipv4 "$ALLOWED_SOURCE"; then
  echo "Invalid allowedSource (must be an IPv4 address or CIDR)." >&2
  exit 1
fi

cat > "$SNMPD_USER_CONF" <<EOF_USER
createUser ${USERNAME} ${AUTH_PROTOCOL} '${AUTH_PASSPHRASE}' ${PRIV_PROTOCOL} '${PRIV_PASSPHRASE}'
EOF_USER
chmod 600 "$SNMPD_USER_CONF"

# SNMPv3 only: rouser + agentAddress, no com2sec/rocommunity line anywhere
# — those are the v1/v2c community-string directives spec §8.3 forbids.
cat > "$SNMPD_CONF" <<EOF_CONF
rouser ${USERNAME} priv
agentAddress udp:161
EOF_CONF

# SNMPv3's access model has no "restrict this user to this subnet"
# directive the way v1/v2c community strings do — the standard answer is
# a firewall rule. Replace any prior AundeKiosk-managed rule before adding
# the new one, so repeated configuration doesn't accumulate stale rules.
iptables -D INPUT -p udp --dport 161 -s "$ALLOWED_SOURCE" -j ACCEPT 2>/dev/null || true
iptables -D INPUT -p udp --dport 161 -j DROP 2>/dev/null || true
iptables -I INPUT -p udp --dport 161 -s "$ALLOWED_SOURCE" -j ACCEPT
iptables -A INPUT -p udp --dport 161 -j DROP

systemctl enable --now snmpd
systemctl restart snmpd
echo "SNMPv3 configured for user '${USERNAME}', restricted to ${ALLOWED_SOURCE}."
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/configure_snmp_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add privileged/configure-snmp.sh tests/privileged/configure_snmp_test.sh
git commit -m "feat: add the SNMPv3-only configuration privileged helper"
```

- [ ] **Step 6: Sudoers'a ekle**

`privileged/sudoers.d/aundekiosk`'a ekle:

```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/configure-snmp.sh
```

`tests/privileged/sudoers_test.sh`'a ekle:

```bash

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/configure-snmp.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the configure-snmp.sh line"
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`

- [ ] **Step 8: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: whitelist configure-snmp.sh in the sudoers file"
```

---

### Task 9: SNMPv3 Yapılandırması — Dashboard API

**Files:**
- Create: `dashboard/snmp_api.ts`
- Test: `dashboard/snmp_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Produces: `createSnmpApi(opts): { handleConfigure(req, username, ip): Promise<Response> }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/snmp_api_test.ts`:

```typescript
import { createSnmpApi } from "./snmp_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(fn: (api: ReturnType<typeof createSnmpApi>, calls: () => unknown[]) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const calls: unknown[] = [];
    const api = createSnmpApi({
      stepUpGuard,
      runPrivilegedConfigure: async (payload: unknown) => {
        calls.push(payload);
      },
    });
    await fn(api, () => calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_SNMP_CONFIG = {
  enabled: true,
  username: "monitor_user",
  authProtocol: "SHA-256",
  authPassphrase: "a-long-enough-auth-pass",
  privProtocol: "AES",
  privPassphrase: "a-long-enough-priv-pass",
  allowedSource: "192.168.1.0/24",
};

function jsonRequest(body: unknown) {
  return new Request("http://localhost/snmp-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleConfigure with a valid SNMPv3 config and correct confirmPassword succeeds", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls().length, 1);
  });
});

Deno.test("handleConfigure rejects an auth protocol outside SHA/SHA-256", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, authProtocol: "MD5", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleConfigure rejects a wrong confirmPassword and never invokes the privileged configure", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleConfigure accepts enabled:false without requiring the SNMPv3 fields", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ enabled: false, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls().length, 1);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/snmp_api_test.ts`
Expected: `snmp_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/snmp_api.ts`'i yaz**

```typescript
import type { createStepUpGuard } from "./auth/step_up.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const VALID_AUTH_PROTOCOLS = new Set(["SHA", "SHA-256"]);
const VALID_PRIV_PROTOCOLS = new Set(["AES"]);
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_PASSPHRASE_LENGTH = 8;

function validateSnmpPayload(body: Record<string, unknown>): string | null {
  if (body.enabled === false) return null;

  const username = body.username;
  const authProtocol = body.authProtocol;
  const authPassphrase = body.authPassphrase;
  const privProtocol = body.privProtocol;
  const privPassphrase = body.privPassphrase;
  const allowedSource = body.allowedSource;

  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    return "username must be 1-32 alphanumeric/underscore/hyphen characters.";
  }
  if (typeof authProtocol !== "string" || !VALID_AUTH_PROTOCOLS.has(authProtocol)) {
    return "authProtocol must be 'SHA' or 'SHA-256'.";
  }
  if (typeof authPassphrase !== "string" || authPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `authPassphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (typeof privProtocol !== "string" || !VALID_PRIV_PROTOCOLS.has(privProtocol)) {
    return "privProtocol must be 'AES'.";
  }
  if (typeof privPassphrase !== "string" || privPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `privPassphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (typeof allowedSource !== "string" || allowedSource.length === 0) {
    return "allowedSource is required.";
  }
  return null;
}

export interface SnmpApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Injected for testability; server.ts supplies the real sudo-based
  // caller, which pipes the payload (including both passphrases) to
  // configure-snmp.sh over stdin as JSON, never as command-line arguments.
  runPrivilegedConfigure: (payload: Record<string, unknown>) => Promise<void>;
}

export function createSnmpApi(opts: SnmpApiOptions) {
  const { stepUpGuard, runPrivilegedConfigure } = opts;

  async function handleConfigure(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const validationError = validateSnmpPayload(record);
    if (validationError) {
      return new Response(validationError, { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, record.confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    const { confirmPassword: _confirmPassword, ...payload } = record;
    await runPrivilegedConfigure(payload);
    return new Response("SNMP configuration updated.", { status: 200 });
  }

  return { handleConfigure };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/snmp_api_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/snmp_api.ts dashboard/snmp_api_test.ts
git commit -m "feat: add the step-up-protected SNMPv3 configuration API"
```

- [ ] **Step 6: `server.ts`'e `/snmp-config` rotasını ekle**

`dashboard/server_test.ts`'e ekle:

```typescript
Deno.test("POST /snmp-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/snmp-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

`dashboard/server.ts`'e ekle: `import { createSnmpApi } from "./snmp_api.ts";`, `networkApi`'nin altına:

```typescript
  const snmpApi = createSnmpApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedConfigure: async (payload) => {
      const command = new Deno.Command("sudo", {
        args: ["/opt/aundekiosk/privileged/configure-snmp.sh"],
        stdin: "piped",
      });
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
      await writer.close();
      const { code, stderr } = await child.output();
      if (code !== 0) {
        throw new Error(`configure-snmp.sh failed: ${new TextDecoder().decode(stderr)}`);
      }
    },
  });
```

`/network-confirm` bloğunun altına:

```typescript
    if (url.pathname === "/snmp-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return snmpApi.handleConfigure(req, session.username, ip);
    }
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: Tüm testler PASS.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: wire /snmp-config behind session + step-up auth"
```

---

### Task 10: Kurulum Entegrasyonu ve Tam Doğrulama

**Files:**
- Modify: `scripts/setup/install.sh`
- Modify: `tests/run_all.sh`

**Interfaces:**
- Consumes: Task 1–9'un ürettiği her şey

- [ ] **Step 1: `install.sh`'ı güncelle**

`apt-get install` satırına `snmpd` ekle:

```bash
apt-get install -y jq chromium wtype xdotool openssl snmpd unzip
```

`chmod +x` satırına değişiklik gerekmiyor (`privileged/*.sh` wildcard'ı yeni script'leri de kapsıyor).

"Target user identified" satırının altına, PI_USER'ı `change-os-password.sh`'ın okuyacağı dosyaya yaz:

```bash
msg "$INFO" "Recording the target user for OS password changes..."
echo "$PI_USER" > "$AUNDEKIOSK_INSTALL_DIR/pi-user.txt"
```

Söz dizimi kontrolü:

Run: `bash -n scripts/setup/install.sh`
Expected: Çıktı yok, exit code 0.

- [ ] **Step 2: `tests/run_all.sh`'a yeni test dosyalarını ekle**

```bash
  "$SCRIPT_DIR/privileged/lib_test.sh" \
  "$SCRIPT_DIR/privileged/toggle_ssh_test.sh" \
  "$SCRIPT_DIR/privileged/toggle_ssh_password_auth_test.sh" \
  "$SCRIPT_DIR/privileged/change_os_password_test.sh" \
  "$SCRIPT_DIR/privileged/network_config_test.sh" \
  "$SCRIPT_DIR/privileged/configure_snmp_test.sh" \
```

satırlarını mevcut listeye ekle.

- [ ] **Step 3: Tüm test paketini çalıştır**

Run: `bash tests/run_all.sh`
Expected: Her bölüm için `0 failed`, "All bash test suites passed."

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/`
Expected: Task 3, 5, 7, 9'daki tüm Deno testleri dahil, tamamı PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup/install.sh tests/run_all.sh
git commit -m "feat: wire SSH/network/SNMP helpers into install.sh, completing Plan 4"
```

**Not:** Bu planın `nmcli`, `systemctl reload ssh`, `snmpd`/`iptables` çağrılarının GERÇEK davranışı bu makinede doğrulanamaz (Windows geliştirme ortamı). Spec §11'e göre, özellikle şunlar **gerçek Pi 4/5 donanımında manuel QA** gerektirir: (1) ağ değişikliğinin gerçekten 60s içinde geri alınması (bir SSH oturumu açıp bilerek yanlış bir statik IP girerek), (2) SNMPv3 kullanıcısının `snmpwalk -v3` ile gerçekten sorgulanabildiği ve izin verilmeyen bir kaynaktan erişimin reddedildiği, (3) SSH şifre-auth kapatıldığında anahtar-tabanlı girişin hâlâ çalıştığı.
