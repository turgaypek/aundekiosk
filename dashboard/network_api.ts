import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";
import { PrivilegedCommandError } from "./privileged_runner.ts";

const VALID_INTERFACES = new Set(["eth0", "wlan0"]);
const VALID_MODES = new Set(["dhcp", "static"]);
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_PATTERN = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

interface NetworkConfigPayload {
  interface: string;
  mode: string;
  staticIp: string | null;
  gateway: string | null;
  dns: string | null;
  wifiSsid: string | null;
  wifiPassword: string | null;
}

function isValidOctetString(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  const ipPart = value.split("/")[0];
  return ipPart.split(".").every((octet) => Number(octet) <= 255);
}

function validateNetworkPayload(body: Record<string, unknown>): string | null {
  const iface = body.interface;
  const mode = body.mode;
  if (typeof iface !== "string" || !VALID_INTERFACES.has(iface)) {
    return "interface must be 'eth0' or 'wlan0'.";
  }
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    return "mode must be 'dhcp' or 'static'.";
  }
  if (mode === "static") {
    const staticIp = body.staticIp;
    const gateway = body.gateway;
    const dns = body.dns;
    if (typeof staticIp !== "string" || !isValidOctetString(staticIp, CIDR_PATTERN)) {
      return "staticIp must be a valid CIDR address.";
    }
    if (typeof gateway !== "string" || !isValidOctetString(gateway, IPV4_PATTERN)) {
      return "gateway must be a valid IPv4 address.";
    }
    if (typeof dns !== "string" || !isValidOctetString(dns, IPV4_PATTERN)) {
      return "dns must be a valid IPv4 address.";
    }
  }
  if (iface === "wlan0") {
    const ssid = body.wifiSsid;
    const password = body.wifiPassword;
    if (typeof ssid !== "string" || ssid.length < 1 || ssid.length > 32) {
      return "wifiSsid must be 1-32 characters.";
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 63) {
      return "wifiPassword must be 8-63 characters.";
    }
  }
  return null;
}

export interface NetworkApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded (final review:
  // Important I6).
  auditLog: ReturnType<typeof createAuditLog>;
  // Both injected for testability; server.ts supplies real sudo-based
  // callers. runPrivilegedApply pipes the validated payload to
  // apply-network-config.sh over stdin as JSON.
  runPrivilegedApply: (payload: NetworkConfigPayload) => Promise<void>;
  runPrivilegedConfirm: () => Promise<void>;
}

export function createNetworkApi(opts: NetworkApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedApply, runPrivilegedConfirm } = opts;

  async function handleApply(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const validationError = validateNetworkPayload(record);
    if (validationError) {
      return new Response(validationError, { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, record.confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    const payload: NetworkConfigPayload = {
      interface: record.interface as string,
      mode: record.mode as string,
      staticIp: (record.staticIp as string | null) ?? null,
      gateway: (record.gateway as string | null) ?? null,
      dns: (record.dns as string | null) ?? null,
      wifiSsid: (record.wifiSsid as string | null) ?? null,
      wifiPassword: (record.wifiPassword as string | null) ?? null,
    };

    try {
      await runPrivilegedApply(payload);
    } catch (error) {
      await auditLog.record("network_config_applied", {
        username,
        ip,
        interface: payload.interface,
        mode: payload.mode,
        ok: false,
      });
      throw error;
    }

    await auditLog.record("network_config_applied", {
      username,
      ip,
      interface: payload.interface,
      mode: payload.mode,
      ok: true,
    });
    return new Response(
      "Network configuration applied. It will automatically revert in 60 seconds unless you confirm access.",
      { status: 200 },
    );
  }

  async function handleConfirm(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    try {
      await runPrivilegedConfirm();
    } catch (error) {
      // confirm-network-config.sh exits with code 2 specifically to mean
      // "nothing was pending" (already rolled back, or never scheduled)
      // — report that as a distinct outcome, not a bare 200 the user
      // never actually got (final review: Important I8).
      if (error instanceof PrivilegedCommandError && error.code === 2) {
        await auditLog.record("network_config_confirmed", { username, ip, ok: false, reason: "nothing_pending" });
        return new Response("Network configuration was already rolled back (nothing was pending).", { status: 409 });
      }
      await auditLog.record("network_config_confirmed", { username, ip, ok: false });
      throw error;
    }
    await auditLog.record("network_config_confirmed", { username, ip, ok: true });
    return new Response("Network configuration confirmed.", { status: 200 });
  }

  return { handleApply, handleConfirm };
}
