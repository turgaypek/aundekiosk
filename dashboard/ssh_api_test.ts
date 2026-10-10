import { createSshApi } from "./ssh_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createSshApi>,
    dir: string,
    record: () => string[],
    passwordAuthRecord: () => string[],
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const calls: string[] = [];
    const passwordAuthCalls: string[] = [];
    const api = createSshApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async (action: string) => {
        calls.push(action);
      },
      runPrivilegedPasswordAuthToggle: async (action: string) => {
        passwordAuthCalls.push(action);
      },
    });
    await fn(api, dir, () => calls, () => passwordAuthCalls);
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

function jsonRequest(body: unknown) {
  return new Request("http://localhost/ssh-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleToggle with the correct confirmPassword invokes the privileged toggle", async () => {
  await withApi(async (api, dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "enable", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify(["enable"]));

    // Final review (Important I6): spec §6 requires every privileged
    // action — not just login/step-up — to be audit-logged with who did
    // it, from where, and whether it succeeded.
    const events = await readAuditEvents(dir);
    const sshEvent = events.find((e) => e.event === "ssh_toggled");
    assertEquals(sshEvent !== undefined, true);
    assertEquals(sshEvent?.username, "admin");
    assertEquals(sshEvent?.ip, "203.0.113.1");
    assertEquals(sshEvent?.action, "enable");
    assertEquals(sshEvent?.ok, true);
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

// Final review (Important I7): the plan's own Task 3 Interfaces promised
// a way to toggle SSH password-auth hardening (spec §8.1), and
// toggle-ssh-password-auth.sh was built and whitelisted in Task 2 — but
// nothing in the dashboard API ever called it. A "target" field
// distinguishes toggling the SSH service itself from toggling
// password-auth; omitting it keeps the original "service" behavior.
Deno.test("handleToggle with target 'password_auth' invokes the password-auth toggle, not the service toggle", async () => {
  await withApi(async (api, _dir, calls, passwordAuthCalls) => {
    const res = await api.handleToggle(
      jsonRequest({ target: "password_auth", action: "disable", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(passwordAuthCalls()), JSON.stringify(["disable"]));
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle with target 'password_auth' and a wrong confirmPassword returns 403 and never invokes the toggle", async () => {
  await withApi(async (api, _dir, _calls, passwordAuthCalls) => {
    const res = await api.handleToggle(
      jsonRequest({ target: "password_auth", action: "disable", confirmPassword: "wrong-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(passwordAuthCalls().length, 0);
  });
});

Deno.test("handleToggle audit-logs a failed privileged toggle with ok:false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const api = createSshApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async () => {
        throw new Error("toggle-ssh.sh failed: simulated");
      },
      runPrivilegedPasswordAuthToggle: async () => {},
    });
    let threw = false;
    try {
      await api.handleToggle(
        jsonRequest({ action: "enable", confirmPassword: "a-long-enough-password" }),
        "admin",
        "203.0.113.1",
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    const events = await readAuditEvents(dir);
    const sshEvent = events.find((e) => e.event === "ssh_toggled");
    assertEquals(sshEvent?.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleToggle rejects a target outside service/password_auth", async () => {
  await withApi(async (api, _dir, calls, passwordAuthCalls) => {
    const res = await api.handleToggle(
      jsonRequest({ target: "something_else", action: "disable", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
    assertEquals(passwordAuthCalls().length, 0);
  });
});
