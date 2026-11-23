"""Unknown historical stock cost must not become invented profit."""
from contextlib import closing
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4
import sqlite3

from cash_drawer import DRAWER_SCHEMA
from database_backup import check_backup, restore_database
from debts import DEBT_SCHEMA
from expenses import EXPENSE_SCHEMA
from inventory import add_product, connect, receive
from sale_corrections import CORRECTION_SCHEMA, correct_sale
from sales import SALES_SCHEMA, checkout
from sales_reports import sales_report
from stock_counts import COUNT_SCHEMA, record_count
from store_binding import SCHEMA as BINDING_SCHEMA, ensure_binding


class UnknownCostTests(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "synthetic.sqlite3"
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        for schema in (SALES_SCHEMA, DEBT_SCHEMA, CORRECTION_SCHEMA, COUNT_SCHEMA, EXPENSE_SCHEMA, DRAWER_SCHEMA, BINDING_SCHEMA):
            self.db.executescript(schema)
        ensure_binding(self.db)
        self.product, self.unit = add_product(self.db, "TEST", "Synthetic", "piece", "25")

    def stock(self):
        row = self.db.execute("SELECT quantity, average_cost FROM products WHERE id = ?", (self.product,)).fetchone()
        return Decimal(row[0]), None if row[1] is None else Decimal(row[1])

    def sale(self, quantity, *, offline=False):
        payload = {"id": str(uuid4()), "items": [{"product_id": self.product, "unit_id": self.unit,
                   "quantity": str(quantity), "expected_unit_price": "25"}],
                   "payments": {"cash": str(25 * quantity), "qr": "0", "credit": "0"},
                   "customer_id": None, "qr_confirmed": False}
        created, result = checkout(self.db, payload, offline=offline)
        self.assertTrue(created)
        return result

    def void(self, sale):
        return correct_sale(self.db, sale["id"], {"id": str(uuid4()), "reason": "test", "replacement": None})

    def test_unknown_existing_stock_survives_receipt_count_and_reports(self):
        self.db.execute("UPDATE products SET quantity = '10', average_cost = NULL WHERE id = ?", (self.product,))
        receipt_id = str(uuid4())
        receive(self.db, self.product, self.unit, "10", "10", receipt_id)
        receive(self.db, self.product, self.unit, "10", "10", receipt_id)
        self.assertEqual(self.stock(), (Decimal(20), None))
        sale = self.sale(1)
        self.assertEqual(self.stock(), (Decimal(19), None))
        report = sales_report(self.db, "2000-01-01", "2100-12-31")
        self.assertEqual(report["summary"]["revenue"], "25.00")
        self.assertIsNone(report["summary"]["cost"])
        self.assertIsNone(report["summary"]["gross_profit"])
        self.assertEqual(report["summary"]["unknown_cost_bills"], 1)
        count = {"id": str(uuid4()), "expected_quantity": "19", "counted_quantity": "20", "reason": "count", "unit_cost": "10"}
        self.assertTrue(record_count(self.db, self.product, count)[0])
        self.assertFalse(record_count(self.db, self.product, count)[0])
        self.assertEqual(self.stock(), (Decimal(20), None))
        check_backup(self.path)
        restored = Path(self.directory.name) / "restored.sqlite3"
        restore_database(self.path, restored)
        with closing(sqlite3.connect(restored)) as db:
            self.assertEqual(db.execute("SELECT average_cost FROM products WHERE id = ?", (self.product,)).fetchone()[0], None)
        self.sale(20)
        self.assertEqual(self.stock(), (Decimal(0), None))
        receive(self.db, self.product, self.unit, "1", "7", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(1), Decimal(7)))
        self.assertIsNone(sales_report(self.db, "2000-01-01", "2100-12-31")["summary"]["gross_profit"])

    def test_known_zero_and_negative_stock_keep_existing_cost_rules(self):
        receive(self.db, self.product, self.unit, "10", "5", str(uuid4()))
        receive(self.db, self.product, self.unit, "10", "10", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(20), Decimal("7.5")))
        self.sale(20)
        receive(self.db, self.product, self.unit, "1", "8", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(1), Decimal(8)))
        self.sale(2, offline=True)
        self.assertEqual(self.stock(), (Decimal(-1), Decimal(8)))
        receive(self.db, self.product, self.unit, "2", "9", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(1), Decimal(9)))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM stock_shortage_fills").fetchone()[0], 1)

    def test_void_does_not_invent_cost_for_unknown_returned_or_existing_units(self):
        self.db.execute("UPDATE products SET quantity = '1', average_cost = NULL WHERE id = ?", (self.product,))
        old = self.sale(1)
        receive(self.db, self.product, self.unit, "2", "10", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(2), Decimal(10)))
        self.void(old)
        self.assertEqual(self.stock(), (Decimal(3), None))

    def test_void_known_cost_into_unknown_stock_remains_unknown(self):
        receive(self.db, self.product, self.unit, "1", "10", str(uuid4()))
        old = self.sale(1)
        self.db.execute("UPDATE products SET quantity = '2', average_cost = NULL WHERE id = ?", (self.product,))
        self.void(old)
        self.assertEqual(self.stock(), (Decimal(3), None))

    def test_void_partial_shortage_with_one_unknown_component_remains_unknown(self):
        self.db.execute("UPDATE products SET quantity = '1', average_cost = NULL WHERE id = ?", (self.product,))
        old = self.sale(2, offline=True)
        self.assertEqual(self.stock(), (Decimal(-1), None))
        receive(self.db, self.product, self.unit, "2", "7", str(uuid4()))
        self.assertEqual(self.stock(), (Decimal(1), Decimal(7)))
        self.void(old)
        self.assertEqual(self.stock(), (Decimal(3), None))

    def test_void_known_cost_into_zero_stock_restores_known_average(self):
        receive(self.db, self.product, self.unit, "1", "10", str(uuid4()))
        old = self.sale(1)
        self.void(old)
        self.assertEqual(self.stock(), (Decimal(1), Decimal(10)))

    def test_known_cost_count_and_void_keep_weighted_average(self):
        receive(self.db, self.product, self.unit, "10", "5", str(uuid4()))
        count = {"id": str(uuid4()), "expected_quantity": "10", "counted_quantity": "15", "reason": "count", "unit_cost": "8"}
        record_count(self.db, self.product, count)
        self.assertEqual(self.stock(), (Decimal(15), Decimal(6)))
        old = self.sale(1)
        receive(self.db, self.product, self.unit, "1", "12", str(uuid4()))
        self.void(old)
        quantity, average = self.stock()
        self.assertEqual(quantity, Decimal(16))
        self.assertEqual(average, Decimal("6.375"))
