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
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_store_headers import store_headers
from uuid import uuid4

from inventory_api import make_server
import database_backup


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
            headers=store_headers(origin or self.origin),
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
        with urlopen(self.origin + "/store-identity") as original_response, urlopen(origin + "/store-identity") as restored_response:
            original_identity, restored_identity = json.load(original_response), json.load(restored_response)
            self.assertEqual(original_identity["id"], restored_identity["id"])
            self.assertNotEqual(original_identity["binding_id"], restored_identity["binding_id"])
            self.assertIn(original_identity["binding_id"], restored_identity["restore_ancestors"])
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

    def test_restore_rotates_only_target_binding_and_rejects_old_client_after_lost_response(self):
        product = self.request("/products", {"code": "W01", "name": "น้ำ", "base_unit": "ขวด", "price": "10"})
        self.request(f"/products/{product['id']}/receipts", {"unit_id": product["base_unit_id"], "quantity": "2", "unit_cost": "4"})
        with urlopen(self.origin + "/store-identity") as response:
            before_identity = json.load(response)
        backup = self.download()
        backup_bytes = backup.read_bytes()
        sale = {"id": str(uuid4()), "items": [{"product_id": product["id"], "unit_id": product["base_unit_id"],
                "quantity": "1", "expected_unit_price": "10"}],
                "payments": {"cash": "10", "qr": "0", "credit": "0"}, "customer_id": None, "qr_confirmed": False}
        recorded = self.request("/sales", sale)
        restored = self.directory / "restored-old.sqlite3"
        self.assertEqual(self.restore(backup, restored).returncode, 0)
        self.assertEqual(backup.read_bytes(), backup_bytes)
        with urlopen(self.origin + "/store-identity") as response:
            self.assertEqual(json.load(response), before_identity)
        restored_origin = self.start_server(restored)
        with urlopen(restored_origin + "/store-identity") as response:
            restored_identity = json.load(response)
        self.assertEqual(restored_identity["id"], before_identity["id"])
        self.assertNotEqual(restored_identity["binding_id"], before_identity["binding_id"])
        self.assertIn(before_identity["binding_id"], restored_identity["restore_ancestors"])
        headers = {"Content-Type": "application/json", "X-POS-Store-ID": before_identity["binding_id"]}
        for route, body in (("/sales", sale), ("/offline-sales", sale), ("/sales/allow-negative", sale),
                            (f"/sales/{sale['id']}/abandon", {})):
            req = Request(restored_origin + route, data=json.dumps(body).encode(), headers=headers)
            with self.subTest(route=route), self.assertRaises(HTTPError) as rejected:
                urlopen(req, timeout=5)
            self.assertEqual(rejected.exception.code, 409)
            self.assertEqual(json.load(rejected.exception)["code"], "store_mismatch")
        with self.assertRaises(HTTPError) as missing:
            self.request(f"/sales/{sale['id']}", origin=restored_origin)
        self.assertEqual(missing.exception.code, 404)
        self.assertEqual(self.request(f"/sales/{sale['id']}"), recorded)

    def test_backup_restores_abandoned_sale_guard_and_legacy_database_still_opens(self):
        product = self.request("/products", {"code": "W01", "name": "น้ำ", "base_unit": "ขวด", "price": "10"})
        sale_id = str(uuid4())
        sale = {"id": sale_id, "items": [{"product_id": product["id"], "unit_id": product["base_unit_id"],
                 "quantity": "1", "expected_unit_price": "10"}],
                "payments": {"cash": "10", "qr": "0", "credit": "0"}, "customer_id": None, "qr_confirmed": False}
        req = Request(self.origin + f"/sales/{sale_id}/abandon", data=b"{}", headers=store_headers(self.origin))
        with urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
        backup = self.download()
        restored = self.directory / "abandoned-restored.sqlite3"
        self.assertEqual(self.restore(backup, restored).returncode, 0)
        origin = self.start_server(restored)
        req = Request(origin + "/offline-sales", data=json.dumps(sale).encode(), headers=store_headers(origin))
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

    def test_customer_request_backup_validation_and_legacy_migration(self):
        customer = self.request("/customers", {"name": "คำขอ", "request_id": str(uuid4())})
        snapshot = self.download().read_bytes()
        cases = {
            "missing_fk": ["DROP TABLE customer_requests", "CREATE TABLE customer_requests (request_id TEXT PRIMARY KEY, name TEXT NOT NULL, customer_id TEXT NOT NULL)"],
            "missing_name": ["ALTER TABLE customer_requests DROP COLUMN name"],
            "missing_primary_key": ["DROP TABLE customer_requests", "CREATE TABLE customer_requests (request_id TEXT, name TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id))"],
            "bad_request_id": ["UPDATE customer_requests SET request_id = 'bad'"],
            "bad_name": ["UPDATE customer_requests SET name = 'อื่น'"],
            "missing_customer": ["UPDATE customer_requests SET customer_id = 'missing'"],
        }
        for name, statements in cases.items():
            with self.subTest(case=name):
                source = self.directory / (name + ".sqlite3")
                source.write_bytes(snapshot)
                with sqlite3.connect(source) as db:
                    for statement in statements: db.execute(statement)
                before = source.read_bytes()
                target = self.directory / (name + "-target.sqlite3")
                self.assertNotEqual(self.restore(source, target).returncode, 0)
                self.assertFalse(target.exists())
                self.assertEqual(source.read_bytes(), before)
        legacy = self.directory / "customer-legacy.sqlite3"
        legacy.write_bytes(snapshot)
        with sqlite3.connect(legacy) as db: db.execute("DROP TABLE customer_requests")
        target = self.directory / "customer-legacy-restored.sqlite3"
        self.assertEqual(self.restore(legacy, target).returncode, 0)
        origin = self.start_server(target)
        self.assertIn(customer, self.request("/customers", origin=origin))
        with sqlite3.connect(target) as db:
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_schema WHERE name='customer_requests'").fetchone())

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

    def test_incomplete_sales_are_rejected_without_touching_source_or_targets(self):
        self.seed()
        snapshot = self.download().read_bytes()
        cases = {
            "missing_items_table": "DROP TABLE sale_items",
            "missing_customers_table": "DROP TABLE customers",
            "missing_payment_column": "ALTER TABLE sales DROP COLUMN cash",
            "missing_debt_allocations": "DROP TABLE debt_allocations",
            "missing_shortage_fills": "DROP TABLE stock_shortage_fills",
            "missing_offline_time_column": "ALTER TABLE offline_sale_times DROP COLUMN sold_at",
            "missing_items": "DELETE FROM sale_items",
            "incorrect_payment": "UPDATE sales SET cash = '19.00'",
            "incorrect_item_amount": "UPDATE sale_items SET total = '19.00'",
            "incorrect_quantity": "UPDATE sale_items SET quantity = '3'",
            "invalid_multiplier": "UPDATE sale_items SET multiplier = '0'",
            "invalid_cost": "UPDATE sale_items SET base_unit_cost = '-1'",
            "unknown_unit": "UPDATE sale_items SET unit_id = 'missing'",
            "unknown_customer": "UPDATE sales SET customer_id = 'missing'",
            "negative_payment": "UPDATE sales SET cash = '-1.00'",
        }
        for name, statement in cases.items():
            with self.subTest(name=name):
                source = self.directory / (name + ".sqlite3")
                source.write_bytes(snapshot)
                with closing(sqlite3.connect(source)) as db:
                    db.execute(statement)
                    db.commit()
                original = source.read_bytes()
                target = self.directory / (name + "-restored.sqlite3")
                result = self.restore(source, target)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(target.exists())
                self.assertEqual(source.read_bytes(), original)
                server = subprocess.run([sys.executable, str(Path(__file__).with_name("inventory_api.py")),
                                         "--port", "0", "--database", str(source)],
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(server.returncode, 0, server.stdout)
                self.assertEqual(source.read_bytes(), original)
                target.write_bytes(b"existing target")
                self.assertNotEqual(self.restore(source, target).returncode, 0)
                self.assertEqual(target.read_bytes(), b"existing target")
                self.assertEqual(source.read_bytes(), original)

    def test_early_sales_schema_without_later_tables_still_restores(self):
        sale, _, _ = self.seed()
        source = self.download()
        with closing(sqlite3.connect(source)) as db:
            for table in ("stock_shortage_count_fills", "stock_shortage_fills", "stock_shortages",
                          "sale_corrections", "debt_allocations", "debt_repayments", "offline_sale_times", "abandoned_sales"):
                db.execute(f"DROP TABLE IF EXISTS {table}")
            db.commit()
        original = source.read_bytes()
        target = self.directory / "early-sales-restored.sqlite3"
        self.assertEqual(self.restore(source, target).returncode, 0)
        self.assertEqual(source.read_bytes(), original)
        origin = self.start_server(target)
        self.assertEqual(self.request(f"/sales/{sale['id']}", origin=origin), sale)

    def test_corrections_and_offline_rounding_survive_restore(self):
        sale, _, _ = self.seed()
        product = self.request("/products")[0]
        replacement = {"id": str(uuid4()), "items": [{"product_id": product["id"], "unit_id": product["units"][0]["id"],
                       "quantity": "1.5", "expected_unit_price": "10"}],
                       "payments": {"cash": "15", "qr": "0", "credit": "0"}, "customer_id": None, "qr_confirmed": False}
        self.request(f"/sales/{sale['id']}/corrections", {"id": str(uuid4()), "reason": "แก้ไข", "replacement": replacement})
        offline = {"id": str(uuid4()), "items": [{"product_id": product["id"], "unit_id": product["units"][0]["id"],
                   "quantity": "1", "expected_unit_price": "10.005"}],
                   "payments": {"cash": "10.01", "qr": "0", "credit": "0"}, "customer_id": None, "qr_confirmed": False,
                   "offline": True, "sold_at": "2026-11-12T17:00:00.000Z"}
        offline_saved = self.request("/offline-sales", offline)
        source = self.download()
        original = source.read_bytes()
        target = self.directory / "offline-correction-restored.sqlite3"
        self.assertEqual(self.restore(source, target).returncode, 0)
        self.assertEqual(source.read_bytes(), original)
        origin = self.start_server(target)
        self.assertEqual(self.request(f"/sales/{offline['id']}", origin=origin), offline_saved)
        self.assertEqual(self.request(f"/sales/{replacement['id']}", origin=origin)["total"], "15.00")

    def test_restore_validates_and_copies_the_same_wal_snapshot(self):
        sale, _, _ = self.seed()
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
        original_validator = database_backup.validate_sales
        def concurrent_change(reader):
            with closing(sqlite3.connect(self.database)) as writer:
                writer.execute("UPDATE sales SET cash = '19.00' WHERE id = ?", (sale["id"],))
                writer.commit()
            original_validator(reader)
        target = self.directory / "snapshot-during-write.sqlite3"
        with patch.object(database_backup, "validate_sales", side_effect=concurrent_change):
            database_backup.restore_database(self.database, target)
        with closing(sqlite3.connect(target)) as restored:
            self.assertEqual(restored.execute("SELECT cash FROM sales WHERE id = ?", (sale["id"],)).fetchone(), ("20.00",))
        with closing(sqlite3.connect(self.database)) as changed:
            self.assertEqual(changed.execute("SELECT cash FROM sales WHERE id = ?", (sale["id"],)).fetchone(), ("19.00",))
