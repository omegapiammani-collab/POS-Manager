"""Verify that an HTTP snapshot can restore a working POS database."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from uuid import uuid4

from inventory_api import make_server


DAY = "2026-11-12"
BACKUP_SCRIPT = Path(__file__).with_name("database_backup.py")


class DatabaseBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.database = self.directory / "live.sqlite3"
        self.origin = self.start_server(self.database)

    def start_server(self, database):
        server = make_server(database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def request(self, path, payload=None, *, origin=None):
        request = Request(
            (origin or self.origin) + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200 if payload is None else 201)
            return json.load(response)

    def seed(self):
        product = self.request("/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.request(f"/products/{product['id']}/receipts", {
            "unit_id": product["base_unit_id"], "quantity": "5", "unit_cost": "4",
        })
        sale = self.request("/sales", {
            "id": str(uuid4()),
            "items": [{
                "product_id": product["id"], "unit_id": product["base_unit_id"],
                "quantity": "2", "expected_unit_price": "10",
            }],
            "payments": {"cash": "20", "qr": "0", "credit": "0"},
            "customer_id": None, "qr_confirmed": False,
        })
        expense = self.request("/expenses", {
            "id": str(uuid4()), "date": DAY, "description": "ค่าถุง", "amount": "12.50",
            "source": "cash_drawer",
        })
        self.request("/cash-drawer/open", {"id": str(uuid4()), "date": DAY, "opening_cash": "100"})
        drawer = self.request("/cash-drawer/movements", {
            "id": str(uuid4()), "date": DAY, "direction": "in", "amount": "20", "reason": "เติมเงินทอน",
        })
        return sale, expense, drawer

    def download(self):
        with urlopen(self.origin + "/database-backup", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "application/vnd.sqlite3")
            self.assertIn("attachment", response.headers.get("Content-Disposition", "").lower())
            snapshot = response.read()
        self.assertTrue(snapshot.startswith(b"SQLite format 3\x00"))
        backup = self.directory / "backup.sqlite3"
        backup.write_bytes(snapshot)
        return backup

    def restore(self, backup, target):
        return subprocess.run(
            [sys.executable, str(BACKUP_SCRIPT), "restore", str(backup), str(target)],
            capture_output=True, text=True, timeout=10, check=False,
        )

    def test_download_with_live_wal_and_restore_working_database(self):
        with closing(sqlite3.connect(self.database)) as source:
            self.assertEqual(source.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
            source.execute("BEGIN")
            source.execute("SELECT count(*) FROM products").fetchone()
            sale, expense, drawer = self.seed()
            self.assertTrue(self.database.with_suffix(".sqlite3-wal").is_file())
            backup = self.download()

        with closing(sqlite3.connect(backup)) as snapshot:
            self.assertEqual(snapshot.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(snapshot.execute("SELECT id, total FROM sales").fetchone(), (sale["id"], "20.00"))
            self.assertEqual(snapshot.execute("SELECT id, amount FROM expenses").fetchone(), (expense["id"], "12.50"))
            self.assertEqual(snapshot.execute("SELECT opening_cash FROM cash_drawers").fetchone(), ("100.00",))
            self.assertEqual(snapshot.execute("SELECT amount FROM drawer_movements").fetchone(), ("20.00",))

        self.request("/expenses", {
            "id": str(uuid4()), "date": DAY, "description": "หลังสำรอง", "amount": "3.00",
            "source": "external",
        })
        restored = self.directory / "restored.sqlite3"
        result = self.restore(backup, restored)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        origin = self.start_server(restored)
        self.assertEqual(self.request(f"/sales/{sale['id']}", origin=origin), sale)
        self.assertEqual(self.request(f"/expenses?from={DAY}&to={DAY}", origin=origin), [expense])
        self.assertEqual(self.request(f"/cash-drawer?date={DAY}", origin=origin), drawer)

    def test_restore_does_not_overwrite_existing_target(self):
        backup = self.download()
        target = self.directory / "existing.sqlite3"
        original = b"existing data must remain untouched"
        target.write_bytes(original)
        result = self.restore(backup, target)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), original)

    def test_backup_restores_abandoned_sale_guard_and_legacy_database_still_opens(self):
        product = self.request("/products", {"code": "W01", "name": "น้ำ", "base_unit": "ขวด", "price": "10"})
        sale_id = str(uuid4())
        sale = {"id": sale_id, "items": [{"product_id": product["id"], "unit_id": product["base_unit_id"],
                 "quantity": "1", "expected_unit_price": "10"}],
                "payments": {"cash": "10", "qr": "0", "credit": "0"}, "customer_id": None, "qr_confirmed": False}
        req = Request(self.origin + f"/sales/{sale_id}/abandon", data=b"{}", headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
        backup = self.download()
        restored = self.directory / "abandoned-restored.sqlite3"
        self.assertEqual(self.restore(backup, restored).returncode, 0)
        origin = self.start_server(restored)
        req = Request(origin + "/offline-sales", data=json.dumps(sale).encode(), headers={"Content-Type": "application/json"})
        with self.assertRaises(HTTPError) as raised:
            urlopen(req, timeout=5)
        self.assertEqual(raised.exception.code, 409)
        self.assertEqual(json.load(raised.exception)["code"], "sale_abandoned")
        legacy = self.directory / "legacy.sqlite3"
        legacy.write_bytes(backup.read_bytes())
        with sqlite3.connect(legacy) as db:
            db.execute("DROP TABLE abandoned_sales")
        legacy_restored = self.directory / "legacy-restored.sqlite3"
        self.assertEqual(self.restore(legacy, legacy_restored).returncode, 0)
        self.start_server(legacy_restored)
        with sqlite3.connect(legacy_restored) as db:
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_schema WHERE name='abandoned_sales'").fetchone())

    def test_restore_rejects_corrupt_and_unrelated_sqlite_without_creating_target(self):
        corrupt = self.directory / "corrupt.sqlite3"
        corrupt.write_bytes(b"this is not a database")
        unrelated = self.directory / "unrelated.sqlite3"
        with closing(sqlite3.connect(unrelated)) as connection:
            connection.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
        for backup in (corrupt, unrelated):
            with self.subTest(backup=backup.name):
                target = self.directory / "invalid-output.sqlite3"
                result = self.restore(backup, target)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(target.exists())
