import { createUsersApi } from "./users_api.ts";
import { createCredentialStore } from "./credential_store.ts";
import { createAuditLog } from "./audit_log.ts";
import { createStepUpGuard } from "./step_up.ts";
import { assertEquals } from "../test_util.ts";

const TEST_IP = "203.0.113.5";

async function withUsersApi(
  fn: (api: ReturnType<typeof createUsersApi>, store: ReturnType<typeof createCredentialStore>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const api = createUsersApi({
      credentialStore: store,
      stepUpGuard: createStepUpGuard({ credentialStore: store, auditLog }),
      auditLog,
    });
    await fn(api, store);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

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

// --- role field ---

Deno.test("handleCreate stores viewer role when role:viewer is passed", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "viewer1",
          password: "viewer-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
          role: "viewer",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 201);
    const users = await store.listUsers();
    assertEquals(users.find((u) => u.username === "viewer1")?.role, "viewer");
  });
});

Deno.test("handleCreate defaults to admin role when role is omitted", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "user2",
          password: "user2-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 201);
    const users = await store.listUsers();
    assertEquals(users.find((u) => u.username === "user2")?.role, "admin");
  });
});

Deno.test("handleCreate rejects an invalid role value", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "bad",
          password: "bad-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
          role: "superadmin",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleList returns role for each user", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const res = await api.handleList();
    const data = await res.json() as Array<{ username: string; role: string }>;
    assertEquals(data.find((u) => u.username === "admin")?.role, "admin");
    assertEquals(data.find((u) => u.username === "viewer1")?.role, "viewer");
  });
});
