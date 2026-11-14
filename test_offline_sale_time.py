"""Verify offline occurrence times through the local HTTP API."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
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


DAY = "2025-06-14"
NEXT_DAY = "2025-06-15"
BANGKOK = timezone(timedelta(hours=7))


class OfflineSaleTimeTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "sale-time.sqlite3"
        server = make_server(self.database, 0)
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"
        self.product = self.expect(201, "/products", {
            "code": "W01", "name": "น้ำดื่ม", "base_unit": "ขวด", "price": "10",
        })
        self.expect(201, f"/products/{self.product['id']}/receipts", {
            "unit_id": self.product["base_unit_id"], "quantity": "20", "unit_cost": "4",
        })

    def expect(self, status, path, data=None):
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
            result = json.load(response)
            self.assertEqual(response.status, status, result)
            return result

    def sale(self, quantity=1, **fields):
        return {
            "id": str(uuid4()),
            "items": [{
                "product_id": self.product["id"], "unit_id": self.product["base_unit_id"],
                "quantity": str(quantity), "expected_unit_price": "10",
            }],
            "payments": {"cash": str(quantity * 10), "qr": "0", "credit": "0"},
            "customer_id": None, "qr_confirmed": False,
            **fields,
        }

    def report(self, start=DAY, end=DAY):
        return self.expect(200, f"/sales-report?from={start}&to={end}")

    def drawer(self, day):
        return self.expect(200, f"/cash-drawer?date={day}")

    def open_drawer(self, day):
        self.expect(201, "/cash-drawer/open", {
            "id": str(uuid4()), "date": day, "opening_cash": "100.00",
        })

    def test_timestamp_is_preserved_with_receipt_and_idempotent_retry(self):
        sold_at = "2025-06-14T16:59:59.999Z"
        payload = self.sale(sold_at=sold_at)
        before = datetime.now(timezone.utc) - timedelta(seconds=1)
        created = self.expect(201, "/offline-sales", payload)
        posted = datetime.fromisoformat(created["created_at"].replace("Z", "+00:00"))
        self.assertGreaterEqual(posted, before)
        self.assertLessEqual(posted, datetime.now(timezone.utc))
        self.assertEqual(created["sold_at"], sold_at)
        self.assertEqual(self.expect(200, "/offline-sales", payload), created)

        conflict = self.expect(409, "/offline-sales", {
            **payload, "sold_at": "2025-06-14T17:00:00.000Z",
        })
        self.assertEqual(conflict["code"], "idempotency_conflict")
        self.assertEqual(self.expect(200, f"/sales/{payload['id']}")["sold_at"], sold_at)
        history = self.expect(200, "/sale-history")
        self.assertEqual([row["sold_at"] for row in history], [sold_at])
        self.assertEqual(self.expect(200, "/products")[0]["quantity"], "19")

    def test_invalid_or_online_timestamp_leaves_stock_untouched(self):
        too_far = (datetime.now(timezone.utc) + timedelta(minutes=6)).isoformat(
            timespec="milliseconds",
        ).replace("+00:00", "Z")
        for value in (
            "2025-06-14T16:59:59Z", "2025-06-14T23:59:59.999+07:00",
            "2025-02-30T00:00:00.000Z", "2025-06-14", 1749916800, too_far,
        ):
            with self.subTest(value=value):
                payload = self.sale(sold_at=value)
                self.expect(400, "/offline-sales", payload)
                self.expect(404, f"/sales/{payload['id']}")
        self.expect(400, "/sales", self.sale(sold_at="2025-06-14T16:00:00.000Z"))
        self.assertEqual(self.expect(200, "/products")[0]["quantity"], "20")

    def test_legacy_offline_sale_keeps_posting_date(self):
        payload = self.sale()
        receipt = self.expect(201, "/offline-sales", payload)
        self.assertIsNone(receipt.get("sold_at"))
        self.assertEqual(self.expect(200, "/offline-sales", payload), receipt)
        posted = datetime.fromisoformat(receipt["created_at"].replace("Z", "+00:00"))
        posting_day = posted.astimezone(BANGKOK).date().isoformat()
        self.assertEqual(self.report(posting_day, posting_day)["summary"]["revenue"], "10.00")
        self.assertEqual(self.report()["summary"]["revenue"], "0.00")

    def test_bangkok_cutover_and_late_sale_keep_original_closing_snapshot(self):
        self.open_drawer(DAY)
        self.open_drawer(NEXT_DAY)
        self.expect(201, "/cash-drawer/close", {
            "id": str(uuid4()), "date": DAY, "actual_cash": "101.00", "expected_cash": "100.00",
        })

        self.expect(201, "/offline-sales", self.sale(sold_at="2025-06-14T16:59:59.999Z"))
        self.expect(201, "/offline-sales", self.sale(2, sold_at="2025-06-14T17:00:00.000Z"))
        report = self.report(DAY, NEXT_DAY)
        self.assertEqual(
            [(entry["date"], entry["revenue"]) for entry in report["days"]],
            [(DAY, "10.00"), (NEXT_DAY, "20.00")],
        )

        closed = self.drawer(DAY)
        self.assertEqual(closed["status"], "closed")
        self.assertEqual(closed["closed_expected_cash"], "100.00")
        self.assertEqual(closed["actual_cash"], "101.00")
        self.assertEqual(closed["variance"], "1.00")
        self.assertEqual(closed["expected_cash"], "110.00")
        self.assertEqual(closed["late_difference"], "10.00")
        self.assertEqual(self.drawer(NEXT_DAY)["expected_cash"], "120.00")

    def test_replacement_reports_on_original_day_but_cash_delta_posts_on_correction_day(self):
        self.open_drawer(DAY)
        self.open_drawer(NEXT_DAY)
        original = self.expect(201, "/offline-sales", self.sale(sold_at="2025-06-14T16:59:00.000Z"))
        replacement = self.sale(2)
        correction = self.expect(201, f"/sales/{original['id']}/corrections", {
            "id": str(uuid4()), "reason": "แก้จำนวน", "replacement": replacement,
        })
        correction_time = "2025-06-14T17:00:00.000Z"
        with closing(connect(self.database)) as db:
            db.execute("UPDATE sale_corrections SET created_at = ? WHERE id = ?",
                       (correction_time, correction["id"]))
            db.execute("UPDATE sales SET created_at = ? WHERE id = ?",
                       (correction_time, replacement["id"]))

        self.assertEqual(self.report()["summary"]["revenue"], "20.00")
        self.assertEqual(self.report(NEXT_DAY, NEXT_DAY)["summary"]["revenue"], "0.00")
        self.assertEqual(self.drawer(DAY)["breakdown"]["sales_cash"], "10.00")
        second_day = self.drawer(NEXT_DAY)
        self.assertEqual(second_day["breakdown"]["sales_cash"], "0.00")
        self.assertEqual(second_day["breakdown"]["sale_corrections_cash"], "10.00")
        self.assertEqual(second_day["expected_cash"], "110.00")
