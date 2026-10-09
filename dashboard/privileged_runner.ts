// Shared runner for every "sudo <privileged helper>" call the dashboard
// makes. Centralizing it means every call site gets stdout AND stderr
// piped, not just stdin — omitting either makes `child.output()` throw
// `TypeError: ... 'stderr' is not piped` AFTER the helper has already run
// (final review: Critical C4c broke all five privileged endpoints this
// way, undetected because every API-level test mocks this layer).
// Carries the real exit code, not just a message — some privileged
// helpers (confirm-network-config.sh) use a specific non-zero code to
// mean something other than "failed" (e.g. "nothing was pending"), and
// a caller needs the code to tell those cases apart (final review:
// Important I8).
export class PrivilegedCommandError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = "PrivilegedCommandError";
  }
}

export async function runPrivilegedCommand(
  command: string,
  args: string[],
  stdinInput?: string,
): Promise<void> {
  const child = new Deno.Command(command, {
    args,
    stdin: stdinInput !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  if (stdinInput !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinInput));
    await writer.close();
  }

  const { code, stderr } = await child.output();
  if (code !== 0) {
    throw new PrivilegedCommandError(
      `${command} ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
      code,
    );
  }
}
