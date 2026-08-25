#!/usr/bin/env python3
"""Tiny TLS-terminating proxy that fixes the Host header and forwards to
https://llm.int.exe.xyz (the exe.dev LLM integration endpoint).

The endpoint only resolves inside exe infra (link-local 169.254.169.254) and
routes on the Host header, so a plain `ssh -L` tunnel from outside cannot reach
it. Instead, run this proxy ON an attached VM and tunnel to the proxy:

  vm$   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
          -subj /CN=localhost -keyout exe-llm.key -out exe-llm.crt
  vm$   python3 exe-llm-proxy.py --listen 127.0.0.1:7071 \
          --tls-cert exe-llm.crt --tls-key exe-llm.key
  you$  ssh -L 7070:127.0.0.1:7071 <yourinstance>.exe.xyz
  you$  export LLM_BASE_URL=https://localhost:7070

The endpoint is keyless (the VM's edge authenticates it), so no API key is
needed; LLM_API_KEY stays unset. Because the proxy serves self-signed TLS,
clients must trust exe-llm.crt: NODE_EXTRA_CA_CERTS=exe-llm.crt for Node,
SSL_CERT_FILE=exe-llm.crt for curl/python/requests.
"""
import argparse
import socket
import ssl
import threading

UPSTREAM_HOST = "llm.int.exe.xyz"   # Host header sent upstream (edge auth + routing)
UPSTREAM_ADDR = ("169.254.169.254", 443)
BUF = 1 << 16
HEAD_LIMIT = 1 << 20

# The upstream leg is always TLS. Verification is disabled because the tunnel's
# security comes from ssh, not from PKI; SNI still says llm.int.exe.xyz.
SSL_CLIENT_CTX = ssl.create_default_context()
SSL_CLIENT_CTX.check_hostname = False
SSL_CLIENT_CTX.verify_mode = ssl.CERT_NONE

def pump(src: socket.socket, dst: socket.socket):
    try:
        while True:
            data = src.recv(BUF)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try: dst.shutdown(socket.SHUT_WR)
        except OSError: pass
        try: dst.close()
        except OSError: pass

def handle(client: socket.socket):
    try:
        client.settimeout(30)
        head = bytearray()
        while b"\r\n\r\n" not in head:
            chunk = client.recv(BUF)
            if not chunk:
                client.close(); return
            head += chunk
            if len(head) > HEAD_LIMIT:
                client.close(); return
        # Rewrite/add the Host header inside the request head only.
        raw = bytes(head)
        head_part, rest = raw.split(b"\r\n\r\n", 1) if b"\r\n\r\n" in raw else (raw, b"")
        lines = head_part.split(b"\r\n")
        out, replaced = [], False
        for line in lines:
            if line.lower().startswith(b"host:"):
                out.append(b"Host: " + UPSTREAM_HOST.encode()); replaced = True
            else:
                out.append(line)
        if not replaced:
            out.insert(1, b"Host: " + UPSTREAM_HOST.encode())
        upstream = socket.create_connection(UPSTREAM_ADDR, timeout=15)
        upstream = SSL_CLIENT_CTX.wrap_socket(upstream, server_hostname=UPSTREAM_HOST)
        first = b"\r\n".join(out) + (b"\r\n\r\n" if b"\r\n\r\n" in raw else b"") + rest
        upstream.sendall(first)
        client.settimeout(None)
        t = threading.Thread(target=pump, args=(client, upstream), daemon=True)
        t.start()
        pump(upstream, client)
    except Exception:
        pass
    finally:
        try: client.close()
        except OSError: pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:7071")
    ap.add_argument("--tls-cert", help="serve TLS with this cert (PEM)")
    ap.add_argument("--tls-key", help="TLS key (PEM)")
    args = ap.parse_args()
    host, port = args.listen.rsplit(":", 1)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, int(port)))
    srv.listen(64)
    tls_ctx = None
    if args.tls_cert:
        tls_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_ctx.load_cert_chain(args.tls_cert, args.tls_key)
        print("serving TLS", flush=True)
    print(f"exe-llm-proxy listening on {args.listen} -> {UPSTREAM_ADDR} (Host: {UPSTREAM_HOST})", flush=True)
    while True:
        conn, _ = srv.accept()
        if tls_ctx is not None:
            try:
                conn = tls_ctx.wrap_socket(conn, server_side=True)
            except ssl.SSLError:
                conn.close(); continue
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
