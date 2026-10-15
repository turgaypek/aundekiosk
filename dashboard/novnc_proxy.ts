export interface NoVncProxyOptions {
  backendHostname?: string;
  backendPort?: number;
}

export function createNoVncProxy(opts: NoVncProxyOptions = {}) {
  const backendHostname = opts.backendHostname ?? "127.0.0.1";
  const backendPort = opts.backendPort ?? 5900;

  function handleUpgrade(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", async () => {
      let tcp: Deno.TcpConn;
      try {
        tcp = await Deno.connect({ hostname: backendHostname, port: backendPort });
      } catch {
        socket.close(1011, "VNC backend unavailable");
        return;
      }

      // tcp → ws: relay raw VNC bytes as binary WebSocket frames
      (async () => {
        const buf = new Uint8Array(65536);
        try {
          while (true) {
            const n = await tcp.read(buf);
            if (n === null) break;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(buf.slice(0, n));
            }
          }
        } catch { /* backend closed */ }
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, "VNC backend closed");
        }
      })();

      // ws → tcp: relay client frames to VNC backend
      socket.addEventListener("message", (event) => {
        const data =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : new TextEncoder().encode(String(event.data));
        tcp.write(data).catch(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1011);
        });
      });

      socket.addEventListener("close", () => {
        try { tcp.close(); } catch { /* already closed */ }
      });
    });

    return response;
  }

  return { handleUpgrade };
}
