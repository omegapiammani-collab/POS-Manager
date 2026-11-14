"""Exercise expense recording, voiding, and reports through the HTTP API."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from test_store_headers import store_headers
from uuid import uuid4

from inventory import connect
from inventory_api import make_server


class ExpensesApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "expenses.sqlite3"
        server = make_server(self.database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

    def request(self, path, data=None):
        request = Request(
            self.origin + path,
            data=None if data is None else json.dumps(data).encode(),
            headers=store_headers(self.origin),
        )
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def expect(self, status, path, data=None):
        actual, result = self.request(path, data)
        self.assertEqual(actual, status, result)
        return result

    @staticmethod
    def expense(**fields):
        return {
            "id": str(uuid4()), "date": "2026-11-10", "description": "ค่าถุง",
            "amount": "15.25", "source": "cash_drawer", **fields,
        }

    def report(self, start="2026-11-10", end="2026-11-11"):
        return self.expect(200, f"/sales-report?from={start}&to={end}")

    def list_expenses(self, start="2026-11-10", end="2026-11-11"):
        return self.expect(200, f"/expenses?from={start}&to={end}")

    def sell(self, *, with_cost):
        product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "30",
        })
        if with_cost:
            self.expect(201, f"/products/{product['id']}/receipts", {
                "unit_id": product["base_unit_id"], "quantity": "1", "unit_cost": "8",
            })
        sale = self.expect(201, "/sales" if with_cost else "/offline-sales", {
            "id": str(uuid4()),
            "items": [{
                "product_id": product["id"], "unit_id": product["base_unit_id"],
                "quantity": "1", "expected_unit_price": "30",
            }],
            "payments": {"cash": "30", "qr": "0", "credit": "0"},
            "customer_id": None, "qr_confirmed": False,
        })
        with closing(connect(self.database)) as db:
            db.execute(
                "UPDATE sales SET created_at = ? WHERE id = ?",
                ("2026-11-09T17:30:00.000Z", sale["id"]),
            )
        return product

    def test_create_replay_conflict_and_inclusive_listing(self):
        payload = self.expense()
        saved = self.expect(201, "/expenses", payload)
        self.assertEqual({key: saved[key] for key in payload}, payload)
        self.assertEqual(saved["status"], "active")
        self.assertIsNone(saved["void_reason"])
        self.assertTrue(saved["created_at"])
        self.assertEqual(self.expect(200, "/expenses", payload), saved)
        self.expect(409, "/expenses", {**payload, "amount": "15.26"})

        next_day = self.expect(201, "/expenses", self.expense(date="2026-11-11", source="external"))
        self.expect(201, "/expenses", self.expense(date="2026-11-12"))
        self.assertEqual(self.list_expenses("2026-11-10", "2026-11-10"), [saved])
        self.assertEqual({row["id"] for row in self.list_expenses()}, {saved["id"], next_day["id"]})

    def test_concurrent_replay_creates_one_expense(self):
        payload = self.expense()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.request("/expenses", payload), range(2)))
        self.assertEqual(sorted(status for status, _ in results), [200, 201])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(len(self.list_expenses()), 1)

    def test_void_retains_history_and_replay_does_not_change_reason(self):
        expense = self.expect(201, "/expenses", self.expense())
        path = f"/expenses/{expense['id']}/void"
        self.expect(400, path, {"reason": " "})
        self.assertEqual(self.list_expenses(), [expense])

        voided = self.expect(200, path, {"reason": "ลงผิดรายการ"})
        self.assertEqual(voided["status"], "voided")
        self.assertEqual(voided["void_reason"], "ลงผิดรายการ")
        for key in ("id", "date", "description", "amount", "source", "created_at"):
            self.assertEqual(voided[key], expense[key])
        self.assertEqual(self.expect(200, path, {"reason": "ลงผิดรายการ"}), voided)
        self.expect(409, path, {"reason": "เหตุผลใหม่"})
        self.assertEqual(self.list_expenses(), [voided])

    def test_reports_separate_sources_and_include_expense_only_day(self):
        product = self.sell(with_cost=True)
        self.expect(201, "/expenses", self.expense(amount="3.10"))
        self.expect(201, "/expenses", self.expense(amount="4.20", source="external"))
        self.expect(201, "/expenses", self.expense(date="2026-11-11", amount="2.35", source="external"))
        excluded = self.expect(201, "/expenses", self.expense(date="2026-11-11", amount="99"))
        self.expect(200, f"/expenses/{excluded['id']}/void", {"reason": "บันทึกซ้ำ"})
        self.expect(201, "/expenses", self.expense(date="2026-11-12", amount="99"))

        report = self.report()
        summary = report["summary"]
        self.assertEqual(summary["revenue"], "30.00")
        self.assertEqual(summary["gross_profit"], "22.00")
        self.assertEqual(summary["expenses"], "9.65")
        self.assertEqual(summary["cash_drawer_expenses"], "3.10")
        self.assertEqual(summary["external_expenses"], "6.55")
        self.assertEqual(summary["profit_after_expenses"], "12.35")
        days = {row["date"]: row for row in report["days"]}
        self.assertEqual(set(days), {"2026-11-10", "2026-11-11"})
        self.assertEqual(days["2026-11-10"]["expenses"], "7.30")
        self.assertEqual(days["2026-11-10"]["profit_after_expenses"], "14.70")
        self.assertEqual(days["2026-11-11"]["bill_count"], 0)
        self.assertEqual(days["2026-11-11"]["revenue"], "0.00")
        self.assertEqual(days["2026-11-11"]["expenses"], "2.35")
        self.assertEqual(days["2026-11-11"]["profit_after_expenses"], "-2.35")
        product_row, = report["products"]
        self.assertEqual(product_row["product_id"], product["id"])
        self.assertEqual(product_row["gross_profit"], "22.00")
        self.assertNotIn("expenses", product_row)
        self.assertNotIn("profit_after_expenses", product_row)

    def test_unknown_sales_cost_leaves_profit_after_expenses_unknown(self):
        self.sell(with_cost=False)
        self.expect(201, "/expenses", self.expense())
        report = self.report()
        for row in (report["summary"], *report["days"]):
            self.assertEqual(row["revenue"], "30.00")
            self.assertEqual(row["expenses"], "15.25")
            self.assertIsNone(row["gross_profit"])
            self.assertIsNone(row["profit_after_expenses"])

    def test_invalid_date_amount_source_and_description_leave_no_expenses(self):
        for fields in (
            {"id": "not-a-uuid"}, {"date": "2026-2-01"}, {"date": "2026-02-30"},
            {"amount": "0"}, {"amount": "-1"}, {"amount": "0.001"}, {"amount": "NaN"},
            {"source": "qr"}, {"description": "  "},
        ):
            with self.subTest(fields=fields):
                self.expect(400, "/expenses", self.expense(**fields))
        for query in (
            "from=2026-11-10", "to=2026-11-10", "from=2026-11-11&to=2026-11-10",
            "from=2026-02-30&to=2026-03-01",
        ):
            with self.subTest(query=query):
                self.expect(400, "/expenses?" + query)
        self.assertEqual(self.list_expenses(), [])
