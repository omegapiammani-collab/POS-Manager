"""Exercise the HTTP app shell and the server side of an offline sale retry."""

from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
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
            headers={"Content-Type": "application/json"},
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
