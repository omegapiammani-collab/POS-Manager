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
from test_store_headers import store_headers
from uuid import uuid4

from inventory_api import make_server


class SalesApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "sales.sqlite3"
        server = make_server(self.database, 0)
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
            headers=store_headers(self.origin),
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

    def test_confirmed_online_shortage_checks_price_and_availability_and_replays_once(self):
        sale = self.sale([self.line(self.eggs, "3", "5")], cash="15")
        self.assertEqual(self.request("/sales", sale)[1]["code"], "insufficient_stock")
        self.assertEqual(self.stock()["E01"], Decimal("2"))
        self.assertEqual(self.request("/sales/allow-negative", {**sale, "sold_at": "2020-01-01T00:00:00.000Z"})[0], 400)
        self.assertEqual(self.request("/sales/allow-negative", {**sale, "offline": True})[0], 400)
        price_path = f"/products/{self.eggs['id']}/units/{self.eggs['base_unit_id']}/price"
        self.assertEqual(self.request(price_path, {"price": "6", "expected_price": "5"})[0], 200)
        self.assertEqual(self.request("/sales/allow-negative", sale)[1]["code"], "price_changed")
        self.assertEqual(self.stock()["E01"], Decimal("2"))
        self.assertEqual(self.request(price_path, {"price": "5", "expected_price": "6"})[0], 200)
        availability = f"/products/{self.eggs['id']}/availability"
        self.assertEqual(self.request(availability, {"available": False})[0], 200)
        self.assertEqual(self.request("/sales/allow-negative", sale)[1]["code"], "item_unavailable")
        self.assertEqual(self.stock()["E01"], Decimal("2"))
        self.assertEqual(self.request(availability, {"available": True})[0], 200)
        status, result = self.request("/sales/allow-negative", sale)
        self.assertEqual(status, 201)
        self.assertEqual(Decimal(result["stock_shortages"][0]["remaining"]), Decimal("1"))
        self.assertEqual(self.stock()["E01"], Decimal("-1"))
        self.assertEqual(self.request("/sales/allow-negative", sale), (200, result))
        self.assertEqual(self.request("/sales", sale), (200, result))
        changed = deepcopy(sale)
        changed["items"][0]["quantity"] = "4"
        changed["payments"]["cash"] = "20"
        self.assertEqual(self.request("/sales/allow-negative", changed)[1]["code"], "idempotency_conflict")
        self.assertEqual(self.stock()["E01"], Decimal("-1"))

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

    def test_abandoned_sale_is_idempotent_and_blocked_on_all_checkout_routes(self):
        sale = self.sale([self.line(self.eggs, "1", "5")], cash="5")
        path = f"/sales/{sale['id']}/abandon"
        self.assertEqual(self.request(path, {}), (200, {"id": sale["id"], "abandoned": True}))
        self.assertEqual(self.request(path, {}), (200, {"id": sale["id"], "abandoned": True}))
        for route, payload in (("/sales", sale), ("/sales/allow-negative", sale),
                               ("/offline-sales", {**sale, "offline": True, "sold_at": "2020-01-01T00:00:00.000Z"})):
            with self.subTest(route=route):
                status, body = self.request(route, payload)
                self.assertEqual((status, body["code"]), (409, "sale_abandoned"))
        self.assertEqual(self.stock()["E01"], Decimal("2"))
        self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 404)

    def test_all_sale_routes_reject_missing_or_wrong_store_identity(self):
        sale = self.sale([self.line(self.eggs, "1", "5")], cash="5")
        for path in ("/sales", "/offline-sales", "/sales/allow-negative", f"/sales/{sale['id']}/abandon"):
            for store_id in (None, str(uuid4())):
                headers = {"Content-Type": "application/json"}
                if store_id is not None:
                    headers["X-POS-Store-ID"] = store_id
                payload = {} if path.endswith("/abandon") else sale
                req = Request(self.origin + path, data=json.dumps(payload).encode(), headers=headers)
                with self.assertRaises(HTTPError) as error:
                    urlopen(req, timeout=3)
                self.assertEqual(error.exception.code, 409)
                self.assertEqual(json.load(error.exception)["code"], "store_mismatch")
        self.assertEqual(self.stock()["E01"], Decimal("2"))
        self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 404)
        self.assertEqual(self.request("/sales", sale)[0], 201)

    def test_database_swapped_after_identity_lookup_rejects_old_store_header(self):
        old_id = store_headers(self.origin)["X-POS-Store-ID"]
        sale = self.sale([self.line(self.eggs, "1", "5")], cash="5")
        recorded = self.post_created("/sales", sale)
        other = self.database.with_name("other.sqlite3")
        replacement_server = make_server(other, 0)
        replacement_server.server_close()
        old_path = self.database.with_name("original.sqlite3")
        self.database.rename(old_path)
        other.rename(self.database)
        for path, payload in (("/sales", sale), ("/offline-sales", sale),
                              ("/sales/allow-negative", sale), (f"/sales/{sale['id']}/abandon", {}),
                              ("/customers", {"name": "ลูกค้าไม่ควรข้ามร้าน"})):
            req = Request(self.origin + path, data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json", "X-POS-Store-ID": old_id})
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                urlopen(req, timeout=3)
            self.assertEqual(error.exception.code, 409)
            self.assertEqual(json.load(error.exception)["code"], "store_mismatch")
        self.assertNotEqual(store_headers(self.origin)["X-POS-Store-ID"], old_id)
        self.assertEqual(self.request("/customers")[1], [])
        self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 404)
        self.database.rename(other)
        old_path.rename(self.database)
        self.assertEqual(self.request("/sales", sale), (200, recorded))
        self.assertEqual(self.stock()["E01"], Decimal("1"))

    def test_abandon_races_with_sale_and_never_removes_a_recorded_bill(self):
        sale = self.sale([self.line(self.eggs, "1", "5")], cash="5")
        path = f"/sales/{sale['id']}/abandon"
        with ThreadPoolExecutor(max_workers=2) as executor:
            sale_future = executor.submit(self.request, "/sales", sale)
            abandon_future = executor.submit(self.request, path, {})
            recorded, abandoned = sale_future.result(), abandon_future.result()
        if recorded[0] == 201:
            self.assertEqual((abandoned[0], abandoned[1]["code"]), (409, "sale_already_recorded"))
            self.assertEqual(self.request(path, {})[1]["code"], "sale_already_recorded")
            self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 200)
            self.assertEqual(self.stock()["E01"], Decimal("1"))
        else:
            self.assertEqual((recorded[0], recorded[1]["code"]), (409, "sale_abandoned"))
            self.assertEqual(abandoned[0], 200)
            self.assertEqual(self.request(f"/sales/{sale['id']}")[0], 404)
            self.assertEqual(self.stock()["E01"], Decimal("2"))

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
