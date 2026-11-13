"""Local HTTP entry point for the POS inventory foundation."""
import argparse
from contextlib import closing
from decimal import Decimal
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from shutil import copyfileobj
import sqlite3
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit

from cash_drawer import DRAWER_ACTIONS, DRAWER_SCHEMA, read_drawer, record_drawer
from database_backup import copy_database
from debts import DEBT_SCHEMA, CustomerNotFound, customer_debt, customer_debt_list, record_repayment
from expenses import EXPENSE_SCHEMA, ExpenseNotFound, list_expenses, record_expense, void_expense
from inventory import add_product, add_unit, connect, number, receive
from payment_qr import PaymentQrUnavailable, payment_qr_svg
from sale_corrections import (
    CORRECTION_SCHEMA, CorrectionConflict, SaleNotFound, correct_sale, sale_history,
)
from sales import SALES_SCHEMA, SaleConflict, add_customer, checkout, customer_list, read_sale, uuid_field
from sales_reports import sales_report
from stock_counts import COUNT_SCHEMA, CountCostRequired, list_counts, record_count
from stock_shortages import list_stock_shortages

MAX_BODY = 8192
WEB_DIR = Path(__file__).resolve().parent / "web"
WEB_ASSETS = {
    "/": ("index.html", "text/html"),
    "/checkout": ("checkout.html", "text/html"),
    "/checkout.js": ("checkout.js", "text/javascript"),
    "/offline-store.js": ("offline-store.js", "text/javascript"),
    "/sw.js": ("sw.js", "text/javascript"),
    "/debts": ("debts.html", "text/html"),
    "/debts.js": ("debts.js", "text/javascript"),
    "/bills": ("bills.html", "text/html"),
    "/bills.js": ("bills.js", "text/javascript"),
    "/reports": ("reports.html", "text/html"),
    "/reports.js": ("reports.js", "text/javascript"),
    "/csv.js": ("csv.js", "text/javascript"),
    "/backup": ("backup.html", "text/html"),
    "/checkout/backup": ("backup.html", "text/html"),
    "/backup.js": ("backup.js", "text/javascript"),
    "/drawer": ("drawer.html", "text/html"),
    "/drawer.js": ("drawer.js", "text/javascript"),
    "/expense-entry": ("expenses.html", "text/html"),
    "/expenses.js": ("expenses.js", "text/javascript"),
    "/inventory.css": ("inventory.css", "text/css"),
    "/inventory.js": ("inventory.js", "text/javascript"),
}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def required_text(data, field):
    value = data.get(field)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 120:
        raise ValueError(f"{field} must contain 1–120 characters")
    return value.strip()


def decimal_field(data, field, *, positive=False, default=None):
    value = number(data.get(field, default), positive=positive)
    if value > Decimal("1000000000") or value.as_tuple().exponent < -6:
        raise ValueError(f"{field} must be at most 1000000000 with up to six decimal places")
    return value


def list_products(db, query):
    products = db.execute("SELECT * FROM products ORDER BY name, code").fetchall()
    units = {}
    for row in db.execute("SELECT * FROM units ORDER BY name"):
        units.setdefault(row["product_id"], []).append(dict(row))
    return [
        {
            **dict(product),
            "units": units.get(product["id"], []),
            "low_stock": Decimal(product["quantity"]) <= Decimal(product["minimum_quantity"]),
        }
        for product in products
        if query in product["name"].casefold() or query in product["code"].casefold()
    ]


def check_product(db, product_id):
    if db.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone() is None:
        raise RequestError(404, "Product not found")


def product_details(data):
    if not isinstance(data, dict):
        raise ValueError("Product details must be an object")
    return (
        required_text(data, "code"), required_text(data, "name"),
        decimal_field(data, "minimum_quantity"),
    )


def edit_product(db, product_id, data):
    desired = product_details(data)
    expected = product_details(data.get("expected"))
    with db:
        db.execute("BEGIN IMMEDIATE")
        check_product(db, product_id)
        row = db.execute(
            "SELECT code, name, minimum_quantity FROM products WHERE id = ?", (product_id,),
        ).fetchone()
        current = (row["code"], row["name"], Decimal(row["minimum_quantity"]))
        if current == desired:
            return {"id": product_id}
        if current != expected:
            raise SaleConflict("product_changed", "Product details changed since they were loaded")
        code, name, minimum = desired
        db.execute(
            "UPDATE products SET code = ?, name = ?, minimum_quantity = ? WHERE id = ?",
            (code, name, str(minimum), product_id),
        )
    return {"id": product_id}


