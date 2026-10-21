import { createDeviceInfoApi } from "./device_info_api.ts";
import { assertEquals } from "./test_util.ts";

function makeApi(cmds: Record<string, string>, files: Record<string, string>) {
  return createDeviceInfoApi({
    runCommand: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      const result = cmds[key];
      if (result === undefined) throw new Error(`Unexpected command: ${key}`);
      return result;
    },
    readFile: async (path) => {
      const result = files[path];
      if (result === undefined) {
        const e = new Deno.errors.NotFound(`${path} not found`);
        throw e;
      }
      return result;
    },
  });
}

Deno.test("handleGet returns hostname from hostname command", async () => {
  const api = makeApi(
    {
      "hostname": "kiosk-01",
      "ip -4 -json addr": "[]",
    },
    {},
  );
  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.hostname, "kiosk-01");
});

Deno.test("handleGet parses eth0 DHCP address from ip addr output", async () => {
  const ipOutput = JSON.stringify([
    {
      ifname: "eth0",
      addr_info: [{ family: "inet", local: "192.168.14.160", prefixlen: 24 }],
    },
  ]);
  const routeOutput = "default via 192.168.14.1 dev eth0 proto dhcp src 192.168.14.160 metric 100\n";
  const resolvConf = "nameserver 192.168.14.1\nnameserver 8.8.8.8\n";
  const dhcpcdConf = "# no static entries\n";

  const api = makeApi(
    {
      "hostname": "kiosk-01",
      "ip -4 -json addr": ipOutput,
      "ip -4 route show default dev eth0": routeOutput,
    },
    {
      "/etc/resolv.conf": resolvConf,
      "/etc/dhcpcd.conf": dhcpcdConf,
    },
  );

  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  const eth0 = data.interfaces[0];
  assertEquals(eth0.name, "eth0");
  assertEquals(eth0.mode, "dhcp");
  assertEquals(eth0.address, "192.168.14.160");
  assertEquals(eth0.prefix, 24);
  assertEquals(eth0.gateway, "192.168.14.1");
  assertEquals(eth0.dns.length, 2);
  assertEquals(eth0.dns[0], "192.168.14.1");
  assertEquals(eth0.dns[1], "8.8.8.8");
});

Deno.test("handleGet reports static mode when dhcpcd.conf has static entry for interface", async () => {
  const ipOutput = JSON.stringify([
    {
      ifname: "eth0",
      addr_info: [{ family: "inet", local: "192.168.14.50", prefixlen: 24 }],
    },
  ]);
  const dhcpcdConf = "interface eth0\nstatic ip_address=192.168.14.50/24\nstatic routers=192.168.14.1\n";

  const api = makeApi(
    {
      "hostname": "kiosk-02",
      "ip -4 -json addr": ipOutput,
      "ip -4 route show default dev eth0": "default via 192.168.14.1 dev eth0\n",
    },
    {
      "/etc/resolv.conf": "nameserver 8.8.8.8\n",
      "/etc/dhcpcd.conf": dhcpcdConf,
    },
  );

  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.interfaces[0].mode, "static");
});

Deno.test("handleGet returns 200 with empty interfaces when ip addr returns no inet entries", async () => {
  const api = makeApi(
    { "hostname": "kiosk-03", "ip -4 -json addr": "[]" },
    {},
  );
  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.interfaces.length, 0);
});

Deno.test("handleGet reads Pi model from device-tree (strips null byte)", async () => {
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]" },
    { "/proc/device-tree/model": "Raspberry Pi 4 Model B Rev 1.5\0" },
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.piModel, "Raspberry Pi 4 Model B Rev 1.5");
});

Deno.test("handleGet falls back to /proc/cpuinfo for Pi model when device-tree unavailable", async () => {
  const cpuinfo = [
    "processor\t: 0",
    "BogoMIPS\t: 108.00",
    "Revision\t: c03115",
    "Model\t\t: Raspberry Pi 4 Model B Rev 1.5",
  ].join("\n");
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]" },
    { "/proc/cpuinfo": cpuinfo },
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.piModel, "Raspberry Pi 4 Model B Rev 1.5");
});

Deno.test("handleGet parses RAM from /proc/meminfo", async () => {
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]" },
    { "/proc/meminfo": "MemTotal:       3886336 kB\nMemFree:        1500000 kB\n" },
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.ramMb, 3795);
});

Deno.test("handleGet returns kernel version from uname -r", async () => {
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]", "uname -r": "6.18.39+rpt-rpi-v8\n" },
    {},
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.kernel, "6.18.39+rpt-rpi-v8");
});

Deno.test("handleGet parses disk usage from df -h /", async () => {
  const dfOut = "Filesystem      Size  Used Avail Use% Mounted on\n/dev/mmcblk0p2   29G   11G   17G  39% /\n";
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]", "df -h /": dfOut },
    {},
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.disk?.used, "11G");
  assertEquals(data.disk?.total, "29G");
  assertEquals(data.disk?.percent, "39%");
});

Deno.test("handleGet reads CPU temperature from thermal_zone0", async () => {
  const api = makeApi(
    { "hostname": "kiosk-01", "ip -4 -json addr": "[]" },
    { "/sys/class/thermal/thermal_zone0/temp": "70600\n" },
  );
  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.cpuTemp, "70.6");
});
