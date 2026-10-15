import { assertEquals } from "./test_util.ts";
import { createTtyProxy } from "./tty_proxy.ts";

async function fakeWsBackend(): Promise<{
  server: Deno.HttpServer;
  url: string;
  firstSocket: Promise<WebSocket>;
}> {
  let resolveSocket!: (ws: WebSocket) => void;
  const firstSocket = new Promise<WebSocket>((r) => { resolveSocket = r; });
  let resolvePort!: (p: number) => void;
  const portPromise = new Promise<number>((r) => { resolvePort = r; });
  const server = Deno.serve(
    { port: 0, onListen: (a) => resolvePort(a.port) },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => resolveSocket(socket));
      return response;
    },
  );
  const port = await portPromise;
  return { server, url: `ws://127.0.0.1:${port}/ws`, firstSocket };
}

async function proxyServer(backendUrl: string): Promise<{
  server: Deno.HttpServer;
  port: number;
}> {
  const proxy = createTtyProxy({ backendUrl });
  let resolvePort!: (p: number) => void;
  const portPromise = new Promise<number>((r) => { resolvePort = r; });
  const server = Deno.serve(
    { port: 0, onListen: (addr) => resolvePort(addr.port) },
    (req) => proxy.handleUpgrade(req),
  );
  const port = await portPromise;
  return { server, port };
}

Deno.test("ttyProxy: closes WS with 1011 when backend unavailable", async () => {
  const proxy = createTtyProxy({ backendUrl: "ws://127.0.0.1:1/ws" });
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

  // 1011 (backend error) or 1006 (abnormal closure) depending on timing
  assertEquals(closeCode === 1011 || closeCode === 1006, true);
  await server.shutdown();
});

Deno.test("ttyProxy: relays text message from client to backend", async () => {
  const { server: backServer, url: backUrl, firstSocket: backSocketPromise } = await fakeWsBackend();
  const { server: proxyServer_, port: wsPort } = await proxyServer(backUrl);

  const client = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const clientOpen = new Promise<void>((r) => client.addEventListener("open", () => r()));
  const [, backSocket] = await Promise.all([clientOpen, backSocketPromise]);

  await new Promise((r) => setTimeout(r, 10));

  const received = new Promise<string>((r) => {
    backSocket.addEventListener("message", (e) => r(String(e.data)));
  });
  client.send("0hello");
  assertEquals(await received, "0hello");

  client.close();
  backSocket.close();
  await backServer.shutdown();
  await proxyServer_.shutdown();
});

Deno.test("ttyProxy: relays binary message from backend to client", async () => {
  const { server: backServer, url: backUrl, firstSocket: backSocketPromise } = await fakeWsBackend();
  const { server: proxyServer_, port: wsPort } = await proxyServer(backUrl);

  const client = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  client.binaryType = "arraybuffer";
  const clientOpen = new Promise<void>((r) => client.addEventListener("open", () => r()));
  const [, backSocket] = await Promise.all([clientOpen, backSocketPromise]);

  await new Promise((r) => setTimeout(r, 10));

  const received = new Promise<ArrayBuffer>((r) => {
    client.addEventListener("message", (e) => r(e.data as ArrayBuffer));
  });
  backSocket.send(new Uint8Array([0x01, 0x41, 0x42])); // type=OUTPUT, data="AB"
  assertEquals(Array.from(new Uint8Array(await received)).join(","), "1,65,66");

  client.close();
  backSocket.close();
  await backServer.shutdown();
  await proxyServer_.shutdown();
});
