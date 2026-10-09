import { createStaticHandler } from "./static.ts";
import { createConfigApi } from "./config_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createSessionStore } from "./auth/session_store.ts";
import { createRateLimiter } from "./auth/rate_limiter.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createAuthApi } from "./auth/auth_api.ts";

// import.meta.dirname (not new URL(...).pathname) because on Windows a
// file:// URL's pathname keeps a leading slash before the drive letter
// (e.g. "/C:/..."), which is not a path Deno.realPathSync can resolve.
const DEFAULT_PUBLIC_DIR = `${import.meta.dirname}/public`;
const DEFAULT_CONFIG_PATH = "/opt/aundekiosk/config.json";
const DEFAULT_SAMPLE_PATH = `${import.meta.dirname}/../config.json.sample`;
const DEFAULT_AUTH_STORE_PATH = "/opt/aundekiosk/auth.db";
const DEFAULT_AUDIT_LOG_PATH = "/opt/aundekiosk/audit.log";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const LOGIN_RATE_LIMIT = { maxAttempts: 10, windowMs: 60_000 };

export interface HandlerOptions {
  configPath?: string;
  samplePath?: string;
  publicDir?: string;
  authStorePath?: string;
  auditLogPath?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;
  const authStorePath = options.authStorePath ?? Deno.env.get("AUNDEKIOSK_AUTH_STORE_FILE") ?? DEFAULT_AUTH_STORE_PATH;
  const auditLogPath = options.auditLogPath ?? Deno.env.get("AUNDEKIOSK_AUDIT_LOG_FILE") ?? DEFAULT_AUDIT_LOG_PATH;

  const serveStatic = createStaticHandler(publicDir);
  const configApi = createConfigApi({ configPath, samplePath });
  const authApi = createAuthApi({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    sessionStore: createSessionStore({ idleTimeoutMs: IDLE_TIMEOUT_MS }),
    rateLimiter: createRateLimiter(LOGIN_RATE_LIMIT),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/setup") {
      if (req.method === "GET") return authApi.handleSetupStatus();
      if (req.method === "POST") return authApi.handleSetup(req);
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      return authApi.handleLogin(req);
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return authApi.handleLogout(req);
    }

    if (url.pathname === "/config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return serveStatic(url.pathname);
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8080");
  const certPath = Deno.env.get("AUNDEKIOSK_TLS_CERT") ?? "/opt/aundekiosk/tls/cert.pem";
  const keyPath = Deno.env.get("AUNDEKIOSK_TLS_KEY") ?? "/opt/aundekiosk/tls/key.pem";

  let tls: { cert: string; key: string } | undefined;
  try {
    tls = { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath) };
  } catch {
    console.warn(`No TLS certificate found at ${certPath}; starting over plain HTTP (dev only).`);
  }

  console.log(`AundeKiosk dashboard starting on port ${port}${tls ? " (HTTPS)" : " (HTTP)"}...`);
  Deno.serve({ port, ...tls }, createHandler());
}
