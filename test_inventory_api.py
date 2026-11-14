from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4
from test_store_headers import store_headers

from inventory_api import make_server


class InventoryApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        server = make_server(Path(directory.name) / "test.sqlite3", 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

    def request(self, path, data=None):
        headers = store_headers(self.origin)
        body = json.dumps(data).encode() if data is not None else None
        request = Request(self.origin + path, data=body, headers=headers)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_create_search_and_receive(self):
        product = {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด",
            "price": "15", "minimum_quantity": "12",
        }
        status, created = self.request("/products", product)
        self.assertEqual(status, 201)
        self.assertEqual(self.request("/products", product)[0], 409)

        path = f"/products/{created['id']}"
        status, pack = self.request(path + "/units", {
            "name": "แพ็ก", "multiplier": "12", "price": "150",
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.request(path + "/receipts", {
            "unit_id": pack["id"], "quantity": "1", "unit_cost": "120",
        })[0], 201)
        self.assertEqual(self.request("/products?q=w01")[1][0]["low_stock"], True)
        self.assertEqual(self.request(path + "/receipts", {
            "unit_id": created["base_unit_id"], "quantity": "12", "unit_cost": "12",
        })[0], 201)

        status, products = self.request("/products?" + urlencode({"q": "น้ำ"}))
        self.assertEqual(status, 200)
        self.assertEqual(len(products), 1)
        self.assertEqual(products[0]["quantity"], "24")
        self.assertEqual(products[0]["average_cost"], "11")
        self.assertFalse(products[0]["low_stock"])
        self.assertEqual(self.request(path + "/receipts")[1][1]["unit_name"], "แพ็ก")

    def test_invalid_input(self):
        self.assertEqual(self.request("/products", {"code": 1})[0], 400)
        self.assertEqual(self.request("/products/missing/receipts")[0], 404)

    def test_receipt_replay_updates_stock_once(self):
        _, product = self.request("/products", {
            "code": "W01", "name": "น้ำ", "base_unit": "ขวด", "price": "15",
        })
        path = "/products/" + product["id"] + "/receipts"
        receipt = {"id": str(uuid4()), "unit_id": product["base_unit_id"], "quantity": "2", "unit_cost": "10"}
        self.assertEqual(self.request(path, receipt), (201, {"id": receipt["id"]}))
        self.assertEqual(self.request(path, {**receipt, "quantity": "2.0"}), (201, {"id": receipt["id"]}))
        self.assertEqual(self.request(path, {**receipt, "quantity": "3"})[0], 409)
        self.assertEqual(self.request("/products")[1][0]["quantity"], "2")
        self.assertEqual(len(self.request(path)[1]), 1)

    def test_product_availability_and_offline_replay(self):
        _, product = self.request("/products", {
            "code": "W01", "name": "น้ำ", "base_unit": "ขวด", "price": "15",
        })
        path = "/products/" + product["id"]
        self.assertTrue(self.request("/products")[1][0]["available"])
        self.assertEqual(self.request(path + "/receipts", {
            "unit_id": product["base_unit_id"], "quantity": "3", "unit_cost": "10",
        })[0], 201)
        sale = {
            "id": str(uuid4()),
            "items": [{"product_id": product["id"], "unit_id": product["base_unit_id"],
                       "quantity": "1", "expected_unit_price": "15"}],
            "payments": {"cash": "15", "qr": "0", "credit": "0"},
            "qr_confirmed": False,
        }
        self.assertEqual(self.request("/sales", sale)[0], 201)
        self.assertEqual(self.request(path + "/availability", {"available": False})[0], 200)
        self.assertFalse(self.request("/products")[1][0]["available"])
        self.assertEqual(self.request("/sales", sale)[0], 200)
        self.assertEqual(self.request("/sales", {**sale, "id": str(uuid4())})[0], 409)
        offline = {**sale, "id": str(uuid4()), "sold_at": "2025-01-01T00:00:00.000Z"}
        self.assertEqual(self.request("/offline-sales", offline)[0], 201)
        self.assertEqual(self.request("/offline-sales", offline)[0], 200)
        self.assertEqual(self.request(path + "/availability", {"available": "true"})[0], 400)
        self.assertEqual(self.request(path + "/availability", {"available": True})[0], 200)
        self.assertTrue(self.request("/products")[1][0]["available"])
        self.assertEqual(self.request("/sales", {**sale, "id": str(uuid4())})[0], 201)

    def test_edit_product_guards_stale_changes_and_duplicate_code(self):
        product = {"code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "15"}
        _, created = self.request("/products", product)
        self.assertEqual(self.request("/products", {**product, "code": "W02"})[0], 201)
        path = f"/products/{created['id']}/edit"
        update = {
            "code": "W03", "name": "น้ำแร่", "minimum_quantity": "4",
            "expected": {"code": "W01", "name": "น้ำดื่ม", "minimum_quantity": "0"},
        }
        self.assertEqual(self.request(path, update)[0], 200)
        self.assertEqual(self.request(path, update)[0], 200)
        status, error = self.request(path, {**update, "name": "น้ำดื่มใหม่"})
        self.assertEqual((status, error["code"]), (409, "product_changed"))
        current = {key: update[key] for key in ("code", "name", "minimum_quantity")}
        self.assertEqual(self.request(path, {**update, "expected": current, "code": "W02"})[0], 409)
        _, found = self.request("/products?q=w03")
        self.assertEqual([row["name"] for row in found], ["น้ำแร่"])
        self.assertEqual(found[0]["minimum_quantity"], "4")

    def test_unit_price_edit_preserves_receipts_and_rejects_stale_sale(self):
        _, product = self.request("/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "15",
        })
        path = f"/products/{product['id']}"
        unit = product["base_unit_id"]
        self.assertEqual(self.request(path + "/receipts", {
            "unit_id": unit, "quantity": "2", "unit_cost": "8",
        })[0], 201)
        sale = {
            "id": "a10f6e0c-5cef-401a-88cf-bf0f9fce5805",
            "items": [{
                "product_id": product["id"], "unit_id": unit, "quantity": "1",
                "expected_unit_price": "15",
            }],
            "payments": {"cash": "15", "qr": "0", "credit": "0"},
            "customer_id": None, "qr_confirmed": False,
        }
        self.assertEqual(self.request("/sales", sale)[0], 201)
        price_path = path + f"/units/{unit}/price"
        update = {"price": "18", "expected_price": "15"}
        self.assertEqual(self.request(price_path, update)[0], 200)
        self.assertEqual(self.request(price_path, update)[0], 200)
        status, error = self.request(price_path, {"price": "20", "expected_price": "15"})
        self.assertEqual((status, error["code"]), (409, "price_changed"))
        stale_sale = {**sale, "id": "a10f6e0c-5cef-401a-88cf-bf0f9fce5806"}
        status, error = self.request("/sales", stale_sale)
        self.assertEqual((status, error["code"]), (409, "price_changed"))
        self.assertEqual(self.request("/sales/" + sale["id"])[1]["items"][0]["unit_price"], "15")
        _, rows = self.request("/products")
        self.assertEqual(rows[0]["units"][0]["price"], "18")
        self.assertEqual(rows[0]["quantity"], "1")

    def test_timed_offline_sale_preserves_price_and_mixed_payment_after_catalog_edit(self):
        status, product = self.request("/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "15",
        })
        self.assertEqual(status, 201)
        path = f"/products/{product['id']}"
        unit = product["base_unit_id"]
        self.assertEqual(self.request(path + "/receipts", {
            "unit_id": unit, "quantity": "3", "unit_cost": "8",
        })[0], 201)
        status, customer = self.request("/customers", {"name": "ลูกค้าทดสอบ"})
        self.assertEqual(status, 201)
        sold_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(self.request(path + f"/units/{unit}/price", {
            "price": "18", "expected_price": "15",
        })[0], 200)

        sale = {
            "id": str(uuid4()),
            "items": [{
                "product_id": product["id"], "unit_id": unit, "quantity": "2",
                "expected_unit_price": "15",
            }],
            "payments": {"cash": "10", "qr": "5", "credit": "15"},
            "customer_id": customer["id"], "qr_confirmed": True,
        }
        for endpoint in ("/sales", "/offline-sales"):
            with self.subTest(endpoint=endpoint):
                status, error = self.request(endpoint, sale)
                self.assertEqual((status, error["code"]), (409, "price_changed"))
        self.assertEqual(self.request("/sales/" + sale["id"])[0], 404)
        self.assertEqual(Decimal(self.request("/products")[1][0]["quantity"]), 3)

        timed_sale = {**sale, "sold_at": sold_at}
        mismatched_payment = {**timed_sale, "payments": {**sale["payments"], "cash": "11"}}
        self.assertEqual(self.request("/offline-sales", mismatched_payment)[0], 400)
        self.assertEqual(self.request("/sales/" + sale["id"])[0], 404)

        status, receipt = self.request("/offline-sales", timed_sale)
        self.assertEqual(status, 201, receipt)
        self.assertEqual(receipt["id"], sale["id"])
        self.assertEqual(receipt["sold_at"], sold_at)
        line, = receipt["items"]
        self.assertEqual(Decimal(line["unit_price"]), 15)
        self.assertEqual(Decimal(line["total"]), 30)
        self.assertEqual(Decimal(receipt["total"]), 30)
        self.assertEqual(
            receipt["payments"], {"cash": "10.00", "qr": "5.00", "credit": "15.00"},
        )
        self.assertEqual(receipt["customer_id"], customer["id"])
        self.assertEqual(self.request("/offline-sales", timed_sale), (200, receipt))
        self.assertEqual(self.request("/sales/" + sale["id"]), (200, receipt))
        current, = self.request("/products")[1]
        self.assertEqual(Decimal(current["units"][0]["price"]), 18)
        self.assertEqual(Decimal(current["quantity"]), 1)
