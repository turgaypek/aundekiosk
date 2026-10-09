import { createAuditLog } from "./audit_log.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("record appends a JSON line with a timestamp and the given event", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logPath = `${dir}/audit.log`;
    const log = createAuditLog({ logPath });
    await log.record("login_succeeded", { username: "admin", ip: "192.0.2.1" });

    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assertEquals(parsed.event, "login_succeeded");
    assertEquals(parsed.username, "admin");
    assertEquals(parsed.ip, "192.0.2.1");
    assertEquals(typeof parsed.timestamp, "string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("record appends, never overwrites — multiple events produce multiple lines", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logPath = `${dir}/audit.log`;
    const log = createAuditLog({ logPath });
    await log.record("login_succeeded", { username: "admin" });
    await log.record("logout", { username: "admin" });

    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals(JSON.parse(lines[0]).event, "login_succeeded");
    assertEquals(JSON.parse(lines[1]).event, "logout");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