def edit_unit_price(db, product_id, unit_id, data):
    desired = decimal_field(data, "price")
    expected = decimal_field(data, "expected_price")
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT price FROM units WHERE product_id = ? AND id = ?", (product_id, unit_id),
        ).fetchone()
        if row is None:
            raise RequestError(404, "Unit not found")
        current = Decimal(row["price"])
        if current == desired:
            return {"id": unit_id, "price": row["price"]}
        if current != expected:
            raise SaleConflict("price_changed", "Unit price changed since it was loaded")
        db.execute("UPDATE units SET price = ? WHERE id = ?", (str(desired), unit_id))
    return {"id": unit_id, "price": str(desired)}


class InventoryHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, database, **kwargs):
        self.database = database
        super().__init__(*args, **kwargs)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_bytes(status, body, "application/json", "no-store")

    def send_bytes(self, status, body, content_type, cache_control):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(body)

    def serve_asset(self, name, content_type):
        body = (WEB_DIR / name).read_bytes()
        self.send_bytes(200, body, content_type, "no-cache")

    def send_database_backup(self):
        with TemporaryDirectory(prefix="pos-backup-") as directory:
            snapshot = Path(directory) / "pos-backup.sqlite3"
            copy_database(self.database, snapshot)
            with snapshot.open("rb") as stream:
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.sqlite3")
                self.send_header("Content-Disposition", 'attachment; filename="pos-backup.sqlite3"')
                self.send_header("Content-Length", str(snapshot.stat().st_size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                copyfileobj(stream, self.wfile)

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError(400, "Invalid Content-Length") from None
        if length > MAX_BODY:
            raise RequestError(413, "Request body is too large")
        if length <= 0:
            raise RequestError(400, "A JSON object is required")
        try:
            data = json.loads(self.rfile.read(length), parse_float=Decimal)
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Invalid JSON") from None
        if not isinstance(data, dict):
            raise RequestError(400, "A JSON object is required")
        return data

    def dispatch(self, db, route):
        parts = route.path.strip("/").split("/")
        if parts == ["customers"]:
            if self.command == "GET":
                return 200, customer_list(db)
            return 201, add_customer(db, required_text(self.read_json(), "name"))

        if parts == ["customer-debts"] and self.command == "GET":
            return 200, customer_debt_list(db)

        if len(parts) == 3 and parts[0] == "customers":
            if parts[2] == "debt" and self.command == "GET":
                return 200, customer_debt(db, uuid_field(parts[1], "customer_id"))
            if parts[2] == "repayments" and self.command == "POST":
                customer_id = uuid_field(parts[1], "customer_id")
                created, repayment = record_repayment(db, customer_id, self.read_json())
                return (201 if created else 200), repayment

        if parts == ["cash-drawer"] and self.command == "GET":
            dates = parse_qs(route.query)
            return 200, read_drawer(db, dates.get("date", [""])[0])
        if len(parts) == 2 and parts[0] == "cash-drawer" and self.command == "POST":
            if parts[1] not in DRAWER_ACTIONS:
                raise RequestError(404, "Drawer action not found")
            created, drawer = record_drawer(db, parts[1], self.read_json())
            return (201 if created else 200), drawer

        if parts == ["expenses"]:
            if self.command == "GET":
                dates = parse_qs(route.query)
                return 200, list_expenses(db, dates.get("from", [""])[0], dates.get("to", [""])[0])
            created, expense = record_expense(db, self.read_json())
            return (201 if created else 200), expense

        if len(parts) == 3 and parts[0] == "expenses" and parts[2] == "void" and self.command == "POST":
            return 200, void_expense(db, uuid_field(parts[1], "id"), self.read_json())

        if parts == ["sales-report"] and self.command == "GET":
            dates = parse_qs(route.query)
            return 200, sales_report(db, dates.get("from", [""])[0], dates.get("to", [""])[0])

        if parts == ["sale-history"] and self.command == "GET":
            return 200, sale_history(db)

        if len(parts) == 3 and parts[0] == "sales" and parts[2] == "corrections" and self.command == "POST":
            sale_id = uuid_field(parts[1], "id")
            created, correction = correct_sale(db, sale_id, self.read_json())
            return (201 if created else 200), correction

        if parts == ["stock-shortages"] and self.command == "GET":
            return 200, list_stock_shortages(db)

        if parts in (["sales"], ["offline-sales"]) and self.command == "POST":
            created, sale = checkout(db, self.read_json(), allow_negative=parts == ["offline-sales"])
            return (201 if created else 200), sale

        if len(parts) == 2 and parts[0] == "sales" and self.command == "GET":
            with db:
                db.execute("BEGIN")
                sale = read_sale(db, uuid_field(parts[1], "id"))
            if sale is None:
                raise RequestError(404, "Sale not found")
            return 200, sale

        if parts == ["products"]:
            if self.command == "GET":
                query = parse_qs(route.query).get("q", [""])[0].strip().casefold()
                return 200, list_products(db, query)
            data = self.read_json()
            product_id, unit_id = add_product(
                db, required_text(data, "code"), required_text(data, "name"),
                required_text(data, "base_unit"), decimal_field(data, "price"),
                decimal_field(data, "minimum_quantity", default=0),
            )
            return 201, {"id": product_id, "base_unit_id": unit_id}

        if parts[0] == "products" and self.command == "POST":
            if len(parts) == 3 and parts[2] == "edit":
                return 200, edit_product(db, parts[1], self.read_json())
            if len(parts) == 5 and parts[2] == "units" and parts[4] == "price":
                return 200, edit_unit_price(db, parts[1], parts[3], self.read_json())

        if len(parts) != 3 or parts[0] != "products" or parts[2] not in {"units", "receipts", "stock-counts"}:
            raise RequestError(404, "Route not found")
        _, product_id, resource = parts
        check_product(db, product_id)
        if resource == "stock-counts":
            if self.command == "GET":
                return 200, list_counts(db, product_id)
            created, count = record_count(db, product_id, self.read_json())
            return (201 if created else 200), count
        if self.command == "GET":
            if resource != "receipts":
                raise RequestError(405, "Use GET /products to list units")
            rows = db.execute(
                "SELECT receipts.*, units.name AS unit_name FROM receipts "
                "JOIN units ON units.id = receipts.unit_id WHERE receipts.product_id = ? "
                "ORDER BY receipts.created_at DESC, receipts.rowid DESC", (product_id,),
            )
            return 200, [dict(row) for row in rows]

        data = self.read_json()
        if resource == "units":
            unit_id = add_unit(
                db, product_id, required_text(data, "name"),
                decimal_field(data, "multiplier", positive=True), decimal_field(data, "price"),
            )
            return 201, {"id": unit_id}
        receipt_id = receive(
            db, product_id, required_text(data, "unit_id"),
            decimal_field(data, "quantity", positive=True), decimal_field(data, "unit_cost"),
        )
        return 201, {"id": receipt_id}

    def handle_request(self):
        try:
            port = self.server.server_port
            if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
                raise RequestError(403, "Use the local server address")
            route = urlsplit(self.path)
            if self.command == "GET" and route.path == "/database-backup":
                return self.send_database_backup()
            if self.command == "GET" and route.path in WEB_ASSETS:
                return self.serve_asset(*WEB_ASSETS[route.path])
            if self.command == "GET" and route.path == "/payment-qr":
                amount = parse_qs(route.query).get("amount", [""])[0]
                return self.send_bytes(200, payment_qr_svg(amount), "image/svg+xml", "no-store")
            with closing(connect(self.database)) as db:
                db.row_factory = sqlite3.Row
                status, body = self.dispatch(db, route)
        except PaymentQrUnavailable as exc:
            status, body = 503, {"error": str(exc)}
        except (CustomerNotFound, SaleNotFound) as exc:
            status, body = 404, {"error": str(exc)}
        except RequestError as exc:
            status, body = exc.status, {"error": str(exc)}
        except CountCostRequired as exc:
            status, body = 400, {"code": "stock_count_cost_required", "error": str(exc)}
        except ValueError as exc:
            status, body = 400, {"error": str(exc)}
        except CorrectionConflict as exc:
            status, body = 409, {"error": str(exc), "code": exc.code, "excess": exc.excess}
        except SaleConflict as exc:
            status, body = 409, {"error": str(exc), "code": exc.code}
        except sqlite3.IntegrityError:
            status, body = 409, {"error": "Product code or unit name already exists"}
        except sqlite3.Error as exc:
            self.log_error("Database error: %s", exc)
            status, body = 503, {"error": "Inventory database unavailable"}
        self.send_json(status, body)

    do_GET = handle_request
    do_POST = handle_request


def make_server(database, port):
    # Initialize the file before accepting requests.
    with closing(connect(database)) as db:
        db.executescript(SALES_SCHEMA)
        db.executescript(DEBT_SCHEMA)
        db.executescript(CORRECTION_SCHEMA)
        db.executescript(COUNT_SCHEMA)
        db.executescript(EXPENSE_SCHEMA)
        db.executescript(DRAWER_SCHEMA)
    handler = partial(InventoryHandler, database=database)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path("inventory.sqlite3"))
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    with make_server(args.database, args.port) as server:
        print(f"Inventory API: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
