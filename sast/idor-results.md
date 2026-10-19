# IDOR Analysis Results: AundeKiosk

## Executive Summary
- Candidates analyzed: 3
- Vulnerable: 0
- Likely Vulnerable: 0
- Not Vulnerable: 3
- Needs Manual Review: 0

No IDOR vulnerabilities found. All three endpoints require `requireAdmin` middleware plus step-up re-authentication; a viewer-role user cannot reach any of them. Three business-logic concerns were identified (not IDOR, but worth fixing):

1. **No last-admin guard on role demotion** (`POST /users-role`) — an admin can demote all admins to viewer, permanently locking dashboard admin access until `auth.db` is manually patched.
2. **No last-admin guard on user delete** (`POST /users-delete`) — an admin can delete all other admins while retaining at least one viewer, leaving zero admins.
3. **Default role is "admin" on user create** (`POST /users`) — omitting the `role` field silently creates an admin account.

## Findings

### [NOT VULNERABLE — Business Logic Concern] POST /users-role — Change any user's role

- **File**: `dashboard/auth/users_api.ts` (lines 107–138)
- **Endpoint**: `POST /users-role`
- **Issue**: Not IDOR — viewer-role users cannot reach this endpoint. However, `updateRoleLocked` in `credential_store.ts` (lines 156–164) has no last-admin guard. An admin can demote every other admin (and ultimately themselves) to `"viewer"`, leaving zero admin-role accounts in `auth.db`. After the current session expires, no admin can authenticate through the dashboard.
- **Impact**: Deliberate or accidental full-admin demotion permanently locks all dashboard admin access. Unlike user deletion, no record is lost — all accounts survive, just none with admin role. Recovery requires manual `auth.db` patching or an out-of-band CLI tool.
- **Protection**: `requireAdmin` (route-level, blocks viewers); `requireStepUp` (handler-level, re-verifies acting admin password). No protection against demoting the last admin.
- **Remediation**: Add a last-admin guard before `credentialStore.updateRole`. Count current admins; if the result would leave 0 admins, reject with HTTP 409:
  ```typescript
  // Inside handleUpdateRole, after step-up passes:
  if (role === "viewer") {
    const users = await credentialStore.listUsers();
    const adminCount = users.filter(u => u.role === "admin").length;
    if (adminCount <= 1 && targetUsername === username /* acting user */) {
      return new Response("Cannot demote the last admin.", { status: 409 });
    }
    // Also check if targetUsername is the last admin overall:
    const targetIsAdmin = users.find(u => u.username === targetUsername)?.role === "admin";
    if (targetIsAdmin && adminCount <= 1) {
      return new Response("Cannot demote the last admin.", { status: 409 });
    }
  }
  ```

---

### [NOT VULNERABLE — Business Logic Concern] POST /users-delete — Delete any user

- **File**: `dashboard/auth/users_api.ts` (lines 77–105)
- **Endpoint**: `POST /users-delete`
- **Issue**: Not IDOR — by design, admins delete other users. However, `deleteUserLocked` (lines 166–176 of `credential_store.ts`) only guards against deleting the last *user* (`users.length <= 1`), not the last *admin*. An admin can delete all other admin accounts as long as at least one viewer remains, leaving zero admins.
- **Impact**: Same lockout outcome as the role-change issue but achieves it by deleting records rather than demoting them. More destructive because user accounts are permanently removed.
- **Protection**: `requireAdmin`; `requireStepUp`; last-user guard (not last-admin guard).
- **Remediation**: Add a last-admin guard in `deleteUserLocked` or `handleDelete`:
  ```typescript
  // Before deleteUser call:
  const users = await credentialStore.listUsers();
  const targetUser = users.find(u => u.username === targetUsername);
  if (targetUser?.role === "admin") {
    const adminCount = users.filter(u => u.role === "admin").length;
    if (adminCount <= 1) {
      return new Response("Cannot delete the last admin.", { status: 409 });
    }
  }
  ```

---

### [NOT VULNERABLE — Default Escalation Risk] POST /users — Create user

- **File**: `dashboard/auth/users_api.ts` (lines 29–75)
- **Endpoint**: `POST /users`
- **Issue**: Not IDOR. The `role` field defaults to `"admin"` when omitted:
  ```typescript
  const userRole: "admin" | "viewer" = (role as "admin" | "viewer") ?? "admin";
  ```
  Any admin API call or script that omits the `role` field silently creates an admin account rather than a viewer. Privilege-escalation-by-default.
- **Impact**: A bug in the UI, a script, or a direct API call that omits `role` creates an unexpected admin account.
- **Protection**: `requireAdmin`; `requireStepUp`. Both prevent a viewer or unauthenticated caller from creating any account.
- **Remediation**: Invert the default — change `?? "admin"` to `?? "viewer"`:
  ```typescript
  const userRole: "admin" | "viewer" = (role as "admin" | "viewer") ?? "viewer";
  ```
  Alternatively, make the `role` field required and return HTTP 400 when absent.

---

## Notes

- **Unexposed `resetPassword` method** (`credential_store.ts` lines 178–191): Implemented but not wired to any HTTP route. If a route is ever added, it must include step-up authentication and must be audited as a candidate IDOR target at that time.
- The single-tenant flat-file design means there are no "resource ownership" relationships beyond user accounts themselves — IDOR is limited to the user management surface.
