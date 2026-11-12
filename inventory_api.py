"""Local HTTP entry point for the POS inventory foundation."""
import argparse
from contextlib import closing
from decimal import Decimal
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit

from inventory import add_product, add_unit, connect, number, receive

MAX_BODY = 8192


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


class InventoryHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, database, **kwargs):
        self.database = database
        super().__init__(*args, **kwargs)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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

        if len(parts) != 3 or parts[0] != "products" or parts[2] not in {"units", "receipts"}:
            raise RequestError(404, "Route not found")
        _, product_id, resource = parts
        check_product(db, product_id)
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
            with closing(connect(self.database)) as db:
                db.row_factory = sqlite3.Row
                status, body = self.dispatch(db, urlsplit(self.path))
        except RequestError as exc:
            status, body = exc.status, {"error": str(exc)}
        except ValueError as exc:
            status, body = 400, {"error": str(exc)}
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
    with closing(connect(database)):
        pass
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
