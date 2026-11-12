"""Exercise customer credit balances and repayments over HTTP."""

from concurrent.futures import ThreadPoolExecutor
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

from inventory import add_product, connect, receive
from inventory_api import make_server
from sales import SALES_SCHEMA, add_customer, checkout


class DebtApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = Path(directory.name) / "debts.sqlite3"

        # Create sales in the schema used before repayments were introduced.
        with closing(connect(database)) as db:
            db.executescript(SALES_SCHEMA)
            self.customer = add_customer(db, "ลูกค้า ก")
            self.other_customer = add_customer(db, "ลูกค้า ข")
            self.product_id, self.unit_id = add_product(db, "W01", "น้ำดื่ม", "ขวด", "100")
            receive(db, self.product_id, self.unit_id, "10", "50")
            _, first = checkout(db, self.sale(self.customer, "40"))
            _, second = checkout(db, self.sale(self.customer, "60"))
            checkout(db, self.sale(self.customer, "0"))
            self.bill_ids = [first["id"], second["id"]]
            db.executemany("UPDATE sales SET created_at = ? WHERE id = ?", (
                ("2026-11-01T03:00:00.000Z", first["id"]),
                ("2026-11-02T03:00:00.000Z", second["id"]),
            ))

        server = make_server(database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

    def sale(self, customer, credit):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": self.product_id,
                "unit_id": self.unit_id,
                "quantity": "1",
                "expected_unit_price": "100",
            }],
            "payments": {"cash": str(100 - Decimal(credit)), "qr": "0", "credit": credit},
            "customer_id": customer["id"],
            "qr_confirmed": False,
        }

    @staticmethod
    def repayment(amount, method="cash", note=None):
        data = {"id": str(uuid4()), "amount": amount, "method": method}
        if note is not None:
            data["note"] = note
        return data

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

    def debt(self, customer=None):
        customer = self.customer if customer is None else customer
        status, result = self.request(f"/customers/{customer['id']}/debt")
        self.assertEqual(status, 200, result)
        return result

    def repay(self, data, customer=None):
        customer = self.customer if customer is None else customer
        return self.request(f"/customers/{customer['id']}/repayments", data)

    def balances(self):
        status, customers = self.request("/customer-debts")
        self.assertEqual(status, 200, customers)
        return {row["id"]: Decimal(row["outstanding"]) for row in customers}

    def test_existing_credit_sales_and_zero_balance_customer_are_visible(self):
        debt = self.debt()
        self.assertEqual(debt["id"], self.customer["id"])
        self.assertEqual(debt["name"], self.customer["name"])
        self.assertEqual(Decimal(debt["outstanding"]), 100)
        self.assertEqual(
            {bill["id"]: (Decimal(bill["credit"]), Decimal(bill["paid"]), Decimal(bill["outstanding"]))
             for bill in debt["bills"]},
            {self.bill_ids[0]: (40, 0, 40), self.bill_ids[1]: (60, 0, 60)},
        )
        self.assertEqual(debt["repayments"], [])
        self.assertEqual(self.balances(), {self.customer["id"]: 100, self.other_customer["id"]: 0})

    def test_repayment_allocates_fifo_and_retains_history_after_settlement(self):
        payment = self.repayment("70.50", method="qr", note="โอนชำระ")
        status, result = self.repay(payment)
        self.assertEqual(status, 201, result)
        self.assertEqual(result["id"], payment["id"])
        self.assertTrue(result["created_at"])
        self.assertEqual(Decimal(result["amount"]), Decimal("70.50"))
        self.assertEqual(result["method"], "qr")
        self.assertEqual(result["note"], "โอนชำระ")
        self.assertEqual(
            {row["sale_id"]: Decimal(row["amount"]) for row in result["allocations"]},
            {self.bill_ids[0]: Decimal("40"), self.bill_ids[1]: Decimal("30.50")},
        )

        debt = self.debt()
        self.assertEqual(Decimal(debt["outstanding"]), Decimal("29.50"))
        self.assertIn(result, debt["repayments"])
        self.assertEqual(
            {bill["id"]: (Decimal(bill["paid"]), Decimal(bill["outstanding"])) for bill in debt["bills"]},
            {self.bill_ids[0]: (40, 0), self.bill_ids[1]: (Decimal("30.50"), Decimal("29.50"))},
        )
        self.assertEqual(self.repay(self.repayment("29.50"))[0], 201)
        settled = self.debt()
        self.assertEqual(Decimal(settled["outstanding"]), 0)
        self.assertEqual(len(settled["repayments"]), 2)
        self.assertIn(result, settled["repayments"])
        self.assertEqual(self.balances()[self.customer["id"]], 0)

    def test_overpayment_and_invalid_requests_are_atomic(self):
        before = self.debt()
        for data, expected in (
            (self.repayment("100.01"), (409,)),
            (self.repayment("0"), (400, 422)),
            (self.repayment("1.001"), (400, 422)),
            (self.repayment("1", "credit"), (400, 422)),
        ):
            with self.subTest(data=data):
                status, result = self.repay(data)
                self.assertIn(status, expected, result)
                self.assertEqual(self.debt(), before)
        self.assertEqual(self.balances()[self.customer["id"]], 100)

    def test_concurrent_distinct_repayments_cannot_overpay(self):
        payments = [self.repayment("60"), self.repayment("60")]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(self.repay, payments))
        self.assertEqual(sorted(status for status, _ in results), [201, 409])
        debt = self.debt()
        self.assertEqual(Decimal(debt["outstanding"]), 40)
        self.assertEqual(debt["repayments"], [result for status, result in results if status == 201])

    def test_replay_is_idempotent_and_conflicts_across_customers(self):
        status, result = self.request("/sales", self.sale(self.other_customer, "70"))
        self.assertEqual(status, 201, result)
        payment = self.repayment("40", note="ชำระ")
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(self.repay, [payment, payment]))
        self.assertEqual(sorted(status for status, _ in responses), [200, 201])
        self.assertEqual(responses[0][1], responses[1][1])

        first_debt, other_debt = self.debt(), self.debt(self.other_customer)
        self.assertEqual(Decimal(first_debt["outstanding"]), 60)
        self.assertEqual(len(first_debt["repayments"]), 1)
        self.assertEqual(self.repay({**payment, "amount": "39"})[0], 409)
        self.assertEqual(self.repay(payment, self.other_customer)[0], 409)
        self.assertEqual(self.debt(), first_debt)
        self.assertEqual(self.debt(self.other_customer), other_debt)
