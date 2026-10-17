#!/usr/bin/env python3
"""
pty_ws_server.py - ttyd drop-in replacement (pure Python, no external deps)

Implements ttyd's WebSocket protocol:
  Client→Server: '0'+data=INPUT, '1'+json=RESIZE
  Server→Client: '1'+data=OUTPUT, '2'+title=TITLE, '3'+json=PREFS
"""
import base64, fcntl, hashlib, json, os, pty, select, signal
import socket, struct, termios, threading

HOST = '127.0.0.1'
PORT = 7681
COMMAND = ['/bin/bash', '-l']
WS_GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_handshake(sock):
    raw = b''
    while b'\r\n\r\n' not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            return False
        raw += chunk
    headers = {}
    for line in raw.decode('utf-8', errors='replace').split('\r\n')[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    key = headers.get('sec-websocket-key', '')
    accept = base64.b64encode(
        hashlib.sha1(key.strip().encode() + WS_GUID).digest()
    ).decode()
    has_tty = 'tty' in headers.get('sec-websocket-protocol', '').lower()
    resp = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n'
        + ('Sec-WebSocket-Protocol: tty\r\n' if has_tty else '')
        + '\r\n'
    ).encode()
    sock.sendall(resp)
    return True


def ws_frame(data, opcode=2):
    if isinstance(data, str):
        data = data.encode()
    n = len(data)
    if n < 126:
        hdr = bytes([0x80 | opcode, n])
    elif n < 65536:
        hdr = bytes([0x80 | opcode, 126]) + struct.pack('>H', n)
    else:
        hdr = bytes([0x80 | opcode, 127]) + struct.pack('>Q', n)
    return hdr + data


def try_parse_frame(buf):
    if len(buf) < 2:
        return None
    b1 = buf[1]
    masked = bool(b1 & 0x80)
    short_len = b1 & 0x7f
    pos = 2
    if short_len == 126:
        if len(buf) < pos + 2:
            return None
        plen = struct.unpack('>H', buf[pos:pos + 2])[0]
        pos += 2
    elif short_len == 127:
        if len(buf) < pos + 8:
            return None
        plen = struct.unpack('>Q', buf[pos:pos + 8])[0]
        pos += 8
    else:
        plen = short_len
    mask = None
    if masked:
        if len(buf) < pos + 4:
            return None
        mask = bytes(buf[pos:pos + 4])
        pos += 4
    if len(buf) < pos + plen:
        return None
    raw = bytes(buf[pos:pos + plen])
    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw)) if mask else raw
    opcode = buf[0] & 0xf
    return payload, opcode, buf[pos + plen:]


def set_pty_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def handle(conn):
    pid = None
    master_fd = None
    done = threading.Event()
    try:
        if not ws_handshake(conn):
            return

        hostname = socket.gethostname()
        title = f'/bin/bash -l ({hostname})'
        conn.sendall(ws_frame(b'2' + title.encode()))
        conn.sendall(ws_frame(b'3{}'))

        master_fd, slave_fd = pty.openpty()
        pid = os.fork()
        if pid == 0:
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave_fd, fd)
            if slave_fd > 2:
                os.close(slave_fd)
            env = dict(os.environ)
            env.update({
                'TERM': 'xterm-256color',
                'HOME': '/root',
                'USER': 'root',
                'LOGNAME': 'root',
                'SHELL': '/bin/bash',
            })
            os.execve(COMMAND[0], COMMAND, env)
            os._exit(1)
        os.close(slave_fd)

        def pty_to_ws():
            while not done.is_set():
                try:
                    r, _, _ = select.select([master_fd], [], [], 0.5)
                    if r:
                        data = os.read(master_fd, 4096)
                        if data:
                            conn.sendall(ws_frame(b'1' + data))
                except OSError:
                    break
            done.set()
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass

        reader_thread = threading.Thread(target=pty_to_ws, daemon=True)
        reader_thread.start()

        ws_buf = b''
        while not done.is_set():
            try:
                conn.settimeout(1.0)
                chunk = conn.recv(4096)
                if not chunk:
                    break
                ws_buf += chunk
            except socket.timeout:
                continue
            except Exception:
                break
            while True:
                result = try_parse_frame(ws_buf)
                if result is None:
                    break
                payload, opcode, ws_buf = result
                if opcode == 8:
                    done.set()
                    break
                if opcode == 9:
                    conn.sendall(ws_frame(payload, 10))
                    continue
                if payload and opcode in (1, 2):
                    msg_type = payload[0]
                    if msg_type == 0x30:  # '0' = INPUT
                        try:
                            os.write(master_fd, payload[1:])
                        except OSError:
                            break
                    elif msg_type == 0x31:  # '1' = RESIZE
                        try:
                            d = json.loads(payload[1:].decode('utf-8', errors='replace'))
                            set_pty_size(master_fd, d.get('columns', 80), d.get('rows', 24))
                        except Exception:
                            pass
    except Exception:
        pass
    finally:
        done.set()
        if pid:
            try:
                os.kill(pid, signal.SIGHUP)
            except Exception:
                pass
            try:
                os.waitpid(pid, os.WNOHANG)
            except Exception:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


def main():
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(10)
    print(f'pty-ws-server listening on {HOST}:{PORT}', flush=True)
    while True:
        try:
            conn, _ = srv.accept()
            threading.Thread(target=handle, args=(conn,), daemon=True).start()
        except Exception:
            pass


if __name__ == '__main__':
    main()
