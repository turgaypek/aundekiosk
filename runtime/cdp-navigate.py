#!/usr/bin/env python3
"""Navigate the first Chromium tab via DevTools Protocol (CDP).

Usage: cdp-navigate.py <url>

Requires Chromium started with:
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
"""

import sys
import json
import socket
import struct
import base64
import urllib.request

def navigate(url: str, host: str = "127.0.0.1", port: int = 9222) -> None:
    tabs_json = urllib.request.urlopen(f"http://{host}:{port}/json", timeout=3).read()
    tabs = json.loads(tabs_json)
    if not tabs:
        raise RuntimeError("No tabs found — is Chromium running with --remote-debugging-port=9222?")
    ws_url = tabs[0]["webSocketDebuggerUrl"]
    path = ws_url.split(f"{host}:{port}", 1)[1]

    s = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(b"aundekiosk00000=").decode()
    s.sendall((
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    ).encode())

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("WebSocket handshake failed")
        buf += chunk

    msg = json.dumps({"id": 1, "method": "Page.navigate", "params": {"url": url}}).encode()
    mask = b"\x01\x02\x03\x04"
    header = bytearray([0x81])  # FIN + text opcode
    n = len(msg)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", n)
    header += mask
    body = bytes(b ^ mask[i % 4] for i, b in enumerate(msg))
    s.sendall(bytes(header) + body)
    s.close()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <url>", file=sys.stderr)
        sys.exit(1)
    navigate(sys.argv[1])
