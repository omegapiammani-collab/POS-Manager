"""Local checkout and customer credit origination."""
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
from uuid import UUID, uuid4

from inventory import number

SALES_SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    total TEXT NOT NULL,
    cash TEXT NOT NULL,
    qr TEXT NOT NULL,
    credit TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id),
    customer_name TEXT
);
CREATE TABLE IF NOT EXISTS sale_items (
    sale_id TEXT NOT NULL REFERENCES sales(id),
    position INTEGER NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    unit_id TEXT NOT NULL REFERENCES units(id),
    name TEXT NOT NULL,
    unit_name TEXT NOT NULL,
    quantity TEXT NOT NULL,
    unit_price TEXT NOT NULL,
    total TEXT NOT NULL,
    multiplier TEXT NOT NULL,
    base_unit_cost TEXT,
    PRIMARY KEY (sale_id, position)
);
"""
CENT = Decimal("0.01")
PAYMENT_METHODS = ("cash", "qr", "credit")


class SaleConflict(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def customer_list(db):
    return [
        {"id": customer_id, "name": name}
        for customer_id, name in db.execute("SELECT id, name FROM customers ORDER BY name, id")
    ]


def add_customer(db, name):
    customer_id = str(uuid4())
    db.execute("INSERT INTO customers (id, name) VALUES (?, ?)", (customer_id, name))
    return {"id": customer_id, "name": name}


def read_sale(db, sale_id):
    row = db.execute(
        "SELECT id, created_at, total, cash, qr, credit, customer_id, customer_name "
        "FROM sales WHERE id = ?", (sale_id,),
    ).fetchone()
    if row is None:
        return None
    items = db.execute(
        "SELECT name, unit_name, quantity, unit_price, total FROM sale_items "
        "WHERE sale_id = ? ORDER BY position", (sale_id,),
    )
    return {
        "id": row[0],
        "created_at": row[1],
        "total": row[2],
        "items": [
            dict(zip(("name", "unit_name", "quantity", "unit_price", "total"), item))
            for item in items
        ],
        "payments": dict(zip(PAYMENT_METHODS, row[3:6])),
        "customer_id": row[6],
        "customer_name": row[7],
    }


def checkout_number(value, field, *, positive=False, places=6, maximum=Decimal("1000000000")):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError(f"{field} must be a decimal amount")
    amount = number(value, positive=positive)
    if amount > maximum or amount.as_tuple().exponent < -places:
        raise ValueError(f"{field} exceeds the allowed range or precision")
    return amount if amount else Decimal(0)


def uuid_field(value, field):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a UUID")
    try:
        return str(UUID(value))
    except ValueError:
        raise ValueError(f"{field} must be a UUID") from None


def validate_checkout(data):
    sale_id = uuid_field(data.get("id"), "id")
    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("At least one sale item is required")
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            raise ValueError("Each sale item must be an object")
        items.append((
            uuid_field(item.get("product_id"), "product_id"),
            uuid_field(item.get("unit_id"), "unit_id"),
            checkout_number(item.get("quantity"), "quantity", positive=True),
            checkout_number(item.get("expected_unit_price"), "expected_unit_price"),
        ))
    raw_payments = data.get("payments")
    if not isinstance(raw_payments, dict) or set(raw_payments) != set(PAYMENT_METHODS):
        raise ValueError("Cash, QR and credit amounts are required")
    payments = {
        method: checkout_number(raw_payments[method], method, places=2, maximum=Decimal("1e22"))
        for method in PAYMENT_METHODS
    }
    customer_id = data.get("customer_id")
    if customer_id is not None:
        customer_id = uuid_field(customer_id, "customer_id")
    if payments["credit"] > 0 and customer_id is None:
        raise ValueError("A customer is required for credit sales")
    qr_confirmed = data.get("qr_confirmed")
    if not isinstance(qr_confirmed, bool) or (payments["qr"] > 0 and not qr_confirmed):
        raise ValueError("Confirm that the QR transfer was received")
    return sale_id, items, payments, customer_id, qr_confirmed


def checkout_hash(items, payments, customer_id, qr_confirmed):
    def decimal_string(value):
        return format(value.normalize(), "f")

    canonical = {
        "items": [(product_id, unit_id, decimal_string(quantity), decimal_string(price))
                  for product_id, unit_id, quantity, price in items],
        "payments": {method: decimal_string(value) for method, value in payments.items()},
        "customer_id": customer_id,
        "qr_confirmed": qr_confirmed,
    }
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()


def prepare_items(db, items):
    stock = {}
    details = []
    total = Decimal(0)
    for product_id, unit_id, quantity, expected_price in items:
        row = db.execute(
            "SELECT p.name, p.quantity, p.average_cost, u.name, u.multiplier, u.price "
            "FROM products p JOIN units u ON p.id = u.product_id WHERE p.id = ? AND u.id = ?",
            (product_id, unit_id),
        ).fetchone()
        if row is None:
            raise SaleConflict("item_unavailable", "A selected product or unit is unavailable")
        name, available, average_cost, unit_name, multiplier, unit_price = row
        price = Decimal(unit_price)
        if price != expected_price:
            raise SaleConflict("price_changed", "A unit price changed. Refresh the cart")
        remaining = stock.get(product_id, Decimal(available)) - quantity * Decimal(multiplier)
        if remaining < 0:
            raise SaleConflict("insufficient_stock", "A product has insufficient stock")
        stock[product_id] = remaining
        line_total = (quantity * price).quantize(CENT, rounding=ROUND_HALF_UP)
        total += line_total
        details.append((
            product_id, unit_id, name, unit_name, str(quantity), unit_price,
            str(line_total), multiplier, average_cost,
        ))
    return stock, details, total


def checkout(db, data):
    sale_id, items, payments, customer_id, qr_confirmed = validate_checkout(data)
    request_hash = checkout_hash(items, payments, customer_id, qr_confirmed)
    db.execute("BEGIN IMMEDIATE")
    try:
        saved = db.execute("SELECT request_hash FROM sales WHERE id = ?", (sale_id,)).fetchone()
        if saved is not None:
            if saved[0] != request_hash:
                raise SaleConflict("idempotency_conflict", "This sale ID was already used")
            sale = read_sale(db, sale_id)
            db.commit()
            return False, sale

        customer_name = None
        if customer_id is not None:
            customer = db.execute("SELECT name FROM customers WHERE id = ?", (customer_id,)).fetchone()
            if customer is None:
                raise ValueError("The selected customer was not found")
            customer_name = customer[0]

        with localcontext() as context:
            context.prec = 50
            stock, details, total = prepare_items(db, items)
            if sum(payments.values()) != total:
                raise ValueError("Payment amounts must add up to the sale total")
            db.execute(
                "INSERT INTO sales (id, request_hash, total, cash, qr, credit, customer_id, customer_name) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sale_id, request_hash, str(total),
                 *(str(payments[method].quantize(CENT)) for method in PAYMENT_METHODS),
                 customer_id, customer_name),
            )
        db.executemany(
            "INSERT INTO sale_items (sale_id, position, product_id, unit_id, name, unit_name, "
            "quantity, unit_price, total, multiplier, base_unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ((sale_id, position, *detail) for position, detail in enumerate(details)),
        )
        db.executemany(
            "UPDATE products SET quantity = ? WHERE id = ?",
            ((str(remaining), product_id) for product_id, remaining in stock.items()),
        )
        sale = read_sale(db, sale_id)
        db.commit()
        return True, sale
    except Exception:
        db.rollback()
        raise
