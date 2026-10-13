import { createRemoteAccessApi } from "./remote_access_api.ts";
import { assertEquals } from "./test_util.ts";

Deno.test("handleStatus returns the status of both ssh and vnc", async () => {
  const api = createRemoteAccessApi({
    checkServiceStatus: async (service: string) => (service === "ssh" ? "active" : "inactive"),
  });
  const res = await api.handleStatus();
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ssh, "active");
  assertEquals(body.vnc, "inactive");
});
