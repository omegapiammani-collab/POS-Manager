"""Protect the current local-only server boundary without opening a socket."""
from email.message import Message
from io import BytesIO
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from inventory_api import InventoryHandler, MAX_BODY, RequestError


class LocalSecurityTests(TestCase):
    def handler(self, host):
        headers = Message()
        if host is not None:
            headers["Host"] = host
        return SimpleNamespace(
            headers=headers,
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
