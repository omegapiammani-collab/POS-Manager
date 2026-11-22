"""Protect the current local-only server boundary without opening a socket."""
from email.message import Message
from io import BytesIO
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from inventory_api import InventoryHandler, MAX_BODY, RequestError


class MemorySocket:
    """Exercise real HTTP parsing without binding a network socket."""
    def __init__(self, request):
        self.incoming = BytesIO(request)
        self.sent = bytearray()

    def makefile(self, mode, *args, **kwargs):
        if mode == "rb":
            return self.incoming
        raise AssertionError("Unexpected socket mode")

    def sendall(self, data):
        self.sent.extend(data)


class MemoryHandler(InventoryHandler):
    def serve_asset(self, route, name, content_type):
        return self.send_bytes(200, b"local page", "text/plain", "no-store")

    def log_message(self, *args):
        pass


class LocalSecurityTests(TestCase):
    def handler(self, host, peer="127.0.0.1", extra_headers=()):
        headers = Message()
        if host is not None:
            headers["Host"] = host
        for name, value in extra_headers:
            headers[name] = value
        return SimpleNamespace(
            headers=headers,
            client_address=(peer, 54321),
            server=SimpleNamespace(server_port=8765),
            command="GET",
            path="/database-backup",
            send_database_backup=Mock(return_value="backup"),
            send_json=Mock(),
        )

    def test_backup_checks_host_before_reading_database(self):
        for host in (None, "example.com:8765", "127.0.0.1:8766", "localhost", "127.0.0.1.example.com:8765"):
            with self.subTest(host=host):
                handler = self.handler(host)
                InventoryHandler.handle_request(handler)
                handler.send_database_backup.assert_not_called()
                self.assertEqual(handler.send_json.call_args[0][0], 403)

        for host in ("127.0.0.1:8765", "localhost:8765"):
            with self.subTest(host=host):
                handler = self.handler(host)
                self.assertEqual(InventoryHandler.handle_request(handler), "backup")
                handler.send_database_backup.assert_called_once_with()
                handler.send_json.assert_not_called()

    def test_remote_or_ambiguous_host_cannot_reach_any_sensitive_route(self):
        cases = [
            ("127.0.0.1:8765", "192.0.2.10", ()),
            ("localhost:8765", "203.0.113.8", (("X-Forwarded-For", "127.0.0.1"),)),
            ("localhost:8765", "bad address", ()),
            ("localhost:8765", "127.0.0.1", (("Host", "example.com:8765"),)),
        ]
        for route, command in (("/database-backup", "GET"), ("/store-identity", "GET"), ("/sales", "POST")):
            for host, peer, extra in cases:
                with self.subTest(route=route, host=host, peer=peer, extra=extra):
                    handler = self.handler(host, peer, extra)
                    handler.path = route
                    handler.command = command
                    InventoryHandler.handle_request(handler)
                    handler.send_database_backup.assert_not_called()
                    self.assertEqual(handler.send_json.call_args[0][0], 403)

    def test_forwarded_headers_do_not_override_real_loopback_peer(self):
        handler = self.handler("localhost:8765", extra_headers=(("X-Forwarded-For", "203.0.113.8"),))
        self.assertEqual(InventoryHandler.handle_request(handler), "backup")

    def test_raw_http_parsing_keeps_local_page_and_rejects_ambiguous_host(self):
        for headers, peer, expected in (
            (b"Host: localhost:8765\r\n", "127.0.0.1", b"200"),
            (b"Host: localhost:8765\r\nHost: evil.example\r\n", "127.0.0.1", b"403"),
            (b"Host: localhost:8765\r\nX-Forwarded-For: 127.0.0.1\r\n", "192.0.2.10", b"403"),
        ):
            with self.subTest(headers=headers, peer=peer):
                sock = MemorySocket(b"GET /checkout HTTP/1.1\r\n" + headers + b"Connection: close\r\n\r\n")
                MemoryHandler(sock, (peer, 12345), SimpleNamespace(server_port=8765), database=None, shell=None)
                self.assertEqual(bytes(sock.sent).split(b" ", 2)[1], expected)

    def test_post_body_requires_bounded_json_object(self):
        cases = [
            ("text/plain", b'{}', 415),
            ("application/x-www-form-urlencoded", b'a=1', 415),
            ("application/json", b'[]', 400),
            ("application/json", b'{', 400),
            ("application/json", b'', 400),
            ("application/json", b' ' * (MAX_BODY + 1), 413),
        ]
        for content_type, body, status in cases:
            with self.subTest(content_type=content_type, length=len(body)):
                headers = Message()
                headers["Content-Type"] = content_type
                headers["Content-Length"] = str(len(body))
                handler = SimpleNamespace(headers=headers, rfile=BytesIO(body))
                with self.assertRaises(RequestError) as error:
                    InventoryHandler.read_json(handler)
                self.assertEqual(error.exception.status, status)

        headers = Message()
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = "2"
        self.assertEqual(InventoryHandler.read_json(SimpleNamespace(headers=headers, rfile=BytesIO(b'{}'))), {})
