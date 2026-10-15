import { assertEquals } from "./test_util.ts";
import { createNoVncProxy } from "./novnc_proxy.ts";

async function fakeTcpServer(): Promise<{
  listener: Deno.Listener;
  port: number;
  firstConn: Promise<Deno.TcpConn>;
}> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const firstConn = listener.accept() as Promise<Deno.TcpConn>;
  return { listener, port, firstConn };
}

async function proxyServer(backendPort: number): Promise<{
  server: Deno.HttpServer;
  port: number;
}> {
  const proxy = createNoVncProxy({ backendPort });
  let resolvePort!: (p: number) => void;
  const portPromise = new Promise<number>((r) => { resolvePort = r; });
  const server = Deno.serve(
    { port: 0, onListen: (addr) => resolvePort(addr.port) },
    (req) => proxy.handleUpgrade(req),
  );
  const port = await portPromise;
  return { server, port };
}

Deno.test("noVncProxy: closes WS with 1011 when backend TCP unavailable", async () => {
  const proxy = createNoVncProxy({ backendPort: 1 });
  let resolvePort!: (p: number) => void;
  const portPromise = new Promise<number>((r) => { resolvePort = r; });
  const server = Deno.serve(
    { port: 0, onListen: (addr) => resolvePort(addr.port) },
    (req) => proxy.handleUpgrade(req),
  );
  const port = await portPromise;

  let closeCode = -1;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener("close", (e) => { closeCode = e.code; resolve(); });
    ws.addEventListener("error", () => resolve());
  });

  assertEquals(closeCode, 1011);
  await server.shutdown();
});

Deno.test("noVncProxy: relays binary from WS client to TCP backend", async () => {
  const { listener, port: tcpPort, firstConn: tcpPromise } = await fakeTcpServer();
  const { server, port: wsPort } = await proxyServer(tcpPort);

  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const wsOpen = new Promise<void>((r) => ws.addEventListener("open", () => r()));
  const [, tcpConn] = await Promise.all([wsOpen, tcpPromise]);

  await new Promise((r) => setTimeout(r, 10));

  ws.send(new Uint8Array([0x01, 0x02, 0x03]).buffer);

  const buf = new Uint8Array(3);
  let read = 0;
  while (read < 3) {
    const n = await tcpConn.read(buf.subarray(read));
    if (n === null) break;
    read += n;
  }
  assertEquals(Array.from(buf).join(","), "1,2,3");

  ws.close();
  tcpConn.close();
  listener.close();
  await server.shutdown();
});

Deno.test("noVncProxy: relays binary from TCP backend to WS client", async () => {
  const { listener, port: tcpPort, firstConn: tcpPromise } = await fakeTcpServer();
  const { server, port: wsPort } = await proxyServer(tcpPort);

  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  ws.binaryType = "arraybuffer";
  const wsOpen = new Promise<void>((r) => ws.addEventListener("open", () => r()));
  const [, tcpConn] = await Promise.all([wsOpen, tcpPromise]);

  await new Promise((r) => setTimeout(r, 10));

  const received = new Promise<ArrayBuffer>((r) => {
    ws.addEventListener("message", (e) => r(e.data as ArrayBuffer));
  });
  await tcpConn.write(new Uint8Array([0xAA, 0xBB]));
  assertEquals(Array.from(new Uint8Array(await received)).join(","), "170,187");

  ws.close();
  tcpConn.close();
  listener.close();
  await server.shutdown();
});
