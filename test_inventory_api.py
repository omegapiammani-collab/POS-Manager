import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

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
        headers = {"Content-Type": "application/json"}
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
