"""Customer balances and FIFO repayment allocation."""
from collections import defaultdict
from decimal import Decimal

from sales import SaleConflict, checkout_number, uuid_field

DEBT_SCHEMA = """
CREATE TABLE IF NOT EXISTS debt_repayments (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    amount TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('cash', 'qr')),
    note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS debt_allocations (
    repayment_id TEXT NOT NULL REFERENCES debt_repayments(id),
    sale_id TEXT NOT NULL REFERENCES sales(id),
    amount TEXT NOT NULL,
    PRIMARY KEY (repayment_id, sale_id)
);
CREATE INDEX IF NOT EXISTS sales_by_customer_date ON sales (customer_id, created_at, id);
CREATE INDEX IF NOT EXISTS repayments_by_customer_date
    ON debt_repayments (customer_id, created_at, id);
CREATE INDEX IF NOT EXISTS allocations_by_sale ON debt_allocations (sale_id);
"""


class CustomerNotFound(Exception):
    pass


def satang(value):
    return int(Decimal(value) * 100)


def baht(value):
    whole, fraction = divmod(abs(value), 100)
    sign = "-" if value < 0 else ""
    return f"{sign}{whole}.{fraction:02d}"


def require_customer(db, customer_id):
    row = db.execute("SELECT name FROM customers WHERE id = ?", (customer_id,)).fetchone()
    if row is None:
        raise CustomerNotFound("Customer not found")
    return row[0]


def bill_balances(db, customer_id):
    paid = defaultdict(int)
    for sale_id, amount in db.execute(
        "SELECT a.sale_id, a.amount FROM debt_allocations a "
        "JOIN sales s ON s.id = a.sale_id WHERE s.customer_id = ?",
        (customer_id,),
    ):
        paid[sale_id] += satang(amount)

    bills = []
    for sale_id, created_at, credit in db.execute(
        "SELECT s.id, s.created_at, s.credit FROM sales s "
        "WHERE s.customer_id = ? "
        "AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.sale_id = s.id) "
        "ORDER BY s.created_at, s.id",
        (customer_id,),
    ):
        credit = satang(credit)
        if credit > 0:
            bills.append((sale_id, created_at, credit, paid[sale_id]))
    return bills


def serialize_repayment(row, allocations):
    repayment_id, created_at, amount, method, note = row
    return {
        "id": repayment_id,
        "created_at": created_at,
        "amount": amount,
        "method": method,
        "note": note,
        "allocations": allocations,
    }


def repayment_allocations(db, customer_id):
    allocations = defaultdict(list)
    for repayment_id, sale_id, amount in db.execute(
        "SELECT a.repayment_id, a.sale_id, a.amount FROM debt_allocations a "
        "JOIN debt_repayments r ON r.id = a.repayment_id "
        "JOIN sales s ON s.id = a.sale_id "
        "WHERE r.customer_id = ? ORDER BY s.created_at, s.id",
        (customer_id,),
    ):
        allocations[repayment_id].append({"sale_id": sale_id, "amount": amount})
    return allocations


def customer_debt_list(db):
    with db:
        db.execute("BEGIN")
        customers = db.execute("SELECT id, name FROM customers ORDER BY name, id").fetchall()
        outstanding = defaultdict(int)
        for customer_id, credit in db.execute(
            "SELECT s.customer_id, s.credit FROM sales s WHERE s.customer_id IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.sale_id = s.id)",
        ):
            outstanding[customer_id] += satang(credit)
        for customer_id, amount in db.execute(
            "SELECT s.customer_id, a.amount FROM debt_allocations a "
            "JOIN sales s ON s.id = a.sale_id "
            "WHERE NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.sale_id = s.id)",
        ):
            outstanding[customer_id] -= satang(amount)
    return [
        {"id": customer_id, "name": name, "outstanding": baht(outstanding[customer_id])}
        for customer_id, name in customers
    ]


def customer_debt(db, customer_id):
    with db:
        db.execute("BEGIN")
        name = require_customer(db, customer_id)
        bills = bill_balances(db, customer_id)
        allocations = repayment_allocations(db, customer_id)
        repayments = [
            serialize_repayment(row, allocations[row[0]])
            for row in db.execute(
                "SELECT id, created_at, amount, method, note FROM debt_repayments "
                "WHERE customer_id = ? ORDER BY created_at DESC, id DESC",
                (customer_id,),
            )
        ]
    return {
        "id": customer_id,
        "name": name,
        "outstanding": baht(sum(credit - paid for _, _, credit, paid in bills)),
        "bills": [
            {
                "id": sale_id,
                "created_at": created_at,
                "credit": baht(credit),
                "paid": baht(paid),
                "outstanding": baht(credit - paid),
            }
            for sale_id, created_at, credit, paid in bills
        ],
        "repayments": repayments,
    }


def repayment_data(data):
    repayment_id = uuid_field(data.get("id"), "id")
    if not isinstance(data.get("amount"), str):
        raise ValueError("amount must be a decimal string")
    amount = checkout_number(
        data["amount"], "amount", positive=True, places=2, maximum=Decimal("1e22"),
    )
    method = data.get("method")
    if method not in ("cash", "qr"):
        raise ValueError("Repayment method must be cash or qr")
    note = data.get("note", "")
    if not isinstance(note, str) or len(note.strip()) > 300:
        raise ValueError("note must contain at most 300 characters")
    return repayment_id, satang(amount), method, note.strip()


def read_repayment(db, repayment_id):
    row = db.execute(
        "SELECT id, created_at, amount, method, note FROM debt_repayments WHERE id = ?",
        (repayment_id,),
    ).fetchone()
    allocations = [
        {"sale_id": sale_id, "amount": amount}
        for sale_id, amount in db.execute(
            "SELECT a.sale_id, a.amount FROM debt_allocations a "
            "JOIN sales s ON s.id = a.sale_id WHERE a.repayment_id = ? ORDER BY s.created_at, s.id",
            (repayment_id,),
        )
    ]
    return serialize_repayment(row, allocations)


def record_repayment(db, customer_id, data):
    repayment_id, amount, method, note = repayment_data(data)
    payment = (customer_id, baht(amount), method, note)
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT customer_id, amount, method, note FROM debt_repayments WHERE id = ?",
            (repayment_id,),
        ).fetchone()
        if existing is not None:
            if tuple(existing) != payment:
                raise SaleConflict("idempotency_conflict", "This repayment ID was already used")
            return False, read_repayment(db, repayment_id)

        require_customer(db, customer_id)
        remaining = amount
        allocations = []
        for sale_id, _, credit, paid in bill_balances(db, customer_id):
            applied = min(remaining, credit - paid)
            if applied > 0:
                allocations.append((repayment_id, sale_id, baht(applied)))
                remaining -= applied
            if remaining == 0:
                break
        if remaining:
            raise SaleConflict("overpayment", "Repayment exceeds the outstanding balance")

        db.execute(
            "INSERT INTO debt_repayments (id, customer_id, amount, method, note) VALUES (?, ?, ?, ?, ?)",
            (repayment_id, *payment),
        )
        db.executemany(
            "INSERT INTO debt_allocations (repayment_id, sale_id, amount) VALUES (?, ?, ?)",
            allocations,
        )
        return True, read_repayment(db, repayment_id)
