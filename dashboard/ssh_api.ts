import type { createStepUpGuard } from "./auth/step_up.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

export interface SshApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Injected so the API logic is testable without ever shelling out to a
  // real privileged helper; server.ts supplies the real sudo-based caller.
  runPrivilegedToggle: (action: "enable" | "disable") => Promise<void>;
}

export function createSshApi(opts: SshApiOptions) {
  const { stepUpGuard, runPrivilegedToggle } = opts;

  async function handleToggle(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { action, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (action !== "enable" && action !== "disable") {
      return new Response("action must be 'enable' or 'disable'.", { status: 400 });
    }

    await runPrivilegedToggle(action);
    return new Response(`SSH ${action}d.`, { status: 200 });
  }

  return { handleToggle };
}
