import { createUsersApi } from "./users_api.ts";
import { createCredentialStore } from "./credential_store.ts";
import { createAuditLog } from "./audit_log.ts";
import { createStepUpGuard } from "./step_up.ts";
import { assertEquals } from "../test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createUsersApi>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const api = createUsersApi({ credentialStore, stepUpGuard, auditLog });
    await fn(api, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readAuditEvents(dir: string): Promise<Record<string, unknown>[]> {
  const text = await Deno.readTextFile(`${dir}/audit.log`);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

Deno.test("handleList returns every user without a password hash", async () => {
  await withApi(async (api) => {
    const res = await api.handleList();
    assertEquals(res.status, 200);
    const users = await res.json();
    assertEquals(users.length, 1);
    assertEquals(users[0].username, "admin");
    assertEquals(users[0].passwordHash, undefined);
  });
});

Deno.test("handleCreate with the correct confirmPassword adds a new user", async () => {
  await withApi(async (api, dir) => {
    const req = new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({
        username: "ayse",
        password: "another-long-password",
        email: "ayse@aundeteknik.com",
        confirmPassword: "a-long-enough-password",
      }),
    });
    const res = await api.handleCreate(req, "admin", "203.0.113.1");
    assertEquals(res.status, 201);

    const list = await (await api.handleList()).json();
    assertEquals(list.length, 2);

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "user_created");
    assertEquals(event?.username, "admin");
    assertEquals(event?.targetUsername, "ayse");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleCreate with a wrong confirmPassword returns 403 and creates no user", async () => {
  await withApi(async (api) => {
    const req = new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({
        username: "ayse",
        password: "another-long-password",
        email: null,
        confirmPassword: "wrong-password",
      }),
    });
    const res = await api.handleCreate(req, "admin", "203.0.113.1");
    assertEquals(res.status, 403);
    const list = await (await api.handleList()).json();
    assertEquals(list.length, 1);
  });
});

Deno.test("handleCreate rejects a password shorter than 12 characters", async () => {
  await withApi(async (api) => {
    const req = new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({
        username: "ayse",
        password: "short",
        email: null,
        confirmPassword: "a-long-enough-password",
      }),
    });
    const res = await api.handleCreate(req, "admin", "203.0.113.1");
    assertEquals(res.status, 400);
  });
});

Deno.test("handleCreate rejects a username that already exists", async () => {
  await withApi(async (api) => {
    const req = new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({
        username: "admin",
        password: "another-long-password",
        email: null,
        confirmPassword: "a-long-enough-password",
      }),
    });
    const res = await api.handleCreate(req, "admin", "203.0.113.1");
    assertEquals(res.status, 409);
  });
});

Deno.test("handleCreate rejects an invalid email format", async () => {
  await withApi(async (api) => {
    const req = new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({
        username: "ayse",
        password: "another-long-password",
        email: "not-an-email",
        confirmPassword: "a-long-enough-password",
      }),
    });
    const res = await api.handleCreate(req, "admin", "203.0.113.1");
    assertEquals(res.status, 400);
  });
});

Deno.test("handleDelete with the correct confirmPassword removes a user", async () => {
  await withApi(async (api, dir) => {
    await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "ayse",
          password: "another-long-password",
          email: null,
          confirmPassword: "a-long-enough-password",
        }),
      }),
      "admin",
      "203.0.113.1",
    );

    const res = await api.handleDelete(
      new Request("http://localhost/users-delete", {
        method: "POST",
        body: JSON.stringify({ username: "ayse", confirmPassword: "a-long-enough-password" }),
      }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    const list = await (await api.handleList()).json();
    assertEquals(list.length, 1);

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "user_deleted");
    assertEquals(event?.username, "admin");
    assertEquals(event?.targetUsername, "ayse");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleDelete refuses to remove the last remaining user", async () => {
  await withApi(async (api) => {
    const res = await api.handleDelete(
      new Request("http://localhost/users-delete", {
        method: "POST",
        body: JSON.stringify({ username: "admin", confirmPassword: "a-long-enough-password" }),
      }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    const list = await (await api.handleList()).json();
    assertEquals(list.length, 1);
  });
});

Deno.test("handleDelete with a wrong confirmPassword returns 403 and deletes nobody", async () => {
  await withApi(async (api) => {
    await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "ayse",
          password: "another-long-password",
          email: null,
          confirmPassword: "a-long-enough-password",
        }),
      }),
      "admin",
      "203.0.113.1",
    );
    const res = await api.handleDelete(
      new Request("http://localhost/users-delete", {
        method: "POST",
        body: JSON.stringify({ username: "ayse", confirmPassword: "wrong-password" }),
      }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    const list = await (await api.handleList()).json();
    assertEquals(list.length, 2);
  });
});
