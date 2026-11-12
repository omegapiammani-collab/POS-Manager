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
