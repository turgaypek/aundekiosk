import { createHandler, isIdleTimedOut } from "./server.ts";
import { assertEquals } from "../dashboard/test_util.ts";

async function withApi(
  fn: (handle: ReturnType<typeof createHandler>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      publicDir: dir,
    });
    await Deno.writeTextFile(`${dir}/index.html`, "<html></html>");
    await fn(handle, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readAuditEvents(dir: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await Deno.readTextFile(`${dir}/audit.log`);
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("GET /status reports zero usernames before any admin exists", async () => {
  await withApi(async (handle) => {
    const res = await handle(new Request("http://localhost/status"));
    const body = await res.json();
    assertEquals(JSON.stringify(body.usernames), JSON.stringify([]));
  });
});

Deno.test("GET /status lists existing usernames after create-admin", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }));
    const res = await handle(new Request("http://localhost/status"));
    const body = await res.json();
    assertEquals(JSON.stringify(body.usernames), JSON.stringify(["admin"]));
  });
});

Deno.test("POST /create-admin with a valid username/password creates the first admin", async () => {
  await withApi(async (handle, dir) => {
    const res = await handle(
      jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 201);
    const events = await readAuditEvents(dir);
    assertEquals(events.length, 1);
    assertEquals(events[0].event, "admin_created_via_recovery_tool");
    assertEquals(events[0].ok, true);
  });
});

Deno.test("POST /create-admin refuses with 409 once an admin already exists", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }));
    const second = await handle(
      jsonRequest("/create-admin", { username: "someone-else", password: "another-long-password" }),
    );
    assertEquals(second.status, 409);
  });
});

Deno.test("POST /create-admin rejects a password shorter than the minimum", async () => {
  await withApi(async (handle) => {
    const res = await handle(jsonRequest("/create-admin", { username: "admin", password: "short" }));
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /reset-password changes an existing user's password and audit-logs ok:true", async () => {
  await withApi(async (handle, dir) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));

    const res = await handle(
      jsonRequest("/reset-password", { username: "admin", newPassword: "the-new-password-123" }),
    );
    assertEquals(res.status, 200);

    const events = await readAuditEvents(dir);
    const resetEvent = events.find((e) => e.event === "password_reset_via_recovery_tool");
    assertEquals(resetEvent?.ok, true);
    assertEquals(resetEvent?.username, "admin");
  });
});

Deno.test("POST /reset-password for a username that doesn't exist returns 400 and audit-logs ok:false", async () => {
  await withApi(async (handle, dir) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));

    const res = await handle(
      jsonRequest("/reset-password", { username: "nobody", newPassword: "the-new-password-123" }),
    );
    assertEquals(res.status, 400);

    const events = await readAuditEvents(dir);
    const resetEvent = events.find((e) => e.event === "password_reset_via_recovery_tool");
    assertEquals(resetEvent?.ok, false);
  });
});

Deno.test("POST /reset-password rejects a newPassword shorter than the minimum", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));
    const res = await handle(jsonRequest("/reset-password", { username: "admin", newPassword: "short" }));
    assertEquals(res.status, 400);
  });
});

Deno.test("isIdleTimedOut is false right after a request", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000, 600_000), false);
});

Deno.test("isIdleTimedOut is false just before the idle threshold", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000 + 599_999, 600_000), false);
});

Deno.test("isIdleTimedOut is true once the idle threshold is reached", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000 + 600_000, 600_000), true);
});
