export interface DeviceInfoApiOptions {
  runCommand: (cmd: string, args: string[]) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

interface IpAddrEntry {
  ifname: string;
  addr_info: { family: string; local: string; prefixlen: number }[];
}

export function createDeviceInfoApi(opts: DeviceInfoApiOptions) {
  const { runCommand, readFile } = opts;

  async function getHostname(): Promise<string> {
    return (await runCommand("hostname", [])).trim();
  }

  async function getGateway(ifname: string): Promise<string | null> {
    try {
      const out = await runCommand("ip", ["-4", "route", "show", "default", "dev", ifname]);
      const m = out.match(/default via (\S+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async function getDns(): Promise<string[]> {
    try {
      const content = await readFile("/etc/resolv.conf");
      return content
        .split("\n")
        .filter((l) => l.startsWith("nameserver "))
        .map((l) => l.replace("nameserver ", "").trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async function isStatic(ifname: string): Promise<boolean> {
    try {
      const content = await readFile("/etc/dhcpcd.conf");
      const escaped = ifname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`interface\\s+${escaped}[\\s\\S]*?static\\s+ip_address=`, "m").test(content);
    } catch {
      return false;
    }
  }

  async function handleGet(): Promise<Response> {
    try {
      const [hostname, ipJson] = await Promise.all([
        getHostname(),
        runCommand("ip", ["-4", "-json", "addr"]),
      ]);

      let entries: IpAddrEntry[] = [];
      try {
        entries = JSON.parse(ipJson) as IpAddrEntry[];
      } catch {
        entries = [];
      }

      const dns = await getDns();

      const interfaces = await Promise.all(
        entries
          .filter((e) => e.addr_info.some((a) => a.family === "inet"))
          .map(async (e) => {
            const inet = e.addr_info.find((a) => a.family === "inet");
            const [gateway, staticMode] = await Promise.all([
              getGateway(e.ifname),
              isStatic(e.ifname),
            ]);
            return {
              name: e.ifname,
              mode: staticMode ? "static" : "dhcp",
              address: inet?.local ?? null,
              prefix: inet?.prefixlen ?? null,
              gateway,
              dns,
            };
          }),
      );

      return Response.json({ hostname, interfaces });
    } catch (error) {
      console.error("device-info error:", error);
      return new Response("Could not read device info.", { status: 500 });
    }
  }

  return { handleGet };
}
