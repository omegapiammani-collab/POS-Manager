"""Verify sale corrections through the HTTP, inventory, and debt entry points."""

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


class SaleCorrectionsApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "corrections.sqlite3"
        server = make_server(self.database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

        self.customer = self.created("/customers", {"name": "ลูกค้า ก"})
        self.other_customer = self.created("/customers", {"name": "ลูกค้า ข"})
        self.water = self.created("/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "100",
        })
        self.created(f"/products/{self.water['id']}/receipts", {
            "unit_id": self.water["base_unit_id"], "quantity": "10", "unit_cost": "25",
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

    def expect(self, status, path, data=None):
        actual, result = self.request(path, data)
        self.assertEqual(actual, status, result)
        return result

    def created(self, path, data):
        return self.expect(201, path, data)

    def sale(self, *, quantity=1, credit=0, qr=0, customer=None):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": self.water["id"],
                "unit_id": self.water["base_unit_id"],
                "quantity": str(quantity),
                "expected_unit_price": "100",
            }],
            "payments": {"cash": str(100 * quantity - credit - qr), "qr": str(qr), "credit": str(credit)},
            "customer_id": customer["id"] if customer else None,
            "qr_confirmed": qr > 0,
        }

    def sell(self, **details):
        return self.created("/sales", self.sale(**details))

    def repay(self, amount):
        return self.created(f"/customers/{self.customer['id']}/repayments", {
            "id": str(uuid4()), "amount": str(amount), "method": "cash",
        })

    @staticmethod
    def correction(replacement=None, *, action=None):
        return {
            "id": str(uuid4()), "reason": "แก้รายการหน้าร้าน",
            "replacement": replacement, "excess_action": action,
        }

    @staticmethod
    def correction_path(sale):
        return f"/sales/{sale['id']}/corrections"

    def history(self):
        return {sale["id"]: sale for sale in self.expect(200, "/sale-history")}

    def stock(self):
        products = self.expect(200, "/products")
        return Decimal(products[0]["quantity"])

    def debt(self, customer=None):
        customer = self.customer if customer is None else customer
        return self.expect(200, f"/customers/{customer['id']}/debt")

    def balances(self):
        return {
            customer["id"]: Decimal(customer["outstanding"])
            for customer in self.expect(200, "/customer-debts")
        }

    def snapshot(self):
        return self.history(), self.stock(), self.debt(), self.debt(self.other_customer), self.balances()

    def test_void_restores_stock_keeps_original_bill_and_replays_once(self):
        sale = self.sell(quantity=3)
        path = self.correction_path(sale)
        correction = self.correction()
        original = self.history()[sale["id"]]
        self.assertEqual(self.stock(), 7)

        result = self.created(path, correction)
        self.assertEqual(result["id"], correction["id"])
        self.assertEqual(result["sale_id"], sale["id"])
        self.assertIsNone(result["replacement_id"])
        self.assertEqual(Decimal(result["excess"]), 0)
        self.assertEqual(self.stock(), 10)
        voided = self.history()[sale["id"]]
        self.assertEqual(voided["status"], "voided")
        self.assertEqual(voided["correction_reason"], correction["reason"])
        self.assertIsNone(voided["replacement_id"])
        self.assertEqual(voided["items"], original["items"])
        self.assertEqual(voided["payments"], original["payments"])

        self.assertEqual(self.expect(200, path, correction), result)
        self.expect(409, path, {**correction, "reason": "เปลี่ยนเหตุผล"})
        self.expect(409, path, self.correction())
        self.assertEqual(self.stock(), 10)
        self.assertEqual(self.history(), {sale["id"]: voided})

    def test_void_revalues_remaining_inventory_at_original_sale_cost(self):
        sale = self.sell(quantity=4)
        self.created(f"/products/{self.water['id']}/receipts", {
            "unit_id": self.water["base_unit_id"], "quantity": "10", "unit_cost": "45",
        })
        before, = self.expect(200, "/products")
        self.assertEqual(Decimal(before["quantity"]), 16)
        self.assertEqual(Decimal(before["average_cost"]), Decimal("37.50"))

        self.created(self.correction_path(sale), self.correction())
        after, = self.expect(200, "/products")
        self.assertEqual(Decimal(after["quantity"]), 20)
        self.assertEqual(Decimal(after["average_cost"]), Decimal("35"))

    def test_replacement_updates_stock_payments_and_customer_together(self):
        sale = self.sell(quantity=6, credit=100, customer=self.customer)
        replacement = self.sale(quantity=7, credit=230, qr=170, customer=self.other_customer)
        result = self.created(self.correction_path(sale), self.correction(replacement))

        self.assertEqual(result["replacement_id"], replacement["id"])
        self.assertEqual(self.stock(), 3)
        history = self.history()
        self.assertEqual(len(history), 2)
        self.assertEqual(history[sale["id"]]["status"], "voided")
        self.assertEqual(history[sale["id"]]["replacement_id"], replacement["id"])
        new = history[replacement["id"]]
        self.assertEqual(new["status"], "active")
        self.assertEqual(new["customer_id"], self.other_customer["id"])
        self.assertEqual({method: Decimal(value) for method, value in new["payments"].items()},
                         {"cash": 300, "qr": 170, "credit": 230})
        self.assertEqual(Decimal(self.debt()["outstanding"]), 0)
        self.assertEqual(Decimal(self.debt(self.other_customer)["outstanding"]), 230)
        self.assertEqual(self.balances(), {self.customer["id"]: 0, self.other_customer["id"]: 230})

    def test_invalid_replacement_preserves_stock_history_and_debt(self):
        sale = self.sell(quantity=6, credit=100, customer=self.customer)
        self.repay(30)
        before = self.snapshot()
        replacement = self.sale(quantity=11, credit=100, customer=self.customer)
        self.expect(409, self.correction_path(sale), self.correction(replacement))
        self.assertEqual(self.snapshot(), before)
        self.expect(404, f"/sales/{replacement['id']}")

    def test_existing_repayment_follows_replacement_for_same_customer(self):
        sale = self.sell(credit=85, customer=self.customer)
        self.repay(55)
        replacement = self.sale(credit=70, customer=self.customer)
        result = self.created(self.correction_path(sale), self.correction(replacement))
        self.assertEqual(Decimal(result["excess"]), 0)

        debt = self.debt()
        self.assertEqual(Decimal(debt["outstanding"]), 15)
        bill, = debt["bills"]
        self.assertEqual(bill["id"], replacement["id"])
        self.assertEqual(Decimal(bill["credit"]), 70)
        self.assertEqual(Decimal(bill["paid"]), 55)
        self.assertEqual(Decimal(bill["outstanding"]), 15)

    def test_excess_requires_action_and_refund_leaves_no_open_debt(self):
        sale = self.sell(credit=85, customer=self.customer)
        repayment = self.repay(55)
        path = self.correction_path(sale)
        replacement = self.sale(credit=40, customer=self.customer)
        correction = self.correction(replacement)
        before = self.snapshot()
        self.expect(409, path, correction)
        self.assertEqual(self.snapshot(), before)

        refund = {**correction, "excess_action": "refund_qr", "expected_excess": "10.00"}
        conflict = self.expect(409, path, refund)
        self.assertEqual(conflict["code"], "excess_changed")
        self.assertEqual(Decimal(conflict["excess"]), 15)
        self.assertEqual(self.snapshot(), before)

        result = self.created(path, {**refund, "expected_excess": "15.00"})
        self.assertEqual(Decimal(result["excess"]), 15)
        self.assertEqual(result["excess_action"], "refund_qr")
        debt = self.debt()
        self.assertEqual(Decimal(debt["outstanding"]), 0)
        bill, = debt["bills"]
        self.assertEqual(bill["id"], replacement["id"])
        self.assertEqual(Decimal(bill["paid"]), 40)
        original_payment = next(row for row in debt["repayments"] if row["id"] == repayment["id"])
        self.assertEqual(Decimal(original_payment["amount"]), 55)
        self.assertEqual(self.balances()[self.customer["id"]], 0)

    def test_apply_excess_to_other_bills_in_fifo_order(self):
        sale = self.sell(credit=85, customer=self.customer)
        oldest = self.sell(credit=20, customer=self.customer)
        newest = self.sell(credit=40, customer=self.customer)
        with closing(connect(self.database)) as db:
            db.executemany("UPDATE sales SET created_at = ? WHERE id = ?", (
                ("2026-11-01T03:00:00.000Z", sale["id"]),
                ("2026-11-02T03:00:00.000Z", oldest["id"]),
                ("2026-11-03T03:00:00.000Z", newest["id"]),
            ))
        self.repay(55)

        result = self.created(self.correction_path(sale), self.correction(action="apply"))
        self.assertEqual(Decimal(result["excess"]), 55)
        self.assertEqual(result["excess_action"], "apply")
        debt = self.debt()
        self.assertEqual(Decimal(debt["outstanding"]), 5)
        self.assertEqual({bill["id"]: Decimal(bill["paid"]) for bill in debt["bills"]},
                         {oldest["id"]: 20, newest["id"]: 35})
        self.assertEqual(self.balances()[self.customer["id"]], 5)

    def test_apply_fails_atomically_if_other_debt_is_too_small(self):
        sale = self.sell(credit=85, customer=self.customer)
        self.repay(55)
        self.sell(credit=20, customer=self.customer)
        before = self.snapshot()
        self.expect(409, self.correction_path(sale), self.correction(action="apply"))
        self.assertEqual(self.snapshot(), before)
