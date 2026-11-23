"""Read-only migration reconciliation metadata, not a data export."""
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import hashlib
import json
import os
import sqlite3
import subprocess
import sys

import database_backup
from inventory import add_product, connect
from sales import SALES_SCHEMA


class BackupInventoryTests(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / "synthetic.sqlite3"
        with closing(connect(self.database)) as db:
            product, _ = add_product(db, "TEST", "private-customer-like-value", "piece", "25")
            db.execute('CREATE TABLE "extra""table" ("payload" TEXT, "product_ref" TEXT REFERENCES products(id))')
            db.execute('INSERT INTO "extra""table" VALUES (?, ?)', ("private-row-value", product))
            db.execute('CREATE TABLE "sqliteXextra" ("note" TEXT)')
            db.execute("PRAGMA user_version = 7")

    def test_report_contains_metadata_not_rows_and_does_not_change_file(self):
        before = self.database.read_bytes()
        before_mtime = self.database.stat().st_mtime_ns
        report = database_backup.inventory_backup(self.database)
        self.assertEqual(report["format"], "pos-sqlite-inventory")
        self.assertEqual(report["version"], 1)
        self.assertEqual(report["user_version"], 7)
        tables = {table["name"]: table for table in report["tables"]}
        self.assertEqual(tables["products"]["row_count"], 1)
        self.assertEqual(tables['extra"table']["row_count"], 1)
        self.assertEqual(tables["sqliteXextra"]["row_count"], 0)
        self.assertEqual(tables['extra"table']["foreign_keys"][0]["table"], "products")
        self.assertEqual([column["name"] for column in tables['extra"table']["columns"]], ["payload", "product_ref"])
        serialized = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("private-row-value", serialized)
        self.assertNotIn("private-customer-like-value", serialized)
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).digest(), hashlib.sha256(before).digest())
        self.assertEqual(self.database.stat().st_mtime_ns, before_mtime)

    def test_invalid_and_incomplete_files_fail_without_changes(self):
        corrupt = Path(self.directory.name) / "corrupt.sqlite3"
        corrupt.write_bytes(b"not a database")
        before = corrupt.read_bytes()
        with self.assertRaises((ValueError, sqlite3.DatabaseError)):
            database_backup.inventory_backup(corrupt)
        self.assertEqual(corrupt.read_bytes(), before)
        incomplete = Path(self.directory.name) / "incomplete.sqlite3"
        with closing(connect(incomplete)) as db:
            db.execute("CREATE TABLE sales (id TEXT)")
        before = incomplete.read_bytes()
        with self.assertRaises(ValueError):
            database_backup.inventory_backup(incomplete)
        self.assertEqual(incomplete.read_bytes(), before)

    def test_sales_and_items_are_counted_without_exporting_bill_values(self):
        with closing(connect(self.database)) as db:
            db.executescript(SALES_SCHEMA)
            product, unit = db.execute("SELECT product_id, id FROM units").fetchone()
            db.execute("INSERT INTO sales (id, request_hash, total, cash, qr, credit) VALUES (?, ?, ?, ?, ?, ?)",
                       ("private-sale-id", "private-request-hash", "25.00", "25.00", "0", "0"))
            db.execute("INSERT INTO sale_items (sale_id, position, product_id, unit_id, name, unit_name, quantity, unit_price, total, multiplier, base_unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       ("private-sale-id", 0, product, unit, "private-item-name", "piece", "1", "25", "25.00", "1", None))
        report = database_backup.inventory_backup(self.database)
        tables = {table["name"]: table["row_count"] for table in report["tables"]}
        self.assertEqual(tables["sales"], 1)
        self.assertEqual(tables["sale_items"], 1)
        output = json.dumps(report)
        self.assertNotIn("private-sale-id", output)
        self.assertNotIn("private-request-hash", output)
        self.assertNotIn("private-item-name", output)

    def test_inventory_counts_share_the_validation_snapshot(self):
        with closing(sqlite3.connect(self.database)) as setup:
            setup.execute("PRAGMA journal_mode=WAL")
        actual_validate = database_backup.validate_backup
        with closing(sqlite3.connect(self.database)) as writer:
            def validate_then_write(db):
                actual_validate(db)
                writer.execute('INSERT INTO "extra""table" (payload) VALUES (?)', ("later-value",))
                writer.commit()
            with patch.object(database_backup, "validate_backup", side_effect=validate_then_write):
                report = database_backup.inventory_backup(self.database)
        tables = {table["name"]: table for table in report["tables"]}
        self.assertEqual(tables['extra"table']["row_count"], 1)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM "extra""table"').fetchone()[0], 2)

    def test_cli_prints_json_only(self):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE "ตารางทดสอบ" ("ชื่อ" TEXT)')
            db.commit()
        command = [sys.executable, str(Path(database_backup.__file__)), "inventory", str(self.database)]
        environment = {**os.environ, "PYTHONIOENCODING": "ascii"}
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["format"], "pos-sqlite-inventory")
        self.assertIn("ตารางทดสอบ", [table["name"] for table in report["tables"]])
        self.assertTrue(result.stdout.isascii())
        self.assertNotIn("private-row-value", result.stdout)
