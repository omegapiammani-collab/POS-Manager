"""Quantities sold before stock was available and the receipts that cover them."""
from decimal import Decimal

SHORTAGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_shortages (
    sale_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity TEXT NOT NULL,
    remaining TEXT NOT NULL,
    PRIMARY KEY (sale_id, position),
    FOREIGN KEY (sale_id, position) REFERENCES sale_items(sale_id, position)
);
CREATE INDEX IF NOT EXISTS shortages_by_product ON stock_shortages(product_id);
CREATE TABLE IF NOT EXISTS stock_shortage_fills (
    sale_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    quantity TEXT NOT NULL,
    unit_cost TEXT NOT NULL,
    PRIMARY KEY (sale_id, position, receipt_id),
    FOREIGN KEY (sale_id, position) REFERENCES stock_shortages(sale_id, position)
);
"""


def cover_shortages(db, product_id, receipt_id, quantity, unit_cost):
    rows = db.execute(
        "SELECT q.sale_id, q.position, q.remaining FROM stock_shortages q "
        "JOIN sales s ON s.id = q.sale_id WHERE q.product_id = ? "
        "ORDER BY s.rowid, q.position", (product_id,),
    ).fetchall()
    for sale_id, position, remaining in rows:
        remaining = Decimal(remaining)
        applied = min(remaining, quantity)
        if not applied:
            continue
        db.execute(
            "INSERT INTO stock_shortage_fills VALUES (?, ?, ?, ?, ?)",
            (sale_id, position, receipt_id, str(applied), str(unit_cost)),
        )
        db.execute(
            "UPDATE stock_shortages SET remaining = ? WHERE sale_id = ? AND position = ?",
            (str(remaining - applied), sale_id, position),
        )
        quantity -= applied
        if not quantity:
            return
    raise RuntimeError("Negative stock does not match its outstanding shortages")


def sale_shortages(db, sale_id):
    rows = db.execute(
        "SELECT q.position, q.product_id, q.quantity, q.remaining, i.base_unit_cost "
        "FROM stock_shortages q JOIN sale_items i USING (sale_id, position) "
        "WHERE q.sale_id = ? ORDER BY q.position", (sale_id,),
    )
    return [
        {
            "position": position, "product_id": product_id,
            "quantity": quantity, "remaining": remaining,
            "provisional_unit_cost": cost,
            "fills": [
                {"receipt_id": receipt_id, "quantity": applied, "unit_cost": unit_cost}
                for receipt_id, applied, unit_cost in db.execute(
                    "SELECT f.receipt_id, f.quantity, f.unit_cost FROM stock_shortage_fills f "
                    "JOIN receipts r ON r.id = f.receipt_id "
                    "WHERE f.sale_id = ? AND f.position = ? ORDER BY r.rowid",
                    (sale_id, position),
                )
            ],
        }
        for position, product_id, quantity, remaining, cost in rows
    ]


def list_stock_shortages(db):
    rows = db.execute(
        "SELECT q.sale_id, q.product_id, p.name, p.base_unit, q.quantity, q.remaining, i.base_unit_cost "
        "FROM stock_shortages q JOIN sale_items i USING (sale_id, position) "
        "JOIN sales s ON s.id = q.sale_id JOIN products p ON p.id = q.product_id "
        "ORDER BY s.rowid, q.position",
    )
    keys = ("sale_id", "product_id", "name", "base_unit", "quantity", "remaining", "provisional_unit_cost")
    return [dict(zip(keys, row)) for row in rows if Decimal(row[5]) > 0]
