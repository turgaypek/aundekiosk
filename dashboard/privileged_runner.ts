// Shared runner for every "sudo <privileged helper>" call the dashboard
// makes. Centralizing it means every call site gets stdout AND stderr
// piped, not just stdin — omitting either makes `child.output()` throw
// `TypeError: ... 'stderr' is not piped` AFTER the helper has already run
// (final review: Critical C4c broke all five privileged endpoints this
// way, undetected because every API-level test mocks this layer).
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
    throw new Error(`${command} ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
  }
}
