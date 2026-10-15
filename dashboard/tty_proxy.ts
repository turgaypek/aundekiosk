export interface TtyProxyOptions {
  backendUrl?: string;
}

export function createTtyProxy(opts: TtyProxyOptions = {}) {
  const backendUrl = opts.backendUrl ?? "ws://127.0.0.1:7681/ws";

  function handleUpgrade(req: Request): Response {
    const { socket: client, response } = Deno.upgradeWebSocket(req);

    client.addEventListener("open", () => {
      const backend = new WebSocket(backendUrl);

      backend.addEventListener("open", () => {
        client.addEventListener("message", (e) => {
          if (backend.readyState === WebSocket.OPEN) backend.send(e.data);
        });
        backend.addEventListener("message", (e) => {
          if (client.readyState === WebSocket.OPEN) client.send(e.data);
        });
      });

      // If ttyd is not running, backend fires "error" before "open"
      backend.addEventListener("error", () => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1011, "Terminal backend unavailable");
        }
      });

      backend.addEventListener("close", () => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, "Terminal closed");
        }
      });

      client.addEventListener("close", () => {
        if (
          backend.readyState !== WebSocket.CLOSED &&
          backend.readyState !== WebSocket.CLOSING
        ) {
          backend.close();
        }
      });
    });

    return response;
  }

  return { handleUpgrade };
}
