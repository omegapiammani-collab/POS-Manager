"""Audited, absolute inventory adjustments from physical counts."""
from decimal import Decimal, InvalidOperation, localcontext

from sales import SaleConflict, checkout_number, uuid_field
from stock_shortages import cover_shortages


COUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_counts (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    expected_quantity TEXT NOT NULL,
    counted_quantity TEXT NOT NULL,
    delta TEXT NOT NULL,
    reason TEXT NOT NULL,
    unit_cost TEXT,
    requested_unit_cost TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS counts_by_product ON stock_counts(product_id);
CREATE TABLE IF NOT EXISTS stock_shortage_count_fills (
    sale_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    stock_count_id TEXT NOT NULL REFERENCES stock_counts(id),
    quantity TEXT NOT NULL,
    unit_cost TEXT NOT NULL,
    PRIMARY KEY (sale_id, position, stock_count_id),
    FOREIGN KEY (sale_id, position) REFERENCES stock_shortages(sale_id, position)
);
"""
COUNT_FIELDS = "id, expected_quantity, counted_quantity, delta, reason, unit_cost, created_at"


class CountCostRequired(ValueError):
    pass


def list_counts(db, product_id):
    return [
        dict(row) for row in db.execute(
            f"SELECT {COUNT_FIELDS} FROM stock_counts WHERE product_id = ? ORDER BY rowid DESC",
            (product_id,),
        )
    ]


def expected_quantity(value):
    if not isinstance(value, str) or len(value) > 100:
        raise ValueError("Expected quantity must be the current quantity string")
    try:
        expected = Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid expected quantity") from None
    if not expected.is_finite() or abs(expected) > Decimal("1e30") or expected.as_tuple().exponent < -50:
        raise ValueError("Invalid expected quantity")
    return expected


def record_count(db, product_id, data):
    count_id = uuid_field(data.get("id"), "id")
    expected = expected_quantity(data.get("expected_quantity"))
    counted = checkout_number(data.get("counted_quantity"), "counted_quantity")
    reason = data.get("reason")
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 300:
        raise ValueError("A count reason of 1–300 characters is required")
    reason = reason.strip()
    requested = data.get("unit_cost")
    if requested is not None:
        requested = checkout_number(requested, "unit_cost")

    with db, localcontext() as context:
        context.prec = 50
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            f"SELECT {COUNT_FIELDS}, product_id, requested_unit_cost FROM stock_counts WHERE id = ?",
            (count_id,),
        ).fetchone()
        if existing is not None:
            previous_cost = existing["requested_unit_cost"]
            if (existing["product_id"], Decimal(existing["expected_quantity"]),
                Decimal(existing["counted_quantity"]), existing["reason"],
                Decimal(previous_cost) if previous_cost is not None else None
            ) != (product_id, expected, counted, reason, requested):
                raise SaleConflict("idempotency_conflict", "This stock count ID was already used")
            return False, count_result(db, count_id)

        current, previous_average = db.execute(
            "SELECT quantity, average_cost FROM products WHERE id = ?", (product_id,),
        ).fetchone()
        current = Decimal(current)
        if current != expected:
            raise SaleConflict("stock_changed", "Stock changed after the count form was opened")
        delta = counted - current
        if not delta:
            raise ValueError("Count matches stock and needs no adjustment")

        cost = None
        average = previous_average
        if delta > 0:
            if requested is None and previous_average is None:
                raise CountCostRequired("A unit cost is required when there is no previous average cost")
            cost = requested if requested is not None else Decimal(previous_average)
            if current <= 0:
                average = str(cost)
            else:
                existing_cost = Decimal(previous_average) if previous_average is not None else cost
                average = str((current * existing_cost + delta * cost) / counted)
        elif requested is not None:
            raise ValueError("Unit cost applies only when increasing stock")

        db.execute(
            "INSERT INTO stock_counts (id, product_id, expected_quantity, counted_quantity, delta, "
            "reason, unit_cost, requested_unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (count_id, product_id, str(current), str(counted), str(delta), reason,
             None if cost is None else str(cost), None if requested is None else str(requested)),
        )
        if current < 0:
            cover_shortages(db, product_id, count_id, -current, cost, from_count=True)
        db.execute("UPDATE products SET quantity = ?, average_cost = ? WHERE id = ?",
                   (str(counted), average, product_id))
        return True, count_result(db, count_id)


def count_result(db, count_id):
    return dict(db.execute(f"SELECT {COUNT_FIELDS} FROM stock_counts WHERE id = ?", (count_id,)).fetchone())
