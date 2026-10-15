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
import { createVncApi } from "./vnc_api.ts";
import { createHostnameApi } from "./hostname_api.ts";
import { createRemoteAccessApi } from "./remote_access_api.ts";
import { createServiceControlApi } from "./service_control_api.ts";
import { createMonitorEventsApi } from "./monitor_events_api.ts";
import { createUsersApi } from "./auth/users_api.ts";
import { createAuditLogApi } from "./audit_log_api.ts";
import { createAptUpgradeApi } from "./apt_upgrade_api.ts";
import { runPrivilegedCommand } from "./privileged_runner.ts";
import { createDeviceInfoApi } from "./device_info_api.ts";
import { createRebootScheduleApi } from "./reboot_schedule_api.ts";
import { createNoVncProxy } from "./novnc_proxy.ts";
import { createTtyProxy } from "./tty_proxy.ts";
import { TERMINAL_HTML } from "./terminal_page.ts";

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
const DEFAULT_APT_UPGRADE_LOG_PATH = "/opt/aundekiosk/apt-upgrade.log";
const DEFAULT_REBOOT_REQUIRED_PATH = "/var/run/reboot-required";
const DEFAULT_REBOOT_TIMER_PATH = "/etc/systemd/system/aundekiosk-reboot.timer";
const DEFAULT_NOVNC_DIR = "/usr/share/novnc";
const DEFAULT_TTY_BACKEND_URL = "ws://127.0.0.1:7681/ws";

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
  aptUpgradeLogPath?: string;
  rebootRequiredPath?: string;
  rebootTimerPath?: string;
  novncDir?: string;
  ttyBackendUrl?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;
  const authStorePath = options.authStorePath ?? Deno.env.get("AUNDEKIOSK_AUTH_STORE_FILE") ?? DEFAULT_AUTH_STORE_PATH;
  const auditLogPath = options.auditLogPath ?? Deno.env.get("AUNDEKIOSK_AUDIT_LOG_FILE") ?? DEFAULT_AUDIT_LOG_PATH;
  const monitorConfigPath = options.monitorConfigPath ?? Deno.env.get("AUNDEKIOSK_MONITOR_CONFIG_FILE") ?? DEFAULT_MONITOR_CONFIG_PATH;
  const monitorSamplePath = options.monitorSamplePath ?? DEFAULT_MONITOR_SAMPLE_PATH;
  const aptUpgradeLogPath = options.aptUpgradeLogPath ?? Deno.env.get("AUNDEKIOSK_APT_UPGRADE_LOG_FILE") ?? DEFAULT_APT_UPGRADE_LOG_PATH;
  const rebootRequiredPath = options.rebootRequiredPath ?? Deno.env.get("AUNDEKIOSK_REBOOT_REQUIRED_FILE") ?? DEFAULT_REBOOT_REQUIRED_PATH;
  const rebootTimerPath = options.rebootTimerPath ?? DEFAULT_REBOOT_TIMER_PATH;

  const novncDir = options.novncDir ?? DEFAULT_NOVNC_DIR;
  const ttyBackendUrl = options.ttyBackendUrl ?? DEFAULT_TTY_BACKEND_URL;

  const serveStatic = createStaticHandler(publicDir);
  const noVncProxy = createNoVncProxy();
  const ttyProxy = createTtyProxy({ backendUrl: ttyBackendUrl });
  const auditLog = createAuditLog({ logPath: auditLogPath });
  let serveNovnc: ((pathname: string) => Promise<Response>) | null = null;
  try {
    serveNovnc = createStaticHandler(novncDir);
  } catch {
    // noVNC not installed; /novnc/* routes return 503 until apt install novnc runs
  }
  const configApi = createConfigApi({
    configPath,
    samplePath,
    runKioskRestart: async () => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/restart-kiosk-services.sh"]);
    },
  });
  const monitorConfigApi = createMonitorConfigApi({ configPath: monitorConfigPath, samplePath: monitorSamplePath });
  const authApi = createAuthApi({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    sessionStore: createSessionStore({ idleTimeoutMs: IDLE_TIMEOUT_MS }),
    rateLimiter: createRateLimiter(LOGIN_RATE_LIMIT),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  });

  function requireAdmin(req: Request): { username: string; role: "admin" } | Response {
    const session = authApi.requireSession(req);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (session.role !== "admin") return new Response("Forbidden", { status: 403 });
    return session as { username: string; role: "admin" };
  }

  const sshApi = createSshApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
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
    auditLog: createAuditLog({ logPath: auditLogPath }),
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
    auditLog: createAuditLog({ logPath: auditLogPath }),
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
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedConfigure: async (payload) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/configure-snmp.sh"],
        JSON.stringify(payload),
      );
    },
  });
  const vncApi = createVncApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedToggle: async (action) => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/toggle-vnc.sh", action]);
    },
  });
  const hostnameApi = createHostnameApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedChange: async (hostname) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/change-hostname.sh"],
        JSON.stringify({ hostname }),
      );
    },
  });
  // Shared by serviceControlApi (AundeKiosk's own 4 units) and
  // remoteAccessApi (ssh/wayvnc) — reading a unit's status needs no
  // elevated privilege, so this never goes through sudo.
  const checkServiceStatus = async (service: string) => {
    const command = new Deno.Command("systemctl", { args: ["is-active", service], stdout: "piped", stderr: "piped" });
    const { stdout } = await command.output();
    return new TextDecoder().decode(stdout).trim();
  };
  const serviceControlApi = createServiceControlApi({
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedToggle: async (service, action) => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/toggle-service.sh", service, action]);
    },
    checkServiceStatus,
  });
  const remoteAccessApi = createRemoteAccessApi({ checkServiceStatus });
  const monitorEventsApi = createMonitorEventsApi({ auditLogPath });
  const usersApi = createUsersApi({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  });
  const auditLogApi = createAuditLogApi({ auditLogPath });
  const aptUpgradeApi = createAptUpgradeApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedStart: async () => {
      await runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/apt-upgrade.sh", "start"]);
    },
    checkUnitActive: () => checkServiceStatus("aundekiosk-apt-upgrade").then((status) => status === "active"),
    readLog: async () => {
      try {
        return await Deno.readTextFile(aptUpgradeLogPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return "";
        throw error;
      }
    },
    checkRebootRequired: async () => {
      try {
        await Deno.stat(rebootRequiredPath);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
  });
  const deviceInfoApi = createDeviceInfoApi({
    runCommand: async (cmd, args) => {
      const c = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
      const { stdout } = await c.output();
      return new TextDecoder().decode(stdout);
    },
    readFile: (path) => Deno.readTextFile(path),
  });
  const rebootScheduleApi = createRebootScheduleApi({
    stepUpGuard: createStepUpGuard({
      credentialStore: createCredentialStore({ storePath: authStorePath }),
      auditLog: createAuditLog({ logPath: auditLogPath }),
    }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
    runPrivilegedManage: async (payload) => {
      await runPrivilegedCommand(
        "sudo",
        ["/opt/aundekiosk/privileged/manage-reboot-timer.sh"],
        JSON.stringify(payload),
      );
    },
    readTimerFile: () => Deno.readTextFile(rebootTimerPath),
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

    if (url.pathname === "/api/update" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      // Fire-and-forget: run-update.sh launches update.sh via systemd-run
      // --no-block, which returns immediately. The update will restart the
      // dashboard, so the response must be sent before that happens.
      runPrivilegedCommand("sudo", ["/opt/aundekiosk/privileged/run-update.sh"])
        .catch((err) => console.error("Update trigger failed:", err));
      return new Response("Update started.", { status: 202 });
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const session = authApi.requireSession(req);
      if (!session) return new Response("Unauthorized", { status: 401 });
      return new Response(JSON.stringify({ username: session.username, role: session.role }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/config-backup-info" && req.method === "GET") {
      if (!authApi.requireSession(req)) return new Response("Unauthorized", { status: 401 });
      return configApi.handleBackupInfo();
    }

    if (url.pathname === "/monitor-config") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      if (req.method === "GET") return monitorConfigApi.handleGet();
      if (req.method === "POST") return monitorConfigApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/ssh-config" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return sshApi.handleToggle(req, session.username, ip);
    }

    if (url.pathname === "/os-password" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return osPasswordApi.handleChange(req, session.username, ip);
    }

    if (url.pathname === "/network-config" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return networkApi.handleApply(req, session.username, ip);
    }

    if (url.pathname === "/network-confirm" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return networkApi.handleConfirm(req, session.username, ip);
    }

    if (url.pathname === "/snmp-config" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return snmpApi.handleConfigure(req, session.username, ip);
    }

    if (url.pathname === "/remote-access-status" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return remoteAccessApi.handleStatus();
    }

    if (url.pathname === "/vnc-config" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return vncApi.handleToggle(req, session.username, ip);
    }

    if (url.pathname === "/hostname-config" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return hostnameApi.handleChange(req, session.username, ip);
    }

    if (url.pathname === "/service-status" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return serviceControlApi.handleStatus();
    }

    if (url.pathname === "/service-control" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return serviceControlApi.handleToggle(req, session.username, ip);
    }

    if (url.pathname === "/monitor-events" && req.method === "GET") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return monitorEventsApi.handleGet();
    }

    if (url.pathname === "/audit-log" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return auditLogApi.handleGet();
    }

    if (url.pathname === "/users" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return usersApi.handleList();
    }

    if (url.pathname === "/users" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return usersApi.handleCreate(req, session.username, ip);
    }

    if (url.pathname === "/users-delete" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return usersApi.handleDelete(req, session.username, ip);
    }

    if (url.pathname === "/users-role" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return usersApi.handleUpdateRole(req, session.username, ip);
    }

    if (url.pathname === "/apt-upgrade/start" && req.method === "POST") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return aptUpgradeApi.handleStart(req, session.username, ip);
    }

    if (url.pathname === "/apt-upgrade/status" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return aptUpgradeApi.handleStatus();
    }

    if (url.pathname === "/device-info" && req.method === "GET") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return deviceInfoApi.handleGet();
    }

    if (url.pathname === "/reboot-schedule") {
      if (req.method === "GET") {
        if (!authApi.requireSession(req)) return new Response("Unauthorized", { status: 401 });
        return rebootScheduleApi.handleGet();
      }
      if (req.method === "POST") {
        const session = requireAdmin(req);
        if (session instanceof Response) return session;
        return rebootScheduleApi.handleSet(req, session.username, ip);
      }
      if (req.method === "DELETE") {
        const session = requireAdmin(req);
        if (session instanceof Response) return session;
        return rebootScheduleApi.handleDelete(req, session.username, ip);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/novnc-ws") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      auditLog.record("vnc_ws_connected", { username: session.username });
      return noVncProxy.handleUpgrade(req);
    }

    if (url.pathname.startsWith("/novnc/")) {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      if (!serveNovnc) {
        return new Response("noVNC not installed — run: apt install novnc", { status: 503 });
      }
      return serveNovnc(url.pathname.slice("/novnc".length));
    }

    if (url.pathname === "/tty-ws") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      auditLog.record("tty_ws_connected", { username: session.username });
      return ttyProxy.handleUpgrade(req);
    }

    if (url.pathname === "/terminal" && req.method === "GET") {
      const session = requireAdmin(req);
      if (session instanceof Response) return session;
      return new Response(TERMINAL_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
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
