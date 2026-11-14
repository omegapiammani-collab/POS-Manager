"""Exercise stock count adjustments through the HTTP API."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from test_store_headers import store_headers
from uuid import uuid4

from inventory_api import make_server


class StockCountApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        server = make_server(Path(directory.name) / "stock-counts.sqlite3", 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

        self.product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.product_path = f"/products/{self.product['id']}"
        self.count_path = self.product_path + "/stock-counts"

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

    def receipt(self, quantity, cost):
        return self.expect(201, self.product_path + "/receipts", {
            "unit_id": self.product["base_unit_id"], "quantity": quantity, "unit_cost": cost,
        })

    def stock(self):
        product, = self.expect(200, "/products")
        average = product["average_cost"]
        return Decimal(product["quantity"]), None if average is None else Decimal(average)

    @staticmethod
    def count(expected, counted, **details):
        return {
            "id": str(uuid4()), "expected_quantity": expected,
            "counted_quantity": counted, "reason": "ตรวจนับจริง", **details,
        }

    def test_counts_up_at_weighted_cost_and_down_without_revaluation(self):
        self.receipt("10", "5")
        up = self.count("10", "15", unit_cost="8")
        result = self.expect(201, self.count_path, up)
        self.assertEqual(result["id"], up["id"])
        self.assertEqual(result["reason"], up["reason"])
        self.assertTrue(result["created_at"])
        for field, amount in (
            ("expected_quantity", 10), ("counted_quantity", 15), ("delta", 5), ("unit_cost", 8),
        ):
            self.assertEqual(Decimal(result[field]), amount)
        self.assertEqual(self.stock(), (Decimal(15), Decimal(6)))

        self.expect(400, self.count_path, self.count("15", "15"))
        self.expect(400, self.count_path, self.count("15", "9", unit_cost="3"))
        self.assertEqual(self.stock(), (Decimal(15), Decimal(6)))
        self.assertEqual(self.expect(200, self.count_path), [result])

        down = self.expect(201, self.count_path, self.count("15", "9"))
        self.assertEqual(Decimal(down["delta"]), -6)
        self.assertEqual(self.stock(), (Decimal(9), Decimal(6)))
        self.assertCountEqual(self.expect(200, self.count_path), [down, result])
        self.assertEqual(len(self.expect(200, self.product_path + "/receipts")), 1)

        self.assertEqual(self.expect(200, self.count_path, up), result)
        self.assertEqual(self.stock(), (Decimal(9), Decimal(6)))
        conflict = self.expect(409, self.count_path, {**up, "reason": "แก้เหตุผล"})
        self.assertEqual(conflict["code"], "idempotency_conflict")
        self.assertCountEqual(self.expect(200, self.count_path), [down, result])

    def test_simultaneous_counts_only_apply_against_matching_stock(self):
        self.receipt("10", "5")
        counts = [self.count("10", "11"), self.count("10", "12")]
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda count: self.request(self.count_path, count), counts))
        self.assertEqual(sorted(status for status, _ in outcomes), [201, 409])
        accepted = next(body for status, body in outcomes if status == 201)
        conflict = next(body for status, body in outcomes if status == 409)
        self.assertEqual(conflict["code"], "stock_changed")
        self.assertEqual(self.stock(), (Decimal(accepted["counted_quantity"]), Decimal(5)))
        self.assertEqual(self.expect(200, self.count_path), [accepted])

    def test_unknown_cost_requires_input_and_failed_count_is_atomic(self):
        count = self.count("0", "3")
        error = self.expect(400, self.count_path, count)
        self.assertEqual(error["code"], "stock_count_cost_required")
        self.assertEqual(self.stock(), (Decimal(0), None))
        self.assertEqual(self.expect(200, self.count_path), [])
        result = self.expect(201, self.count_path, {**count, "unit_cost": "4.125"})
        self.assertEqual(Decimal(result["unit_cost"]), Decimal("4.125"))
        self.assertEqual(self.stock(), (Decimal(3), Decimal("4.125")))

    def test_negative_to_zero_records_count_fill_without_inventing_receipt(self):
        self.receipt("1", "5")
        sale = self.expect(201, "/offline-sales", {
            "id": str(uuid4()), "items": [{
                "product_id": self.product["id"], "unit_id": self.product["base_unit_id"],
                "quantity": "3", "expected_unit_price": "10",
            }],
            "payments": {"cash": "30", "qr": "0", "credit": "0"},
            "customer_id": None, "qr_confirmed": False,
        })
        self.assertEqual(self.stock(), (Decimal(-2), Decimal(5)))
        count = self.expect(201, self.count_path, self.count("-2", "0"))
        self.assertEqual(Decimal(count["delta"]), 2)
        self.assertEqual(Decimal(count["unit_cost"]), 5)
        self.assertEqual(self.stock(), (Decimal(0), Decimal(5)))
        self.assertEqual(self.expect(200, "/stock-shortages"), [])
        shortage, = self.expect(200, f"/sales/{sale['id']}")["stock_shortages"]
        self.assertEqual(Decimal(shortage["remaining"]), 0)
        fill, = shortage["fills"]
        self.assertEqual(fill["stock_count_id"], count["id"])
        self.assertIsNone(fill.get("receipt_id"))
        self.assertEqual(Decimal(fill["quantity"]), 2)
        self.assertEqual(Decimal(fill["unit_cost"]), 5)
        self.assertEqual(len(self.expect(200, self.product_path + "/receipts")), 1)

    def test_expected_quantity_accepts_exact_fractional_inventory_balance(self):
        unit = self.expect(201, self.product_path + "/units", {
            "name": "หน่วยย่อย", "multiplier": "0.000001", "price": "10",
        })
        self.expect(201, self.product_path + "/receipts", {
            "unit_id": unit["id"], "quantity": "0.000001", "unit_cost": "0.000001",
        })
        product, = self.expect(200, "/products")
        self.assertEqual(Decimal(product["quantity"]), Decimal("0.000000000001"))
        result = self.expect(201, self.count_path, self.count(product["quantity"], "0"))
        self.assertEqual(Decimal(result["delta"]), Decimal("-0.000000000001"))
        self.assertEqual(self.stock()[0], 0)
