"""Exercise sale validation and stock changes over HTTP."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
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


class SalesApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        server = make_server(Path(directory.name) / "sales.sqlite3", 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

        self.water = self.add_product("W01", "น้ำดื่ม", "ขวด", "25", "24")
        self.eggs = self.add_product("E01", "ไข่ไก่", "ฟอง", "5", "2")
        self.pack = self.post_created(f"/products/{self.water['id']}/units", {
            "name": "แพ็ก", "multiplier": "12", "price": "150",
        })

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
            return response.status, json.load(response)

    def post_created(self, path, data):
        status, result = self.request(path, data)
        self.assertEqual(status, 201, result)
        return result

    def add_product(self, code, name, unit, price, quantity):
        product = self.post_created("/products", {
            "code": code, "name": name, "base_unit": unit, "price": price,
        })
        self.post_created(f"/products/{product['id']}/receipts", {
            "unit_id": product["base_unit_id"], "quantity": quantity, "unit_cost": "3",
        })
        return product

    def stock(self):
        status, products = self.request("/products")
        self.assertEqual(status, 200)
        return {product["code"]: Decimal(product["quantity"]) for product in products}

    @staticmethod
    def line(product, quantity, price, unit=None):
        return {
            "product_id": product["id"],
            "unit_id": unit["id"] if unit else product["base_unit_id"],
            "quantity": quantity,
            "expected_unit_price": price,
        }

    @staticmethod
    def sale(items, *, cash="0", qr="0", credit="0", customer_id=None, qr_confirmed=False):
        return {
            "id": str(uuid4()),
            "items": items,
            "payments": {"cash": cash, "qr": qr, "credit": credit},
            "customer_id": customer_id,
            "qr_confirmed": qr_confirmed,
        }

    def assert_rejected(self, sale, statuses):
        stock_before = self.stock()
        status, result = self.request("/sales", sale)
        self.assertIn(status, statuses, result)
        self.assertEqual(self.stock(), stock_before)
        self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 404)

    def test_mixed_payment_persists_receipt_and_converts_units(self):
        customer = self.post_created("/customers", {"name": "ลูกค้าทดสอบ"})
        self.assertEqual(customer["name"], "ลูกค้าทดสอบ")
        status, customers = self.request("/customers")
        self.assertEqual(status, 200)
        self.assertIn(customer, customers)

        sale = self.sale(
            [self.line(self.water, "1", "150", self.pack), self.line(self.water, "2", "25")],
            cash="50", qr="50", credit="100", customer_id=customer["id"], qr_confirmed=True,
        )
        result = self.post_created("/sales", sale)
        self.assertEqual(result["id"], sale["id"])
        self.assertTrue(result["created_at"])
        self.assertEqual(Decimal(result["total"]), Decimal("200"))
        self.assertEqual(result["customer_id"], customer["id"])
        self.assertEqual(result["customer_name"], customer["name"])
        self.assertEqual(
            {method: Decimal(amount) for method, amount in result["payments"].items()},
            {"cash": Decimal("50"), "qr": Decimal("50"), "credit": Decimal("100")},
        )
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(
            {
                (item["name"], item["unit_name"], Decimal(item["quantity"]),
                 Decimal(item["unit_price"]), Decimal(item["total"]))
                for item in result["items"]
            },
            {
                ("น้ำดื่ม", "แพ็ก", Decimal("1"), Decimal("150"), Decimal("150")),
                ("น้ำดื่ม", "ขวด", Decimal("2"), Decimal("25"), Decimal("50")),
            },
        )
        self.assertEqual(self.request(f"/sales/{sale['id']}"), (200, result))
        self.assertEqual(self.stock(), {"W01": Decimal("10"), "E01": Decimal("2")})

    def test_concurrent_replay_keeps_one_receipt_and_conflicting_replay_is_rejected(self):
        sale = self.sale([self.line(self.water, "1", "25")], cash="25")
        with ThreadPoolExecutor(max_workers=2) as executor:
            first, second = executor.map(lambda _: self.request("/sales", sale), range(2))

        self.assertIn(201, (first[0], second[0]))
        self.assertTrue(all(status in (200, 201) for status, _ in (first, second)))
        self.assertEqual(first[1], second[1])
        self.assertEqual(self.stock()["W01"], Decimal("23"))

        changed = deepcopy(sale)
        changed["items"][0]["quantity"] = "2"
        changed["payments"]["cash"] = "50"
        self.assertEqual(self.request("/sales", changed)[0], 409)
        self.assertEqual(self.request(f"/sales/{sale['id']}"), (200, first[1]))
        self.assertEqual(self.stock()["W01"], Decimal("23"))

    def test_concurrent_distinct_sales_cannot_both_sell_last_stock(self):
        first_sale = self.sale([self.line(self.eggs, "2", "5")], cash="10")
        second_sale = self.sale([self.line(self.eggs, "2", "5")], cash="10")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(
                lambda sale: self.request("/sales", sale), [first_sale, second_sale],
            ))

        self.assertEqual(sorted(status for status, _ in results), [201, 409])
        self.assertEqual(self.stock()["E01"], Decimal("0"))
        for sale, (status, _) in zip((first_sale, second_sale), results):
            self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 200 if status == 201 else 404)

    def test_rejects_cart_when_stock_is_insufficient_for_any_item(self):
        sale = self.sale(
            [self.line(self.water, "1", "25"), self.line(self.eggs, "3", "5")], cash="40",
        )
        self.assert_rejected(sale, (409,))

    def test_rejects_cart_when_combined_units_exceed_stock(self):
        sale = self.sale(
            [self.line(self.water, "2", "150", self.pack), self.line(self.water, "1", "25")],
            cash="325",
        )
        self.assert_rejected(sale, (409,))

    def test_rejects_stale_price(self):
        sale = self.sale([self.line(self.water, "1", "24")], cash="24")
        self.assert_rejected(sale, (409,))

    def test_rejects_invalid_payments_without_creating_a_sale(self):
        items = [self.line(self.water, "1", "25")]
        for label, payments in (
            ("payment sum differs from sale total", {"cash": "24"}),
            ("credit has no customer", {"credit": "25"}),
            ("credit customer does not exist", {"credit": "25", "customer_id": str(uuid4())}),
            ("QR transfer is unconfirmed", {"qr": "25"}),
            ("negative payment", {"cash": "26", "qr": "-1", "qr_confirmed": True}),
        ):
            with self.subTest(label=label):
                self.assert_rejected(self.sale(items, **payments), (400, 422))
