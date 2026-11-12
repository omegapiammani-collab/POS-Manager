"""Track a daily cash drawer and reconcile its balance against POS activity."""
from decimal import Decimal, InvalidOperation

from debts import baht, satang
from expenses import business_date, expense_text
from sales import SaleConflict, checkout_number, uuid_field


DRAWER_SCHEMA = """
CREATE TABLE IF NOT EXISTS cash_drawers (
    date TEXT PRIMARY KEY,
    open_id TEXT NOT NULL UNIQUE,
    opening_cash TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    close_id TEXT UNIQUE,
    actual_cash TEXT,
    closed_expected_cash TEXT,
    closed_at TEXT
);
CREATE TABLE IF NOT EXISTS drawer_movements (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL REFERENCES cash_drawers(date),
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    amount TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS drawer_movements_by_date ON drawer_movements(date);
"""

CASH_SALES = """
SELECT cash FROM sales s
WHERE date(s.created_at, '+7 hours') = ?
  AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.replacement_id = s.id)
"""

CASH_CORRECTIONS = """
SELECT original.cash, replacement.cash, c.excess, c.excess_action
FROM sale_corrections c JOIN sales original ON original.id = c.sale_id
LEFT JOIN sales replacement ON replacement.id = c.replacement_id
WHERE date(c.created_at, '+7 hours') = ?
"""


def movements(db, day):
    return [dict(row) for row in db.execute(
        "SELECT id, direction, amount, reason, created_at FROM drawer_movements "
        "WHERE date = ? ORDER BY rowid", (day,),
    )]


def cash_breakdown(db, day, entries):
    sales_cash = sum(satang(row[0]) for row in db.execute(CASH_SALES, (day,)))
    correction_cash = refunds_cash = 0
    for original, replacement, excess, action in db.execute(CASH_CORRECTIONS, (day,)):
        correction_cash += satang(replacement or "0") - satang(original)
        if action == "refund_cash":
            refunds_cash += satang(excess)
    repayments_cash = sum(satang(row[0]) for row in db.execute(
        "SELECT amount FROM debt_repayments WHERE method = 'cash' "
        "AND date(created_at, '+7 hours') = ?", (day,),
    ))
    expenses_cash = sum(satang(row[0]) for row in db.execute(
        "SELECT amount FROM expenses WHERE date = ? AND source = 'cash_drawer' "
        "AND voided_at IS NULL", (day,),
    ))
    return {
        "sales_cash": sales_cash, "sale_corrections_cash": correction_cash,
        "repayments_cash": repayments_cash, "expenses_cash": expenses_cash,
        "refunds_cash": refunds_cash,
        "added_cash": sum(satang(row["amount"]) for row in entries if row["direction"] == "in"),
        "withdrawn_cash": sum(satang(row["amount"]) for row in entries if row["direction"] == "out"),
    }


def drawer_state(db, day):
    row = db.execute("SELECT * FROM cash_drawers WHERE date = ?", (day,)).fetchone()
    entries = movements(db, day)
    breakdown = cash_breakdown(db, day, entries)
    expected = None
    if row is not None:
        expected = (
            satang(row["opening_cash"]) + breakdown["sales_cash"] + breakdown["sale_corrections_cash"]
            + breakdown["repayments_cash"] + breakdown["added_cash"]
            - breakdown["expenses_cash"] - breakdown["refunds_cash"] - breakdown["withdrawn_cash"]
        )
    closed = row is not None and row["closed_at"] is not None
    return {
        "date": day,
        "status": "unopened" if row is None else "closed" if closed else "open",
        **{key: row[key] if row is not None else None for key in (
            "opening_cash", "opened_at", "closed_at", "actual_cash", "closed_expected_cash",
        )},
        "expected_cash": None if expected is None else baht(expected),
        "variance": baht(satang(row["actual_cash"]) - satang(row["closed_expected_cash"])) if closed else None,
        "late_difference": baht(expected - satang(row["closed_expected_cash"])) if closed else None,
        "breakdown": {key: baht(amount) for key, amount in breakdown.items()},
        "movements": entries,
    }


