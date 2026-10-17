// TERMINAL_HTML is served at GET /terminal (admin-only).
// Loads xterm.js from CDN and connects to /tty-ws using the ttyd WebSocket protocol:
//   server → client: TEXT frame, char[0]='1' means OUTPUT, rest is UTF-8 text
//                    char[0]='3' = SET_WINDOW_TITLE, char[0]='4' = SET_PREFERENCES
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
    #terminal { padding: 4px; height: calc(100% - 22px); box-sizing: border-box; }
    #term-status { position: fixed; bottom: 0; left: 0; right: 0; height: 22px; background: #111; color: #0c0; font-family: monospace; font-size: 11px; padding: 3px 8px; box-sizing: border-box; border-top: 1px solid #333; white-space: nowrap; overflow: hidden; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="term-status">Baglaniyor...</div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const statusEl = document.getElementById('term-status');
    let keyCount = 0;
    function setStatus(msg) { statusEl.textContent = msg; }

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
      term.focus();
      setTimeout(() => term.focus(), 200);
      setStatus('Baglandi — terminale tiklayin ve yazin');
    });

    // Any click anywhere on the page focuses the terminal
    document.addEventListener('click', () => term.focus());

    ws.addEventListener('message', (event) => {
      // ttyd sends TEXT frames; handle binary as fallback for alternative backends
      if (typeof event.data === 'string') {
        if (event.data.length > 0 && event.data[0] === '1') {
          term.write(event.data.slice(1));
        }
      } else if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data);
        // byte 49 = ASCII '1' = OUTPUT; byte 1 = legacy binary protocol
        if (data[0] === 49 || data[0] === 1) {
          term.write(new TextDecoder().decode(data.slice(1)));
        }
      }
    });

    term.onData((data) => {
      keyCount++;
      setStatus('Gonderildi: ' + keyCount + ' tus | WS: ' + (ws.readyState === 1 ? 'ACIK' : 'KAPALI'));
      if (ws.readyState === WebSocket.OPEN) ws.send('0' + data);
    });

    term.onFocus(() => setStatus('ODAKLANMIS — yazabilirsiniz'));
    term.onBlur(() => setStatus('ODAK YOK — terminale tiklayin'));

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('1' + JSON.stringify({ columns: cols, rows }));
      }
    });

    if (fitAddon) window.addEventListener('resize', () => { fitAddon.fit(); });
    ws.addEventListener('close', () => { term.write('\\r\\n[Baglanti kesildi]\\r\\n'); setStatus('Baglanti kesildi'); });
    ws.addEventListener('error', () => { term.write('\\r\\n[Baglanti hatasi]\\r\\n'); setStatus('Baglanti hatasi'); });
  </script>
</body>
</html>`;
