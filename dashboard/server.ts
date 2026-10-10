import { createStaticHandler } from "./static.ts";
import { createConfigApi } from "./config_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createSessionStore } from "./auth/session_store.ts";
import { createRateLimiter } from "./auth/rate_limiter.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createAuthApi } from "./auth/auth_api.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { createMonitorConfigApi } from "./monitor_config_api.ts";
import { createSshApi } from "./ssh_api.ts";
import { createOsPasswordApi } from "./os_password_api.ts";
import { createNetworkApi } from "./network_api.ts";
import { createSnmpApi } from "./snmp_api.ts";
import { runPrivilegedCommand } from "./privileged_runner.ts";

// import.meta.dirname (not new URL(...).pathname) because on Windows a
// file:// URL's pathname keeps a leading slash before the drive letter
// (e.g. "/C:/..."), which is not a path Deno.realPathSync can resolve.
const DEFAULT_PUBLIC_DIR = `${import.meta.dirname}/public`;
const DEFAULT_CONFIG_PATH = "/opt/aundekiosk/config.json";
const DEFAULT_SAMPLE_PATH = `${import.meta.dirname}/../config.json.sample`;
const DEFAULT_AUTH_STORE_PATH = "/opt/aundekiosk/auth.db";
const DEFAULT_AUDIT_LOG_PATH = "/opt/aundekiosk/audit.log";
const DEFAULT_MONITOR_CONFIG_PATH = "/opt/aundekiosk/monitor-config.json";
const DEFAULT_MONITOR_SAMPLE_PATH = `${import.meta.dirname}/../monitor-config.json.sample`;

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const LOGIN_RATE_LIMIT = { maxAttempts: 10, windowMs: 60_000 };

export interface HandlerOptions {
  configPath?: string;
  samplePath?: string;
  publicDir?: string;
  authStorePath?: string;
  auditLogPath?: string;
  monitorConfigPath?: string;
  monitorSamplePath?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;
  const authStorePath = options.authStorePath ?? Deno.env.get("AUNDEKIOSK_AUTH_STORE_FILE") ?? DEFAULT_AUTH_STORE_PATH;
  const auditLogPath = options.auditLogPath ?? Deno.env.get("AUNDEKIOSK_AUDIT_LOG_FILE") ?? DEFAULT_AUDIT_LOG_PATH;
  const monitorConfigPath = options.monitorConfigPath ?? Deno.env.get("AUNDEKIOSK_MONITOR_CONFIG_FILE") ?? DEFAULT_MONITOR_CONFIG_PATH;
  const monitorSamplePath = options.monitorSamplePath ?? DEFAULT_MONITOR_SAMPLE_PATH;

  const serveStatic = createStaticHandler(publicDir);
  const configApi = createConfigApi({ configPath, samplePath });
  const monitorConfigApi = createMonitorConfigApi({ configPath: monitorConfigPath, samplePath: monitorSamplePath });
  const authApi = createAuthApi({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    sessionStore: createSessionStore({ idleTimeoutMs: IDLE_TIMEOUT_MS }),
    rateLimiter: createRateLimiter(LOGIN_RATE_LIMIT),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  });
  const sshApi = createSshApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedToggle: async (action) => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/toggle-ssh.sh", action]);
    },
    runPrivilegedPasswordAuthToggle: async (action) => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/toggle-ssh-password-auth.sh", action]);
    },
  });
  const osPasswordApi = createOsPasswordApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedChange: async (newPassword) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/change-os-password.sh"],
        JSON.stringify({ newPassword }),
      );
    },
  });
  const networkApi = createNetworkApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedApply: async (payload) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/apply-network-config.sh"],
        JSON.stringify(payload),
      );
    },
    runPrivilegedConfirm: async () => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/confirm-network-config.sh"]);
    },
  });
  const snmpApi = createSnmpApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    runPrivilegedConfigure: async (payload) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/configure-snmp.sh"],
        JSON.stringify(payload),
      );
    },
  });

  return async function handle(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
    const url = new URL(req.url);
    // The real connection address — never a client-supplied header like
    // X-Forwarded-For, which anyone can set to anything (there is no
    // reverse proxy in front of this dashboard to make that header
    // trustworthy). Deno.serve always provides `info`; it's optional here
    // only so tests that don't care about the IP can omit it.
    const ip = info && info.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "unknown";

    if (url.pathname === "/api/setup") {
      if (req.method === "GET") return authApi.handleSetupStatus();
      if (req.method === "POST") return authApi.handleSetup(req, ip);
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      return authApi.handleLogin(req, ip);
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return authApi.handleLogout(req, ip);
    }

    if (url.pathname === "/config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/monitor-config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return monitorConfigApi.handleGet();
      if (req.method === "POST") return monitorConfigApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/ssh-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return sshApi.handleToggle(req, session.username, ip);
    }

    if (url.pathname === "/os-password" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return osPasswordApi.handleChange(req, session.username, ip);
    }

    if (url.pathname === "/network-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return networkApi.handleApply(req, session.username, ip);
    }

    if (url.pathname === "/network-confirm" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return networkApi.handleConfirm(req, session.username, ip);
    }

    if (url.pathname === "/snmp-config" && req.method === "POST") {
      const session = authApi.requireSession(req);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return snmpApi.handleConfigure(req, session.username, ip);
    }

    return serveStatic(url.pathname);
  };
}

// The session cookie is always set with `Secure`, so a browser will never
// send it back over plain HTTP — a silent HTTP fallback would make login
// appear to succeed while every authenticated request after it quietly
// fails. So plain HTTP is refused unless explicitly opted into (local dev
// only, never production): this throws rather than degrading silently.
export function resolveTlsMode(hasCert: boolean, allowHttpEnv: string | undefined): "https" | "http" {
  if (hasCert) return "https";
  if (allowHttpEnv === "1") return "http";
  throw new Error(
    "No TLS certificate found and AUNDEKIOSK_ALLOW_HTTP is not set to '1'. " +
      "Refusing to start the dashboard over plain HTTP: the session cookie is " +
      "Secure-only, so logins would silently fail. Run scripts/setup/generate-tls-cert.sh, " +
      "or set AUNDEKIOSK_ALLOW_HTTP=1 for local development only.",
  );
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8080");
  const certPath = Deno.env.get("AUNDEKIOSK_TLS_CERT") ?? "/opt/aundekiosk/tls/cert.pem";
  const keyPath = Deno.env.get("AUNDEKIOSK_TLS_KEY") ?? "/opt/aundekiosk/tls/key.pem";

  let tls: { cert: string; key: string } | undefined;
  try {
    tls = { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath) };
  } catch {
    tls = undefined;
  }

  const mode = resolveTlsMode(tls !== undefined, Deno.env.get("AUNDEKIOSK_ALLOW_HTTP"));
  console.log(`AundeKiosk dashboard starting on port ${port} (${mode.toUpperCase()})...`);
  Deno.serve({ port, ...(mode === "https" ? tls : {}) }, createHandler());
}
