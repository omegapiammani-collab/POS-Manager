"""Regression tests for owner-entered current average cost."""
from decimal import Decimal
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import uuid4

from cost_baselines import record_cost_baseline
from database_backup import check_backup, restore_database
from inventory import receive
from inventory_api import InventoryHandler
from sales import SaleConflict
from sales_reports import sales_report
from stock_counts import record_count
import test_unknown_cost


class CostBaselineTests(test_unknown_cost.UnknownCostTests):
    def payload(self):
        return {"id": str(uuid4()), "expected_quantity": "10", "expected_version": "0",
                "unit_cost": "7", "reason": "invoice review"}

    def prepare_stock(self):
        self.db.execute("UPDATE products SET quantity = '10', average_cost = NULL WHERE id = ?", (self.product,))
        self.db.commit()
        return self.db.execute("SELECT id FROM store_binding WHERE singleton = 1").fetchone()[0]

    def test_baseline_retry_and_historical_sales(self):
        store = self.prepare_stock()
        self.sale(1)
        payload = self.payload()
        payload.update(expected_quantity="9", expected_version="1")
        created, result = record_cost_baseline(self.db, self.product, payload, expected_store=store)
        self.assertTrue(created)
        self.assertEqual(result["id"], payload["id"])
        self.assertFalse(record_cost_baseline(self.db, self.product, payload, expected_store=store)[0])
        changed = dict(payload, unit_cost="8")
        with self.assertRaises(SaleConflict):
            record_cost_baseline(self.db, self.product, changed, expected_store=store)
        self.sale(1)
        self.assertEqual(self.stock(), (Decimal(8), Decimal(7)))
        self.assertFalse(record_cost_baseline(self.db, self.product, payload, expected_store=store)[0])
        report = sales_report(self.db, "2000-01-01", "2100-12-31")
        self.assertEqual(report["summary"]["unknown_cost_bills"], 1)
        self.assertIsNone(report["summary"]["cost"])

    def test_quantity_aba_and_wrong_store_fail_closed(self):
        store = self.prepare_stock()
        payload = self.payload()
        with self.assertRaises(SaleConflict):
            record_cost_baseline(self.db, self.product, payload, expected_store=str(uuid4()))
        self.sale(1)
        receive(self.db, self.product, self.unit, "1", "3", str(uuid4()))
        self.assertEqual(self.stock()[0], Decimal(10))
        with self.assertRaises(SaleConflict):
            record_cost_baseline(self.db, self.product, payload, expected_store=store)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cost_baselines").fetchone()[0], 0)
        self.assertIsNone(self.stock()[1])

    def test_requires_positive_stock_and_unknown_cost(self):
        store = self.prepare_stock()
        for quantity, cost in (("0", None), ("-1", None), ("10", "0"), ("10", "4.25")):
            self.db.execute("UPDATE products SET quantity = ?, average_cost = ? WHERE id = ?", (quantity, cost, self.product))
            self.db.commit()
            payload = dict(self.payload(), expected_quantity=quantity)
            with self.assertRaises((ValueError, SaleConflict)):
                record_cost_baseline(self.db, self.product, payload, expected_store=store)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cost_baselines").fetchone()[0], 0)

    def test_backup_restores_baseline_and_rejects_broken_history(self):
        store = self.prepare_stock()
        payload = self.payload()
        record_cost_baseline(self.db, self.product, payload, expected_store=store)
        check_backup(self.path)
        restored = Path(self.directory.name) / "baseline-restored.sqlite3"
        restore_database(self.path, restored)
        with sqlite3.connect(str(restored)) as db:
            self.assertEqual(db.execute("SELECT unit_cost FROM cost_baselines").fetchone()[0], "7")
        self.db.execute("UPDATE stock_revisions SET version = 0 WHERE product_id = ?", (self.product,))
        self.db.commit()
        with self.assertRaises(ValueError):
            check_backup(self.path)

    def test_legacy_backup_without_new_tables_is_still_accepted(self):
        self.db.execute("DROP TABLE cost_baselines")
        self.db.execute("DROP TABLE stock_revisions")
        self.db.commit()
        check_backup(self.path)
        restored = Path(self.directory.name) / "legacy-restored.sqlite3"
        restore_database(self.path, restored)

    def test_all_stock_writers_increment_and_replay_does_not(self):
        self.prepare_stock()
        def version():
            row = self.db.execute("SELECT version FROM stock_revisions WHERE product_id = ?", (self.product,)).fetchone()
            return row[0] if row else 0
        receipt_id = str(uuid4())
        receive(self.db, self.product, self.unit, "1", "3", receipt_id)
        self.assertEqual(version(), 1)
        receive(self.db, self.product, self.unit, "1", "3", receipt_id)
        self.assertEqual(version(), 1)
        sale = self.sale(1)
        self.assertEqual(version(), 2)
        count = {"id": str(uuid4()), "expected_quantity": "10", "counted_quantity": "9", "reason": "count"}
        record_count(self.db, self.product, count)
        self.assertEqual(version(), 3)
        record_count(self.db, self.product, count)
        self.assertEqual(version(), 3)
        self.void(sale)
        self.assertEqual(version(), 4)

    def test_revision_failure_rolls_back_stock_and_audit(self):
        store = self.prepare_stock()
        payload = self.payload()
        with patch("cost_baselines.bump_stock_revision", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                record_cost_baseline(self.db, self.product, payload, expected_store=store)
        self.assertEqual(self.stock(), (Decimal(10), None))
        self.assertEqual(self.db.execute("SELECT count(*) FROM cost_baselines").fetchone()[0], 0)
        with patch("inventory.bump_stock_revision", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                receive(self.db, self.product, self.unit, "1", "3", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(10), None))
        self.assertEqual(self.db.execute("SELECT count(*) FROM receipts").fetchone()[0], 0)
        with patch("sales.bump_stock_revision", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                self.sale(1)
        self.assertEqual(self.stock(), (Decimal(10), None))
        self.assertEqual(self.db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
        count = {"id": str(uuid4()), "expected_quantity": "10", "counted_quantity": "9", "reason": "count"}
        with patch("stock_counts.bump_stock_revision", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                record_count(self.db, self.product, count)
        self.assertEqual(self.stock(), (Decimal(10), None))
        self.assertEqual(self.db.execute("SELECT count(*) FROM stock_counts").fetchone()[0], 0)
        sale = self.sale(1)
        with patch("sale_corrections.bump_stock_revision", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                self.void(sale)
        self.assertEqual(self.stock(), (Decimal(9), None))
        self.assertEqual(self.db.execute("SELECT count(*) FROM sale_corrections").fetchone()[0], 0)

    def test_http_dispatch_binding_idempotency_and_history(self):
        store = self.prepare_stock()
        payload = self.payload()
        path = urlsplit("/products/" + self.product + "/cost-baselines")
        handler = SimpleNamespace(command="POST", headers={"X-POS-Store-ID": store}, read_json=lambda: payload)
        self.assertEqual(InventoryHandler.dispatch(handler, self.db, path), (201, {"id": payload["id"]}))
        self.assertEqual(InventoryHandler.dispatch(handler, self.db, path), (200, {"id": payload["id"]}))
        handler.headers = {"X-POS-Store-ID": str(uuid4())}
        with self.assertRaises(SaleConflict):
            InventoryHandler.dispatch(handler, self.db, path)
        handler.command = "GET"
        with self.assertRaises(SaleConflict):
            InventoryHandler.dispatch(handler, self.db, path)
        self.db.rollback()
        handler.headers = {"X-POS-Store-ID": store}
        status, history = InventoryHandler.dispatch(handler, self.db, path)
        self.assertEqual(status, 200)
        self.assertEqual(history[0]["id"], payload["id"])
