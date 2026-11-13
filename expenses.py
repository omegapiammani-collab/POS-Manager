"""Store expenses and their payment sources for Bangkok business dates."""
from datetime import date
from decimal import Decimal
import re

from sales import SaleConflict, checkout_number, uuid_field

EXPENSE_SCHEMA = """
CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('cash_drawer', 'external')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    void_reason TEXT,
    voided_at TEXT
);
CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(date);
"""
EXPENSE_FIELDS = """
id, date, description, amount, source, created_at, void_reason, voided_at,
CASE WHEN voided_at IS NULL THEN 'active' ELSE 'voided' END AS status
"""


class ExpenseNotFound(Exception):
    pass


def business_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("Use YYYY-MM-DD dates")
    return date.fromisoformat(value)


def validate_date_range(start, end):
    if business_date(start) > business_date(end):
        raise ValueError("Start date must be on or before end date")


def expense_text(value, field):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 300:
        raise ValueError(f"{field} must contain 1–300 characters")
    return value.strip()


def list_expenses(db, start, end):
    validate_date_range(start, end)
    return [
        dict(row) for row in db.execute(
            f"SELECT {EXPENSE_FIELDS} FROM expenses WHERE date BETWEEN ? AND ? "
            "ORDER BY date DESC, rowid DESC", (start, end),
        )
    ]


def read_expense(db, expense_id):
    row = db.execute(f"SELECT {EXPENSE_FIELDS} FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if row is None:
        raise ExpenseNotFound("Expense not found")
    return dict(row)


def record_expense(db, data):
    expense_id = uuid_field(data.get("id"), "id")
    day = business_date(data.get("date")).isoformat()
    description = expense_text(data.get("description"), "description")
    amount = format(checkout_number(data.get("amount"), "amount", positive=True, places=2), ".2f")
    source = data.get("source")
    if source not in ("cash_drawer", "external"):
        raise ValueError("Expense source must be cash_drawer or external")
    details = (day, description, amount, source)
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT date, description, amount, source FROM expenses WHERE id = ?", (expense_id,),
        ).fetchone()
        if existing is not None:
            if tuple(existing) != details:
                raise SaleConflict("idempotency_conflict", "This expense ID was already used")
            return False, read_expense(db, expense_id)
        db.execute(
            "INSERT INTO expenses (id, date, description, amount, source) VALUES (?, ?, ?, ?, ?)",
            (expense_id, *details),
        )
        return True, read_expense(db, expense_id)


def void_expense(db, expense_id, data):
    reason = expense_text(data.get("reason"), "reason")
    with db:
        db.execute("BEGIN IMMEDIATE")
        expense = read_expense(db, expense_id)
        if expense["status"] == "voided":
            if expense["void_reason"] != reason:
                raise SaleConflict("expense_already_voided", "This expense is already voided")
            return expense
        db.execute(
            "UPDATE expenses SET void_reason = ?, voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE id = ?", (reason, expense_id),
        )
        return read_expense(db, expense_id)


def active_expenses(db, start, end):
    for day, amount, source in db.execute(
        "SELECT date, amount, source FROM expenses WHERE date BETWEEN ? AND ? "
        "AND voided_at IS NULL", (start, end),
    ):
        yield day, Decimal(amount), source
