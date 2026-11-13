"""Verify report dates, payment attribution, and cost reconciliation via HTTP."""
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from inventory import connect
from inventory_api import make_server


class SalesReportApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "reports.sqlite3"
        server = make_server(self.database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

        self.customer = self.expect(201, "/customers", {"name": "ลูกค้าทดสอบ"})
        self.product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })

    def expect(self, status, path, data=None):
        request = Request(
            self.origin + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            self.assertEqual(response.status, status, result)
            return result

    def receive(self, quantity, cost):
        self.expect(201, f"/products/{self.product['id']}/receipts", {
            "unit_id": self.product["base_unit_id"], "quantity": quantity, "unit_cost": cost,
        })

    def sale(self, quantity=1, *, qr=0, credit=0):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": self.product["id"], "unit_id": self.product["base_unit_id"],
                "quantity": str(quantity), "expected_unit_price": "10",
            }],
            "payments": {"cash": str(quantity * 10 - qr - credit), "qr": str(qr), "credit": str(credit)},
            "customer_id": self.customer["id"] if credit else None,
            "qr_confirmed": bool(qr),
        }

    def sell(self, timestamp, quantity=1, *, qr=0, credit=0, offline=False):
        sale = self.expect(201, "/offline-sales" if offline else "/sales",
                           self.sale(quantity, qr=qr, credit=credit))
        self.set_sale_date(sale["id"], timestamp)
        return sale

    def set_sale_date(self, sale_id, timestamp):
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?", (timestamp, sale_id))

    def report(self, start="2026-11-10", end="2026-11-10"):
        return self.expect(200, f"/sales-report?from={start}&to={end}")

    def test_bangkok_cutover_inclusive_range_and_mixed_payments(self):
        self.receive("10", "4")
        self.sell("2026-11-09T16:59:59.999Z")
        self.sell("2026-11-09T17:00:00.000Z", 2, qr=5, credit=6)
        self.sell("2026-11-10T16:59:59.999Z")
        self.sell("2026-11-10T17:00:00.000Z")

        report = self.report()
        self.assertEqual((report["from"], report["to"]), ("2026-11-10", "2026-11-10"))
        summary = {
            "bill_count": 2, "revenue": "30.00", "cash": "19.00", "qr": "5.00",
            "credit": "6.00", "cost": "12.00", "gross_profit": "18.00",
            "expenses": "0.00", "cash_drawer_expenses": "0.00", "external_expenses": "0.00",
            "profit_after_expenses": "18.00",
            "pending_cost_bills": 0, "unknown_cost_bills": 0,
        }
        self.assertEqual(report["summary"], summary)
        self.assertEqual(report["days"], [{"date": "2026-11-10", **summary}])
        product, = report["products"]
        self.assertEqual(product["product_id"], self.product["id"])
        self.assertEqual((product["name"], product["base_unit"]), ("น้ำดื่ม", "ขวด"))
        self.assertEqual(Decimal(product["quantity"]), 3)
        for key in ("revenue", "cost", "gross_profit", "pending_cost_bills", "unknown_cost_bills"):
            self.assertEqual(product[key], summary[key])

        period = self.report("2026-11-09", "2026-11-11")
        self.assertEqual(period["summary"]["revenue"], "50.00")
        self.assertEqual({row["date"]: row["bill_count"] for row in period["days"]}, {
            "2026-11-09": 1, "2026-11-10": 2, "2026-11-11": 1,
        })

    def test_replacements_keep_root_sale_date_and_repayments_are_not_sales(self):
        self.receive("10", "4")
        original = self.sell("2026-11-10T03:00:00.000Z", 2, credit=15)
        self.expect(201, f"/customers/{self.customer['id']}/repayments", {
            "id": str(uuid4()), "amount": "15", "method": "cash",
        })
        replaced = self.sale(2, credit=5)
        self.expect(201, f"/sales/{original['id']}/corrections", {
            "id": str(uuid4()), "reason": "ปรับยอดเงินเชื่อ", "replacement": replaced,
            "excess_action": "refund_cash",
        })
        self.set_sale_date(replaced["id"], "2026-11-11T03:00:00.000Z")
        final = self.sale(3, qr=20, credit=5)
        self.expect(201, f"/sales/{replaced['id']}/corrections", {
            "id": str(uuid4()), "reason": "แก้จำนวนอีกครั้ง", "replacement": final,
        })
        self.set_sale_date(final["id"], "2026-11-12T03:00:00.000Z")
        voided = self.sell("2026-11-10T06:00:00.000Z")
        self.expect(201, f"/sales/{voided['id']}/corrections", {
            "id": str(uuid4()), "reason": "ยกเลิกรายการ", "replacement": None,
        })
        report = self.report()
        self.assertEqual(report["summary"], {
            "bill_count": 1, "revenue": "30.00", "cash": "5.00", "qr": "20.00",
            "credit": "5.00", "cost": "12.00", "gross_profit": "18.00",
            "expenses": "0.00", "cash_drawer_expenses": "0.00", "external_expenses": "0.00",
            "profit_after_expenses": "18.00",
            "pending_cost_bills": 0, "unknown_cost_bills": 0,
        })
        self.assertEqual(self.report("2026-11-11", "2026-11-12")["summary"]["bill_count"], 0)

    def test_shortage_cost_moves_from_provisional_to_actual(self):
        self.receive("1", "4")
        self.sell("2026-11-10T03:00:00.000Z", 3, offline=True)

        def costs():
            summary = self.report()["summary"]
            return tuple(summary[key] for key in (
                "cost", "gross_profit", "pending_cost_bills", "unknown_cost_bills",
            ))

        self.assertEqual(costs(), ("12.00", "18.00", 1, 0))
        self.receive("1", "8")
        self.assertEqual(costs(), ("16.00", "14.00", 1, 0))
        self.receive("1", "9")
        self.assertEqual(costs(), ("21.00", "9.00", 0, 0))

    def test_unknown_cost_hides_profit_until_all_shortages_have_cost(self):
        self.sell("2026-11-10T03:00:00.000Z", 2, offline=True)
        self.receive("1", "5")
        report = self.report()
        self.assertEqual(report["summary"]["revenue"], "20.00")
        for row in (report["summary"], *report["days"], *report["products"]):
            self.assertIsNone(row["cost"])
            self.assertIsNone(row["gross_profit"])
            self.assertEqual((row["pending_cost_bills"], row["unknown_cost_bills"]), (1, 1))
        self.receive("1", "6")
        self.assertEqual(self.report()["summary"]["gross_profit"], "9.00")

    def test_reports_pack_in_base_units_and_counts_resolved_shortage_cost(self):
        self.receive("1", "4")
        pack = self.expect(201, f"/products/{self.product['id']}/units", {
            "name": "แพ็ก", "multiplier": "3", "price": "25",
        })
        payload = self.sale()
        payload["items"][0].update(unit_id=pack["id"], expected_unit_price="25")
        payload["payments"]["cash"] = "25"
        sale = self.expect(201, "/offline-sales", payload)
        self.set_sale_date(sale["id"], "2026-11-10T03:00:00.000Z")
        self.expect(201, f"/products/{self.product['id']}/stock-counts", {
            "id": str(uuid4()), "expected_quantity": "-2", "counted_quantity": "0",
            "reason": "ตรวจนับจริง", "unit_cost": "8",
        })

        product, = self.report()["products"]
        self.assertEqual(product["base_unit"], "ขวด")
        self.assertEqual(Decimal(product["quantity"]), 3)
        self.assertEqual(product["revenue"], "25.00")
        self.assertEqual(product["cost"], "20.00")
        self.assertEqual(product["gross_profit"], "5.00")
        self.assertEqual((product["pending_cost_bills"], product["unknown_cost_bills"]), (0, 0))

    def test_rounds_aggregate_cost_and_reconciles_displayed_profit(self):
        self.receive("2", "0.005")
        self.sell("2026-11-10T03:00:00.000Z")
        self.assertEqual(self.report()["summary"]["cost"], "0.01")
        self.assertEqual(self.report()["summary"]["gross_profit"], "9.99")
        self.sell("2026-11-10T04:00:00.000Z")
        self.assertEqual(self.report()["summary"]["cost"], "0.01")
        self.assertEqual(self.report()["summary"]["gross_profit"], "19.99")

    def test_rejects_invalid_report_dates(self):
        for query in (
            "from=2026-11-10", "to=2026-11-10", "from=2026-2-03&to=2026-03-01",
            "from=2026-02-30&to=2026-03-01", "from=2026-11-12&to=2026-11-10",
        ):
            with self.subTest(query=query):
                self.expect(400, "/sales-report?" + query)
