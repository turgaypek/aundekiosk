// TERMINAL_HTML is served at GET /terminal (admin-only).
// Loads xterm.js from CDN and connects to /tty-ws using the ttyd WebSocket protocol:
//   server → client: binary frame, byte[0]=1 means OUTPUT, byte[1:] is UTF-8 text
//   client → server: text frame, "0" + input | "1" + JSON resize
export const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AundeKiosk Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <style>
    html, body { margin: 0; padding: 0; background: #1e1e1e; height: 100%; overflow: hidden; }
    #terminal { padding: 4px; height: 100%; box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const term = new Terminal({ cursorBlink: true, theme: { background: '#1e1e1e' } });

    // AddonFit may or may not load (CDN); fall back to fixed size gracefully
    let fitAddon = null;
    try { fitAddon = new AddonFit.FitAddon(); term.loadAddon(fitAddon); } catch (_) {}

    term.open(document.getElementById('terminal'));
    if (fitAddon) fitAddon.fit();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/tty-ws');
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      ws.send('1' + JSON.stringify({ columns: term.cols, rows: term.rows }));
    });

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data);
        if (data[0] === 1) {
          term.write(new TextDecoder().decode(data.slice(1)));
        }
      }
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send('0' + data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('1' + JSON.stringify({ columns: cols, rows }));
      }
    });

    if (fitAddon) window.addEventListener('resize', () => { fitAddon.fit(); });
    ws.addEventListener('close', () => term.write('\\r\\n[Connection closed]\\r\\n'));
    ws.addEventListener('error', () => term.write('\\r\\n[Connection error — check that the TTY service is running]\\r\\n'));
  </script>
</body>
</html>`;
