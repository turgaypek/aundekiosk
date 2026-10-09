export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

// A simple per-key sliding window: each check() records the attempt and
// reports whether the number of attempts inside the trailing `windowMs`
// (including this one) is within `maxAttempts`.
export function createRateLimiter(opts: RateLimiterOptions) {
  const { maxAttempts, windowMs } = opts;
  const attempts = new Map<string, number[]>();

  function check(key: string, now: number = Date.now()): boolean {
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
    const allowed = recent.length < maxAttempts;
    recent.push(now);
    attempts.set(key, recent);
    return allowed;
  }

  return { check };
}
