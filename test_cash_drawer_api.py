"""Check drawer reconciliation and its source transactions over HTTP."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from test_store_headers import store_headers
from uuid import uuid4

from inventory import connect
from inventory_api import make_server


DAY = "2026-11-10"
NEXT_DAY = "2026-11-11"


class CashDrawerApiTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "cash-drawer.sqlite3"
        server = make_server(self.database, 0)
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
            return response.status, json.load(response)

    def expect(self, status, path, data=None):
        actual, result = self.request(path, data)
        self.assertEqual(actual, status, result)
        return result

    def drawer(self, date=DAY):
        return self.expect(200, f"/cash-drawer?date={date}")

    @staticmethod
    def payload(date=DAY, **fields):
        return {"id": str(uuid4()), "date": date, **fields}

    def open_drawer(self, amount="100.00", date=DAY):
        return self.expect(201, "/cash-drawer/open", self.payload(date, opening_cash=amount))

    def fixture(self):
        product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.expect(201, f"/products/{product['id']}/receipts", {
            "unit_id": product["base_unit_id"], "quantity": "20", "unit_cost": "4",
        })
        customer = self.expect(201, "/customers", {"name": "ลูกค้าทดสอบ"})
        return product, customer["id"]

    @staticmethod
    def sale(product, customer_id, quantity=1, *, qr=0, credit=0):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": product["id"], "unit_id": product["base_unit_id"],
                "quantity": str(quantity), "expected_unit_price": "10",
            }],
            "payments": {"cash": str(quantity * 10 - qr - credit), "qr": str(qr), "credit": str(credit)},
            "customer_id": customer_id if credit else None,
            "qr_confirmed": bool(qr),
        }

    def sell(self, product, customer_id, timestamp, quantity=1, **payments):
        sale = self.expect(201, "/sales", self.sale(product, customer_id, quantity, **payments))
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?", (timestamp, sale["id"]))
        return sale

    def repay(self, customer_id, timestamp, amount, method):
        repayment = self.expect(201, f"/customers/{customer_id}/repayments", {
            "id": str(uuid4()), "amount": amount, "method": method,
        })
        with closing(connect(self.database)) as db:
            db.execute(
                "UPDATE debt_repayments SET created_at = ? WHERE id = ?", (timestamp, repayment["id"]),
            )

    def expense(self, amount, source="cash_drawer", date=DAY):
        return self.expect(201, "/expenses", self.payload(
            date, description="ค่าใช้จ่ายร้าน", amount=amount, source=source,
        ))

    def test_open_movements_close_snapshot_and_replays(self):
        self.assertEqual(self.drawer()["status"], "unopened")
        self.assertIsNone(self.drawer()["expected_cash"])
        inbound = self.payload(direction="in", amount="20.25", reason="เติมเงินทอน")
        self.expect(409, "/cash-drawer/movements", inbound)

        opening = self.payload(opening_cash="100")
        opened = self.expect(201, "/cash-drawer/open", opening)
        self.assertEqual(opened["status"], "open")
        self.assertEqual(opened["opening_cash"], "100.00")
        self.assertTrue(opened["opened_at"])
        self.assertEqual(self.expect(200, "/cash-drawer/open", opening), opened)
        self.expect(409, "/cash-drawer/open", {**opening, "opening_cash": "101"})

        self.expect(201, "/cash-drawer/movements", inbound)
        outbound = self.payload(direction="out", amount="5.00", reason="นำเงินออก")
        state = self.expect(201, "/cash-drawer/movements", outbound)
        self.assertEqual(state["expected_cash"], "115.25")
        self.assertEqual(state["breakdown"]["added_cash"], "20.25")
        self.assertEqual(state["breakdown"]["withdrawn_cash"], "5.00")
        self.assertEqual(self.expect(200, "/cash-drawer/movements", outbound), state)
        self.expect(409, "/cash-drawer/movements", {**outbound, "reason": "เหตุผลใหม่"})
        movements = {row["id"]: row for row in state["movements"]}
        self.assertEqual(set(movements), {inbound["id"], outbound["id"]})
        for payload in (inbound, outbound):
            saved = movements[payload["id"]]
            self.assertEqual(
                {key: saved[key] for key in ("id", "direction", "amount", "reason")},
                {key: payload[key] for key in ("id", "direction", "amount", "reason")},
            )
            self.assertTrue(saved["created_at"])

        closing = self.payload(actual_cash="114.25", expected_cash="100.00")
        stale = self.expect(409, "/cash-drawer/close", closing)
        self.assertEqual(stale["code"], "drawer_changed")
        self.assertEqual(self.drawer(), state)
        closing["expected_cash"] = "115.25"
        closed = self.expect(201, "/cash-drawer/close", closing)
        self.assertEqual(closed["status"], "closed")
        self.assertTrue(closed["closed_at"])
        self.assertEqual(closed["closed_expected_cash"], "115.25")
        self.assertEqual(closed["actual_cash"], "114.25")
        self.assertEqual(closed["variance"], "-1.00")
        self.assertEqual(closed["late_difference"], "0.00")
        self.assertEqual(self.expect(200, "/cash-drawer/close", closing), closed)
        self.expect(409, "/cash-drawer/close", {**closing, "actual_cash": "115.25"})
        self.expect(409, "/cash-drawer/movements", {**outbound, "id": str(uuid4())})
        self.assertEqual(self.drawer(), closed)

    def test_only_cash_events_on_bangkok_day_affect_expected_cash(self):
        product, customer_id = self.fixture()
        self.open_drawer()
        self.sell(product, customer_id, "2026-11-09T16:59:59.999Z")
        self.sell(product, customer_id, "2026-11-09T17:00:00.000Z", 3, qr=5, credit=15)
        self.sell(product, customer_id, "2026-11-10T16:59:59.999Z", qr=10)
        self.sell(product, customer_id, "2026-11-10T17:00:00.000Z")
        self.repay(customer_id, "2026-11-10T03:00:00.000Z", "4.00", "cash")
        self.repay(customer_id, "2026-11-10T04:00:00.000Z", "5.00", "qr")
        self.expense("2.20")
        self.expense("3.30", source="external")
        self.expense("8.80", date=NEXT_DAY)
        voided = self.expense("9.90")
        self.expect(200, f"/expenses/{voided['id']}/void", {"reason": "บันทึกซ้ำ"})

        state = self.drawer()
        self.assertEqual(state["breakdown"], {
            "sales_cash": "10.00", "sale_corrections_cash": "0.00",
            "repayments_cash": "4.00", "expenses_cash": "2.20", "refunds_cash": "0.00",
            "added_cash": "0.00", "withdrawn_cash": "0.00",
        })
        self.assertEqual(state["expected_cash"], "111.80")

    def test_correction_posts_cash_delta_and_refund_without_counting_replacement_twice(self):
        product, customer_id = self.fixture()
        self.open_drawer(date=DAY)
        self.open_drawer(date=NEXT_DAY)
        original = self.sell(product, customer_id, "2026-11-10T03:00:00.000Z", 3, credit=15)
        self.repay(customer_id, "2026-11-10T04:00:00.000Z", "15", "cash")
        replacement = self.sale(product, customer_id, 3, qr=20, credit=5)
        correction = self.expect(201, f"/sales/{original['id']}/corrections", {
            "id": str(uuid4()), "reason": "แก้วิธีชำระ", "replacement": replacement,
            "excess_action": "refund_cash",
        })
        with closing(connect(self.database)) as db:
            timestamp = "2026-11-10T17:00:00.000Z"
            db.execute("UPDATE sale_corrections SET created_at = ? WHERE id = ?", (timestamp, correction["id"]))
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?", (timestamp, replacement["id"]))

        first = self.drawer(DAY)
        self.assertEqual(first["expected_cash"], "130.00")
        self.assertEqual(first["breakdown"]["sales_cash"], "15.00")
        self.assertEqual(first["breakdown"]["repayments_cash"], "15.00")
        self.assertEqual(first["breakdown"]["sale_corrections_cash"], "0.00")
        self.assertEqual(first["breakdown"]["refunds_cash"], "0.00")

        second = self.drawer(NEXT_DAY)
        self.assertEqual(second["expected_cash"], "80.00")
        self.assertEqual(second["breakdown"]["sales_cash"], "0.00")
        self.assertEqual(second["breakdown"]["sale_corrections_cash"], "-10.00")
        self.assertEqual(second["breakdown"]["refunds_cash"], "10.00")

    def test_late_activity_changes_live_expected_without_rewriting_close(self):
        self.open_drawer()
        self.expense("10")
        closing = self.payload(actual_cash="92", expected_cash="90")
        self.expect(201, "/cash-drawer/close", closing)
        product, customer_id = self.fixture()
        self.sell(product, customer_id, "2026-11-10T03:00:00.000Z")
        self.expense("3.25")

        state = self.drawer()
        self.assertEqual(state["status"], "closed")
        self.assertEqual(state["closed_expected_cash"], "90.00")
        self.assertEqual(state["actual_cash"], "92.00")
        self.assertEqual(state["variance"], "2.00")
        self.assertEqual(state["expected_cash"], "96.75")
        self.assertEqual(state["late_difference"], "6.75")

    def test_concurrent_replay_cannot_double_record_a_movement_or_close(self):
        self.open_drawer()
        movement = self.payload(direction="in", amount="10", reason="เติมเงิน")
        closing = self.payload(actual_cash="110", expected_cash="110")
        for path, payload in (("/cash-drawer/movements", movement), ("/cash-drawer/close", closing)):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: self.request(path, payload), range(2)))
            self.assertEqual(sorted(status for status, _ in results), [200, 201])
            self.assertEqual(results[0][1], results[1][1])
        drawer = self.drawer()
        self.assertEqual(len(drawer["movements"]), 1)
        self.assertEqual(drawer["expected_cash"], "110.00")
        self.assertEqual(drawer["variance"], "0.00")

    def test_invalid_date_or_money_leaves_no_drawer_activity(self):
        self.expect(400, "/cash-drawer?date=2026-02-30")
        self.expect(400, "/cash-drawer/open", self.payload(opening_cash="-1"))
        self.expect(400, "/cash-drawer/open", self.payload(opening_cash="1.001"))
        self.assertEqual(self.drawer()["status"], "unopened")
        opened = self.open_drawer()
        for fields in (
            {"direction": "other"}, {"amount": "0"}, {"amount": "NaN"}, {"reason": "  "},
        ):
            with self.subTest(fields=fields):
                values = {"direction": "in", "amount": "2", "reason": "เติมเงิน", **fields}
                self.expect(400, "/cash-drawer/movements", self.payload(**values))
        self.expect(400, "/cash-drawer/close", self.payload(actual_cash="-1", expected_cash="100"))
        self.assertEqual(self.drawer(), opened)
