import type { createCredentialStore } from "./credential_store.ts";
import type { createStepUpGuard } from "./step_up.ts";
import type { createAuditLog } from "./audit_log.ts";
import { requireStepUp } from "./require_step_up.ts";
import { MIN_PASSWORD_LENGTH } from "./password.ts";

const MAX_USERNAME_LENGTH = 64;
// Deliberately loose (not a full RFC 5322 validator) — this only needs to
// catch obvious typos before the address is stored for the SMTP
// notification feature to use later, not reject every edge case a real
// address could have.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UsersApiOptions {
  credentialStore: ReturnType<typeof createCredentialStore>;
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with who
  // did it, from where, and whether it succeeded.
  auditLog: ReturnType<typeof createAuditLog>;
}

export function createUsersApi(opts: UsersApiOptions) {
  const { credentialStore, stepUpGuard, auditLog } = opts;

  async function handleList(): Promise<Response> {
    return Response.json(await credentialStore.listUsers());
  }

  async function handleCreate(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username: newUsername, password, email, confirmPassword, role } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (
      typeof newUsername !== "string" ||
      newUsername.trim().length === 0 ||
      newUsername.length > MAX_USERNAME_LENGTH
    ) {
      return new Response(`username is required and must be at most ${MAX_USERNAME_LENGTH} characters.`, {
        status: 400,
      });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return new Response(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`, { status: 400 });
    }
    if (email !== null && email !== undefined && (typeof email !== "string" || !EMAIL_PATTERN.test(email))) {
      return new Response("email must be a valid address, or null.", { status: 400 });
    }
    if (role !== undefined && role !== "admin" && role !== "viewer") {
      return new Response("role must be 'admin' or 'viewer'.", { status: 400 });
    }
    const userRole: "admin" | "viewer" = (role as "admin" | "viewer") ?? "viewer";

    try {
      await credentialStore.createUser(newUsername.trim(), password, (email as string | null) ?? null, userRole);
    } catch (error) {
      await auditLog.record("user_created", { username, ip, targetUsername: newUsername, ok: false });
      if (error instanceof Error && error.message.includes("already exists")) {
        return new Response(error.message, { status: 409 });
      }
      throw error;
    }

    await auditLog.record("user_created", { username, ip, targetUsername: newUsername, ok: true });
    return new Response(`User '${newUsername}' created.`, { status: 201 });
  }

  async function handleDelete(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username: targetUsername, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (typeof targetUsername !== "string" || targetUsername.length === 0) {
      return new Response("username is required.", { status: 400 });
    }

    try {
      await credentialStore.deleteUser(targetUsername);
    } catch (error) {
      await auditLog.record("user_deleted", { username, ip, targetUsername, ok: false });
      const message = error instanceof Error ? error.message : "Could not delete user.";
      return new Response(message, { status: 400 });
    }

    await auditLog.record("user_deleted", { username, ip, targetUsername, ok: true });
    return new Response(`User '${targetUsername}' deleted.`, { status: 200 });
  }

  async function handleUpdateRole(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username: targetUsername, role, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (typeof targetUsername !== "string" || targetUsername.length === 0) {
      return new Response("username is required.", { status: 400 });
    }
    if (role !== "admin" && role !== "viewer") {
      return new Response("role must be 'admin' or 'viewer'.", { status: 400 });
    }

    try {
      await credentialStore.updateRole(targetUsername, role);
    } catch (error) {
      await auditLog.record("user_role_changed", { username, ip, targetUsername, role, ok: false });
      const message = error instanceof Error ? error.message : "Could not update role.";
      return new Response(message, { status: 400 });
    }

    await auditLog.record("user_role_changed", { username, ip, targetUsername, role: role as string, ok: true });
    return new Response(`User '${targetUsername}' role set to '${role}'.`, { status: 200 });
  }

  return { handleList, handleCreate, handleDelete, handleUpdateRole };
}
