import { PrivilegedCommandError, runPrivilegedCommand } from "./privileged_runner.ts";
import { assertEquals } from "./test_util.ts";

// Final review (Critical C4c): every call site previously piped stdin but
// left stdout/stderr unpiped, so `child.output()` threw
// `TypeError: Cannot get 'stderr': 'stderr' is not piped` AFTER the
// privileged helper had already run — every one of these five endpoints
// was broken in production despite its mocked unit tests passing. These
// tests use the real Deno binary as a stand-in subprocess (no mocking),
// so they fail the same way the production code did before the fix.

Deno.test("runPrivilegedCommand succeeds against a real subprocess that exits 0, with stdin input", async () => {
  await runPrivilegedCommand(
    Deno.execPath(),
    ["eval", "for await (const _ of Deno.stdin.readable) { /* drain */ } Deno.exit(0);"],
    "some input",
  );
});

Deno.test("runPrivilegedCommand succeeds against a real subprocess that exits 0, with no stdin", async () => {
  await runPrivilegedCommand(Deno.execPath(), ["eval", "Deno.exit(0);"]);
});

Deno.test("runPrivilegedCommand throws with the subprocess's stderr when it exits non-zero", async () => {
  let threw = false;
  let message = "";
  try {
    await runPrivilegedCommand(Deno.execPath(), [
      "eval",
      "console.error('boom from child'); Deno.exit(7);",
    ]);
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(threw, true);
  assertEquals(message.includes("boom from child"), true);
});

// Final review (Important I8): confirm-network-config.sh exits with a
// specific code (2) to mean "nothing was pending" rather than "a real
// failure" — callers need the exit code, not just a generic Error, to
// tell those two cases apart and answer the API request correctly.
Deno.test("runPrivilegedCommand throws a PrivilegedCommandError carrying the real exit code", async () => {
  let caught: unknown;
  try {
    await runPrivilegedCommand(Deno.execPath(), ["eval", "Deno.exit(2);"]);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof PrivilegedCommandError, true);
  assertEquals((caught as PrivilegedCommandError).code, 2);
});
