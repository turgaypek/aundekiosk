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

  async function getPiModel(): Promise<string | null> {
    // Use cat (subprocess) to read device-tree/proc files — Deno's --allow-read
    // does not reliably cover /proc and /sys virtual filesystems.
    // Device-tree is the reliable source on all Pi models (32-bit and 64-bit kernels).
    for (const path of ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"]) {
      try {
        const raw = await runCommand("cat", [path]);
        const model = raw.replace(/\0/g, "").trim();
        if (model) return model;
      } catch { /* not available on this kernel */ }
    }
    try {
      const content = await runCommand("cat", ["/proc/cpuinfo"]);
      const m = content.match(/^Model\s*:\s*(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* not available */ }
    return null;
  }

  async function getRamMb(): Promise<number | null> {
    try {
      const content = await runCommand("cat", ["/proc/meminfo"]);
      const m = content.match(/^MemTotal:\s*(\d+)\s*kB/m);
      return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch {
      return null;
    }
  }

  async function getKernel(): Promise<string | null> {
    try {
      return (await runCommand("uname", ["-r"])).trim();
    } catch {
      return null;
    }
  }

  async function getDiskUsage(): Promise<{ used: string; total: string; percent: string } | null> {
    try {
      const out = await runCommand("df", ["-h", "/"]);
      const lines = out.trim().split("\n");
      // Last line is always the data row; standard df columns:
      // Filesystem  Size  Used  Avail  Use%  Mountpoint
      const cols = lines[lines.length - 1]?.trim().split(/\s+/);
      if (!cols || cols.length < 6) return null;
      return { used: cols[2], total: cols[1], percent: cols[4] };
    } catch {
      return null;
    }
  }

  async function getCpuTemp(): Promise<string | null> {
    try {
      const raw = await runCommand("cat", ["/sys/class/thermal/thermal_zone0/temp"]);
      const millideg = Number(raw.trim());
      if (isNaN(millideg)) return null;
      return (millideg / 1000).toFixed(1);
    } catch {
      return null;
    }
  }

  async function handleGet(): Promise<Response> {
    try {
      const [hostname, ipJson, piModel, ramMb, kernel, disk, cpuTemp] = await Promise.all([
        getHostname(),
        runCommand("ip", ["-4", "-json", "addr"]),
        getPiModel(),
        getRamMb(),
        getKernel(),
        getDiskUsage(),
        getCpuTemp(),
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

      return Response.json({ hostname, interfaces, piModel, ramMb, kernel, disk, cpuTemp });
    } catch (error) {
      console.error("device-info error:", error);
      return new Response("Could not read device info.", { status: 500 });
    }
  }

  return { handleGet };
}
