"""Audited owner-supplied cost for positive stock with unknown average."""
from decimal import Decimal
import re

from inventory import bump_stock_revision
from sales import SaleConflict, checkout_number, require_store, uuid_field
from stock_counts import expected_quantity


def record_cost_baseline(db, product_id, data, *, expected_store):
    request_id = uuid_field(data.get("id"), "id")
    product_id = uuid_field(product_id, "product_id")
    quantity = expected_quantity(data.get("expected_quantity"))
    version_text = data.get("expected_version")
    if not isinstance(version_text, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", version_text):
        raise ValueError("Invalid stock version")
    version = int(version_text)
    if version > 9223372036854775806:
        raise ValueError("Invalid stock version")
    cost = checkout_number(data.get("unit_cost"), "unit_cost")
    reason = data.get("reason")
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 300:
        raise ValueError("A reason of 1–300 characters is required")
    reason = reason.strip()

    with db:
        db.execute("BEGIN IMMEDIATE")
        require_store(db, expected_store)
        existing = db.execute(
            "SELECT product_id, expected_quantity, expected_version, unit_cost, reason FROM cost_baselines WHERE id = ?",
            (request_id,),
        ).fetchone()
        if existing is not None:
            if (existing[0], Decimal(existing[1]), existing[2], Decimal(existing[3]), existing[4]) != (product_id, quantity, version, cost, reason):
                raise SaleConflict("idempotency_conflict", "Cost baseline ID already used")
            return False, {"id": request_id}
        current = db.execute(
            "SELECT p.quantity, p.average_cost, COALESCE(r.version, 0) "
            "FROM products p LEFT JOIN stock_revisions r ON r.product_id = p.id WHERE p.id = ?", (product_id,),
        ).fetchone()
        if current is None:
            raise SaleConflict("item_unavailable", "Product not found")
        if Decimal(current[0]) != quantity or current[2] != version:
            raise SaleConflict("stock_changed", "Stock changed since the form was opened")
        if quantity <= 0 or current[1] is not None:
            raise SaleConflict("cost_not_unknown", "Cost can be set only for positive stock with unknown cost")
        db.execute(
            "INSERT INTO cost_baselines (id, product_id, expected_quantity, expected_version, unit_cost, reason) VALUES (?, ?, ?, ?, ?, ?)",
            (request_id, product_id, str(quantity), version, str(cost), reason),
        )
        db.execute("UPDATE products SET average_cost = ? WHERE id = ?", (str(cost), product_id))
        bump_stock_revision(db, product_id)
        return True, {"id": request_id}
