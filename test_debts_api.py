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
from test_store_headers import store_headers
from uuid import uuid4

from inventory import add_product, connect, receive
from inventory_api import make_server
from sales import SALES_SCHEMA, add_customer, checkout


class DebtApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = Path(directory.name) / "debts.sqlite3"
        self.database = database

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
            headers=store_headers(self.origin),
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

    def test_offline_sale_uses_sold_time_for_future_fifo_without_rewriting_payments(self):
        # Bangkok midnight separates these instants; the offline sale is synced later.
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       ("2026-11-01T16:59:59.999Z", self.bill_ids[0]))
            db.commit()
        previous = self.repayment("10")
        status, original = self.repay(previous)
        self.assertEqual(status, 201)
        offline = self.sale(self.customer, "100")
        offline.update(offline=True, sold_at="2026-11-01T17:00:00.000Z")
        status, sale = self.request("/offline-sales", offline)
        self.assertEqual(status, 201, sale)

        debt = self.debt()
        self.assertEqual([bill["id"] for bill in debt["bills"]],
                         [self.bill_ids[0], sale["id"], self.bill_ids[1]])
        self.assertIsNone(debt["bills"][0]["sold_at"])
        self.assertEqual(debt["bills"][1]["sold_at"], offline["sold_at"])
        self.assertIn(original, debt["repayments"])
        status, payment = self.repay(self.repayment("50"))
        self.assertEqual(status, 201, payment)
        self.assertEqual(payment["allocations"], [
            {"sale_id": self.bill_ids[0], "amount": "30.00"},
            {"sale_id": sale["id"], "amount": "20.00"},
        ])
        self.assertEqual(self.repay(previous), (200, original))
        self.assertIn(original, self.debt()["repayments"])

    def test_fifo_uses_sale_id_to_break_equal_timestamp_ties(self):
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       ("2026-11-01 17:00:00", self.bill_ids[0]))
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       ("2026-11-01T17:00:00.000Z", self.bill_ids[1]))
            db.commit()
        status, payment = self.repay(self.repayment("1"))
        self.assertEqual(status, 201)
        self.assertEqual(payment["allocations"][0]["sale_id"], min(self.bill_ids))

    def test_fifo_compares_legacy_and_offline_times_on_same_utc_day(self):
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       ("2026-11-01 18:00:00", self.bill_ids[0]))
            db.execute("INSERT INTO offline_sale_times (sale_id, sold_at) VALUES (?, ?)",
                       (self.bill_ids[1], "2026-11-01T17:00:00.001Z"))
            db.commit()
        debt = self.debt()
        self.assertEqual([bill["id"] for bill in debt["bills"]],
                         [self.bill_ids[1], self.bill_ids[0]])
        status, payment = self.repay(self.repayment("1"))
        self.assertEqual(status, 201)
        self.assertEqual(payment["allocations"][0]["sale_id"], self.bill_ids[1])

    def test_fifo_preserves_millisecond_order_before_id_tiebreak(self):
        later, earlier = sorted(self.bill_ids)
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       ("2026-11-01 17:00:00", earlier))
            db.execute("INSERT INTO offline_sale_times (sale_id, sold_at) VALUES (?, ?)",
                       (later, "2026-11-01T17:00:00.001Z"))
            db.commit()
        status, payment = self.repay(self.repayment("1"))
        self.assertEqual(status, 201)
        self.assertEqual(payment["allocations"][0]["sale_id"], earlier)

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
