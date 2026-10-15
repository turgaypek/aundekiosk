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
