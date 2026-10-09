import { createRateLimiter } from "./rate_limiter.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("allows attempts up to the limit within the window", () => {
  const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
  const now = 1000;
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("1.2.3.4", now), true);
});

Deno.test("rejects the attempt that exceeds the limit within the window", () => {
  const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
  const now = 1000;
  limiter.check("1.2.3.4", now);
  limiter.check("1.2.3.4", now);
  limiter.check("1.2.3.4", now);
  assertEquals(limiter.check("1.2.3.4", now), false);
});

Deno.test("different keys (IPs) are tracked independently", () => {
  const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  const now = 1000;
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("5.6.7.8", now), true);
});

Deno.test("allows attempts again once the window has fully passed", () => {
  const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  limiter.check("1.2.3.4", 1000);
  assertEquals(limiter.check("1.2.3.4", 1000 + 60_000 + 1), true);
});
