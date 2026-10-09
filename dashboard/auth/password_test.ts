import { hashPassword, verifyPassword } from "./password.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("hashPassword produces a hash that verifyPassword accepts for the same password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(await verifyPassword("correct-horse-battery-staple", hash), true);
});

Deno.test("verifyPassword rejects a different password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(await verifyPassword("wrong-password", hash), false);
});

Deno.test("hashPassword produces an argon2id-encoded hash", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(hash.startsWith("$argon2id$"), true);
});

Deno.test("hashPassword salts each call differently, so the same password hashes differently", async () => {
  const first = await hashPassword("same-password");
  const second = await hashPassword("same-password");
  assertEquals(first === second, false);
});
