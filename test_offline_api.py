"""Exercise the HTTP app shell and the server side of an offline sale retry."""

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


class OfflineApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        server = make_server(Path(directory.name) / "offline.sqlite3", 0)
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
            self.assertEqual(response.headers.get_content_type(), "application/json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.load(response)

    def expect(self, status, path, data=None):
        actual, result = self.request(path, data)
        self.assertEqual(actual, status, result)
        return result

    def replenish(self, product):
        return self.expect(201, f"/products/{product['id']}/receipts", {
            "unit_id": product["base_unit_id"], "quantity": "1", "unit_cost": "5",
        })

    def stock(self):
        product, = self.expect(200, "/products")
        return Decimal(product["quantity"])

    @staticmethod
    def sale(product):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": product["id"],
                "unit_id": product["base_unit_id"],
                "quantity": "1",
                "expected_unit_price": "10",
            }],
            "payments": {"cash": "10", "qr": "0", "credit": "0"},
            "customer_id": None,
            "qr_confirmed": False,
        }

    def test_checkout_app_shell_is_served(self):
        for path, content_type in (
            ("/checkout", "text/html"),
            ("/inventory.css", "text/css"),
            ("/checkout.js", "text/javascript"),
            ("/offline-store.js", "text/javascript"),
            ("/sw.js", "text/javascript"),
        ):
            with self.subTest(path=path), urlopen(self.origin + path, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get_content_type(), content_type)
                self.assertEqual(response.headers["Cache-Control"], "no-cache")
                body = response.read().decode("utf-8")
                self.assertTrue(body.strip())
                if path == "/checkout":
                    self.assertIn('src="/offline-store.js"', body)
                    self.assertIn('src="/checkout.js"', body)

    def test_out_of_stock_queued_sale_can_retry_and_replay_without_double_stock_change(self):
        product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.replenish(product)
        first_sale, second_sale = self.sale(product), self.sale(product)

        first_receipt = self.expect(201, "/sales", first_sale)
        self.assertEqual(first_receipt["id"], first_sale["id"])
        self.assertEqual(self.stock(), 0)

        conflict = self.expect(409, "/sales", second_sale)
        self.assertEqual(conflict["code"], "insufficient_stock")
        self.expect(404, f"/sales/{second_sale['id']}")
        self.assertEqual(self.stock(), 0)

        self.replenish(product)
        second_receipt = self.expect(201, "/sales", second_sale)
        self.assertEqual(second_receipt["id"], second_sale["id"])
        self.assertEqual(self.stock(), 0)

        # A client may lose the success response and send the same operation again.
        self.assertEqual(self.expect(200, "/sales", second_sale), second_receipt)
        self.assertEqual(self.expect(200, "/sales", first_sale), first_receipt)
        self.assertEqual(self.stock(), 0)
        self.assertEqual(
            {receipt["id"] for receipt in self.expect(200, "/sale-history")},
            {first_sale["id"], second_sale["id"]},
        )

    def test_two_offline_sales_survive_and_receipts_reconcile_cost(self):
        product = self.expect(201, "/products", {
            "code": "W02", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.replenish(product)
        first, second = self.sale(product), self.sale(product)
        second["items"][0]["quantity"] = "2"
        second["payments"]["cash"] = "20"
        self.expect(201, "/offline-sales", first)
        self.expect(409, "/sales", second)
        saved = self.expect(201, "/offline-sales", second)
        self.assertEqual(self.expect(200, "/sales", second), saved)
        self.assertEqual(self.stock(), -2)
        self.assertEqual(self.expect(200, f"/sales/{first['id']}")["id"], first["id"])
        shortage, = saved["stock_shortages"]
        self.assertEqual(Decimal(shortage["provisional_unit_cost"]), 5)
        self.assertEqual(Decimal(shortage["remaining"]), 2)
        self.assertEqual(self.expect(200, "/stock-shortages")[0]["sale_id"], second["id"])

        receipt_path = f"/products/{product['id']}/receipts"
        first_fill = self.expect(201, receipt_path, {
            "unit_id": product["base_unit_id"], "quantity": "1", "unit_cost": "7",
        })
        self.assertEqual(self.stock(), -1)
        self.assertEqual(Decimal(self.expect(200, "/stock-shortages")[0]["remaining"]), 1)

        correction = {"id": str(uuid4()), "reason": "ยกเลิกบิล", "replacement": None}
        path = f"/sales/{second['id']}/corrections"
        self.assertEqual(self.expect(409, path, correction)["code"], "stock_shortage_unresolved")

        second_fill = self.expect(201, receipt_path, {
            "unit_id": product["base_unit_id"], "quantity": "2", "unit_cost": "9",
        })
        self.assertEqual(self.stock(), 1)
        self.assertEqual(self.expect(200, "/stock-shortages"), [])
        reconciled, = self.expect(200, f"/sales/{second['id']}")["stock_shortages"]
        self.assertEqual(Decimal(reconciled["remaining"]), 0)
        self.assertEqual(
            [(f["receipt_id"], Decimal(f["quantity"]), Decimal(f["unit_cost"])) for f in reconciled["fills"]],
            [(first_fill["id"], Decimal(1), Decimal(7)), (second_fill["id"], Decimal(1), Decimal(9))],
        )
        self.assertEqual(Decimal(self.expect(200, "/products")[0]["average_cost"]), 9)
        self.expect(201, path, correction)
        self.assertEqual(self.stock(), 3)
        self.assertAlmostEqual(Decimal(self.expect(200, "/products")[0]["average_cost"]), Decimal(25) / 3)

    def test_offline_sale_with_no_prior_cost_uses_actual_cost_when_received(self):
        product = self.expect(201, "/products", {
            "code": "W03", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        first, second = self.sale(product), self.sale(product)
        first["items"] *= 2
        first["payments"]["cash"] = "20"
        saved = self.expect(201, "/offline-sales", first)
        self.expect(201, "/offline-sales", second)
        self.assertEqual(self.stock(), -3)
        self.assertEqual([row["quantity"] for row in saved["stock_shortages"]], ["1", "1"])
        self.assertTrue(all(row["provisional_unit_cost"] is None for row in saved["stock_shortages"]))
        self.expect(201, f"/products/{product['id']}/receipts", {
            "unit_id": product["base_unit_id"], "quantity": "2", "unit_cost": "6",
        })
        remaining, = self.expect(200, "/stock-shortages")
        self.assertEqual(remaining["sale_id"], second["id"])
        self.assertEqual(self.stock(), -1)
