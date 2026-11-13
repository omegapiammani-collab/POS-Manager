"""Verify the database identifier survives upgrades, concurrency and backups."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
import unittest
from urllib.request import urlopen
from uuid import UUID

from database_backup import copy_database, restore_database
from inventory import add_product, connect
from inventory_api import make_server


class StoreIdentityTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def open_server(self, path):
        server = make_server(path, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def identity(self, origin):
        with urlopen(origin + "/store-identity", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            value = json.load(response)["id"]
        self.assertEqual(str(UUID(value)), value)
        return value

    def test_new_databases_have_distinct_stable_ids(self):
        first_path = self.directory / "first.sqlite3"
        first = self.open_server(first_path)
        original = self.identity(first)
        self.assertEqual(self.identity(first), original)
        self.assertEqual(self.identity(self.open_server(first_path)), original)
        self.assertNotEqual(self.identity(self.open_server(self.directory / "second.sqlite3")), original)

    def test_existing_inventory_is_preserved_when_identity_is_added(self):
        path = self.directory / "legacy.sqlite3"
        with closing(connect(path)) as db:
            product_id, _ = add_product(db, "W01", "น้ำดื่ม", "ขวด", "10")
            self.assertIsNone(db.execute("SELECT name FROM sqlite_schema WHERE name='store_identity'").fetchone())
        origin = self.open_server(path)
        identity = self.identity(origin)
        with urlopen(origin + "/products", timeout=3) as response:
            products = json.load(response)
        self.assertEqual([row["id"] for row in products], [product_id])
        self.assertEqual(self.identity(self.open_server(path)), identity)

    def test_concurrent_initialization_chooses_one_identity(self):
        path = self.directory / "concurrent.sqlite3"
        # Prepare the legacy inventory schema before racing the server upgrades.
        with closing(connect(path)):
            pass
        barrier = Barrier(2)

        def initialize(_):
            barrier.wait(timeout=5)
            server = make_server(path, 0)
            try:
                with closing(sqlite3.connect(path)) as db:
                    return db.execute("SELECT id FROM store_identity WHERE singleton = 1").fetchone()[0]
            finally:
                server.server_close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(initialize, range(2)))
        self.assertEqual(ids[0], ids[1])
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM store_identity").fetchone()[0], 1)

    def test_backup_restore_and_clone_keep_the_same_identity(self):
        source = self.directory / "store.sqlite3"
        identity = self.identity(self.open_server(source))
        backup = self.directory / "backup.sqlite3"
        copy_database(source, backup)
        restored = self.directory / "restored.sqlite3"
        restore_database(backup, restored)
        self.assertEqual(self.identity(self.open_server(restored)), identity)
        self.assertEqual(self.identity(self.open_server(source)), identity)

    def test_backup_from_before_identity_gets_an_id_on_first_open(self):
        legacy = self.directory / "legacy.sqlite3"
        with closing(connect(legacy)):
            pass
        backup = self.directory / "legacy-backup.sqlite3"
        copy_database(legacy, backup)
        restored = self.directory / "legacy-restored.sqlite3"
        restore_database(backup, restored)
        restored_id = self.identity(self.open_server(restored))
        self.assertEqual(self.identity(self.open_server(restored)), restored_id)
        self.assertNotEqual(self.identity(self.open_server(legacy)), restored_id)


if __name__ == "__main__":
    unittest.main()