def read_drawer(db, day):
    business_date(day)
    with db:
        db.execute("BEGIN")
        return drawer_state(db, day)


def ensure_open(db, day):
    row = db.execute("SELECT closed_at FROM cash_drawers WHERE date = ?", (day,)).fetchone()
    if row is None:
        raise SaleConflict("drawer_not_open", "Open the cash drawer first")
    if row["closed_at"] is not None:
        raise SaleConflict("drawer_already_closed", "This cash drawer is already closed")


def drawer_amount(value, field, *, positive=False):
    return format(checkout_number(value, field, positive=positive, places=2), ".2f")


def signed_expected(value):
    if not isinstance(value, str) or len(value) > 60:
        raise ValueError("Expected cash must be the displayed amount")
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid expected cash") from None
    if not amount.is_finite() or amount.as_tuple().exponent < -2 or amount.copy_abs() > Decimal("1e25"):
        raise ValueError("Invalid expected cash")
    return baht(satang(amount))


def open_drawer(db, day, request_id, data):
    amount = drawer_amount(data.get("opening_cash"), "opening_cash")
    existing = db.execute("SELECT date, opening_cash FROM cash_drawers WHERE open_id = ?", (request_id,)).fetchone()
    if existing is not None:
        if tuple(existing) != (day, amount):
            raise SaleConflict("idempotency_conflict", "This drawer opening ID was already used")
        return False
    if db.execute("SELECT 1 FROM cash_drawers WHERE date = ?", (day,)).fetchone():
        raise SaleConflict("drawer_already_opened", "This day already has a cash drawer")
    db.execute("INSERT INTO cash_drawers (date, open_id, opening_cash) VALUES (?, ?, ?)", (day, request_id, amount))
    return True


def add_movement(db, day, request_id, data):
    amount = drawer_amount(data.get("amount"), "amount", positive=True)
    direction = data.get("direction")
    if direction not in ("in", "out"):
        raise ValueError("Movement direction must be in or out")
    reason = expense_text(data.get("reason"), "reason")
    existing = db.execute(
        "SELECT date, direction, amount, reason FROM drawer_movements WHERE id = ?", (request_id,),
    ).fetchone()
    details = (day, direction, amount, reason)
    if existing is not None:
        if tuple(existing) != details:
            raise SaleConflict("idempotency_conflict", "This drawer movement ID was already used")
        return False
    ensure_open(db, day)
    db.execute(
        "INSERT INTO drawer_movements (id, date, direction, amount, reason) VALUES (?, ?, ?, ?, ?)",
        (request_id, *details),
    )
    return True


def close_drawer(db, day, request_id, data):
    actual = drawer_amount(data.get("actual_cash"), "actual_cash")
    expected = signed_expected(data.get("expected_cash"))
    existing = db.execute(
        "SELECT date, actual_cash, closed_expected_cash FROM cash_drawers WHERE close_id = ?", (request_id,),
    ).fetchone()
    if existing is not None:
        if tuple(existing) != (day, actual, expected):
            raise SaleConflict("idempotency_conflict", "This drawer closing ID was already used")
        return False
    ensure_open(db, day)
    if drawer_state(db, day)["expected_cash"] != expected:
        raise SaleConflict("drawer_changed", "Cash activity changed after the drawer was reviewed")
    db.execute(
        "UPDATE cash_drawers SET close_id = ?, actual_cash = ?, closed_expected_cash = ?, "
        "closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE date = ?",
        (request_id, actual, expected, day),
    )
    return True


DRAWER_ACTIONS = {"open": open_drawer, "movements": add_movement, "close": close_drawer}


def record_drawer(db, action, data):
    day = business_date(data.get("date")).isoformat()
    request_id = uuid_field(data.get("id"), "id")
    with db:
        db.execute("BEGIN IMMEDIATE")
        created = DRAWER_ACTIONS[action](db, day, request_id, data)
        return created, drawer_state(db, day)
