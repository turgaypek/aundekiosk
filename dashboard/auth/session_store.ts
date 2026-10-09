export interface SessionStoreOptions {
  idleTimeoutMs: number;
}

interface SessionRecord {
  username: string;
  lastActivityAt: number;
}

function randomToken(): string {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// In-memory only: a dashboard restart logs everyone out, which is an
// acceptable, simple trade-off for a single-admin kiosk tool (no
// persisted session store to keep consistent or clean up).
export function createSessionStore(opts: SessionStoreOptions) {
  const { idleTimeoutMs } = opts;
  const sessions = new Map<string, SessionRecord>();

  function createSession(username: string, now: number = Date.now()): string {
    const token = randomToken();
    sessions.set(token, { username, lastActivityAt: now });
    return token;
  }

  function touch(token: string, now: number = Date.now()): { username: string } | null {
    const record = sessions.get(token);
    if (!record) return null;
    if (now - record.lastActivityAt > idleTimeoutMs) {
      sessions.delete(token);
      return null;
    }
    record.lastActivityAt = now;
    return { username: record.username };
  }

  function destroy(token: string): void {
    sessions.delete(token);
  }

  return { createSession, touch, destroy };
}
