"""Check versioned checkout shell responses across server restarts."""
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen
import hashlib
import json
import shutil
import re

import inventory_api


class CheckoutShellTests(TestCase):
    def test_snapshot_is_immutable_and_other_revisions_are_rejected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            web = root / "web"
            shutil.copytree(inventory_api.WEB_DIR, web)
            with patch.object(inventory_api, "WEB_DIR", web):
                server = inventory_api.make_server(root / "store.sqlite", 0)
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    origin = f"http://127.0.0.1:{server.server_port}"
                    def get(path):
                        with urlopen(origin + path, timeout=3) as response:
                            return response.read()
                    html = get("/checkout")
                    revision = re.search(rb"/checkout\.js\?shell=([0-9a-f]{64})", html).group(1).decode()
                    self.assertIn(("/offline-store.js?shell=" + revision).encode(), html)
                    worker_script = get("/sw.js")
                    self.assertIn(revision.encode(), worker_script)
                    expected = json.loads(re.search(rb"const SHELL_HASHES = (.*);", worker_script).group(1))
                    for path, digest in expected.items():
                        self.assertEqual(hashlib.sha256(get(path + "?shell=" + revision)).hexdigest(), digest)
                    original = get("/checkout.js?shell=" + revision)
                    (web / "checkout.js").write_text("changed on disk")
                    self.assertEqual(get("/checkout.js?shell=" + revision), original)
                    with self.assertRaises(HTTPError) as error:
                        get("/checkout.js?shell=" + "0" * 64)
                    self.assertEqual(error.exception.code, 409)
                    with self.assertRaisesRegex(RuntimeError, "manifest invalid or stale"):
                        inventory_api.checkout_shell()
                finally:
                    server.shutdown()
                    worker.join()
                    server.server_close()

    def test_partial_install_is_rejected_before_database_initialization(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            web = root / "web"
            shutil.copytree(inventory_api.WEB_DIR, web)
            original_read = Path.read_bytes
            def changing_read(path):
                data = original_read(path)
                if path == web / "backup.html":
                    (web / "checkout.js").write_text("new release already installed")
                return data
            with patch.object(inventory_api, "WEB_DIR", web), patch.object(Path, "read_bytes", changing_read):
                with self.assertRaisesRegex(RuntimeError, "manifest invalid or stale"):
                    inventory_api.make_server(root / "not-created.sqlite", 0)
            self.assertFalse((root / "not-created.sqlite").exists())

    def test_cli_does_not_create_database_when_manifest_is_stale(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            web = root / "web"
            shutil.copytree(inventory_api.WEB_DIR, web)
            (web / "checkout.js").write_text("incomplete update")
            target = root / "not-created.sqlite"
            with patch.object(inventory_api, "WEB_DIR", web), patch("sys.argv", ["inventory_api.py", "--create-database", "--database", str(target)]):
                with self.assertRaises(SystemExit):
                    inventory_api.main()
            self.assertFalse(target.exists())
