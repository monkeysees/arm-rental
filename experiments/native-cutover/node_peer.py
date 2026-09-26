"""Local TLS proxy for the immutable Node image's fixed HTTPS origins."""

from __future__ import annotations

import http.client
from pathlib import Path
import socketserver
import ssl
import threading

from common import command


HOSTS = {"api.telegram.org", "api.cba.am", "www.list.am"}


def _certificate(directory: Path) -> Path:
    directory.mkdir(mode=0o711, parents=True)
    ca = directory / "ca.pem"
    ca_key = directory / "ca.key"
    key = directory / "peer.key"
    request = directory / "peer.csr"
    certificate = directory / "peer.pem"
    extensions = directory / "peer.ext"
    extensions.write_text(
        "subjectAltName=DNS:api.telegram.org,DNS:api.cba.am,DNS:www.list.am\n"
        "extendedKeyUsage=serverAuth\n"
        "basicConstraints=CA:FALSE\n",
        encoding="utf-8",
    )
    command([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-days", "1", "-keyout", str(ca_key), "-out", str(ca),
        "-subj", "/CN=disposable-cutover-ca",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ])
    command([
        "openssl", "req", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", str(key), "-out", str(request),
        "-subj", "/CN=api.telegram.org",
    ])
    command([
        "openssl", "x509", "-req", "-in", str(request), "-CA", str(ca),
        "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(certificate),
        "-days", "1", "-sha256", "-extfile", str(extensions),
    ])
    ca.chmod(0o644)
    return ca


class NodePeerProxy:
    """Accept only local CONNECT tunnels for the three production HTTPS hosts."""

    def __init__(self, output: Path, peer):
        self.ca = _certificate(output / "node-peer-tls")
        self.peer = peer
        self.paths: list[tuple[str, str]] = []
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(
            str(self.ca.parent / "peer.pem"), str(self.ca.parent / "peer.key")
        )
        self.context.set_alpn_protocols(["http/1.1"])
        proxy = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                line = self.rfile.readline(8192).decode("ascii", "replace")
                parts = line.split()
                if len(parts) != 3 or parts[0] != "CONNECT":
                    return
                host, separator, port = parts[1].rpartition(":")
                if not separator or host not in HOSTS or port != "443":
                    self.connection.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    return
                while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):
                    pass
                self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                try:
                    tunnel = proxy.context.wrap_socket(self.connection, server_side=True)
                except ssl.SSLError:
                    return
                with tunnel as tls:
                    reader = tls.makefile("rb")
                    request_line = reader.readline(8192).decode("ascii", "replace").split()
                    if len(request_line) != 3:
                        return
                    method, path, _ = request_line
                    headers = {}
                    while (header := reader.readline(8192)) not in (b"\r\n", b"\n", b""):
                        name, _, value = header.decode("latin-1").partition(":")
                        headers[name.lower()] = value.strip()
                    body = reader.read(int(headers.get("content-length", "0")))
                    if host == "api.cba.am":
                        path = "/cba"
                    proxy.paths.append((host, path))
                    connection = http.client.HTTPConnection("127.0.0.1", proxy.peer.server.server_port, timeout=5)
                    try:
                        connection.request(method, path, body=body, headers={
                            "content-type": headers.get("content-type", "application/json")
                        })
                        response = connection.getresponse()
                        payload = response.read()
                        content_type = response.getheader("content-type", "application/octet-stream")
                        response_headers = (
                            f"HTTP/1.1 {response.status} {response.reason}\r\n"
                            f"Content-Type: {content_type}\r\n"
                            f"Content-Length: {len(payload)}\r\n"
                            "Connection: close\r\n\r\n"
                        ).encode("ascii")
                        tls.sendall(response_headers + payload)
                    finally:
                        connection.close()

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
