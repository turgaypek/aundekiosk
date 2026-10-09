import type { createStepUpGuard } from "./step_up.ts";

export type StepUpCheckResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

// Every high-risk endpoint in Plan 4 (SSH toggle, OS password change,
// network config, SNMP config) performs exactly this check before doing
// anything privileged — re-verifying the CURRENT dashboard password even
// though the caller already holds a valid session (spec §6).
export async function requireStepUp(
  stepUpGuard: ReturnType<typeof createStepUpGuard>,
  username: string,
  confirmPassword: unknown,
  ip: string,
): Promise<StepUpCheckResult> {
  if (typeof confirmPassword !== "string" || confirmPassword.length === 0) {
    return { ok: false, status: 400, message: "confirmPassword is required." };
  }

  const result = await stepUpGuard.verify(username, confirmPassword, ip);

  if (result.outcome === "success") {
    return { ok: true };
  }
  if (result.outcome === "locked") {
    return { ok: false, status: 423, message: "Account locked. Try again later." };
  }
  return { ok: false, status: 403, message: "Current password is incorrect." };
}
