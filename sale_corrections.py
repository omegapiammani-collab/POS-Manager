"""Audit and apply atomic replacements or voids of completed sales."""
from collections import defaultdict, deque
from decimal import Decimal, localcontext
import hashlib
import json

from debts import baht, bill_balances, satang
from sales import (
    SaleConflict, checkout_hash, checkout_in_transaction, checkout_number, read_sale, uuid_field, validate_checkout,
)

from stock_shortages import sale_shortages

CORRECTION_SCHEMA = """
CREATE TABLE IF NOT EXISTS sale_corrections (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id),
    replacement_id TEXT UNIQUE REFERENCES sales(id),
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    reason TEXT NOT NULL,
    excess TEXT NOT NULL,
    excess_action TEXT CHECK (excess_action IN ('refund_cash', 'refund_qr', 'apply')),
    previous_allocations TEXT NOT NULL,
    allocation_changes TEXT NOT NULL
);
"""


class SaleNotFound(Exception):
    pass


class CorrectionConflict(SaleConflict):
    def __init__(self, code, message, excess):
        super().__init__(code, message)
        self.excess = baht(excess)


def sale_history(db):
    with db:
        db.execute("BEGIN")
        return [
            {
                **read_sale(db, sale_id, include_item_ids=True),
                "status": "voided" if reason is not None else "active",
                "replacement_id": replacement_id,
                "correction_reason": reason,
                "correction_excess": excess,
                "correction_excess_action": action,
            }
            for sale_id, replacement_id, reason, excess, action in db.execute(
                "SELECT s.id, c.replacement_id, c.reason, c.excess, c.excess_action "
                "FROM sales s LEFT JOIN sale_corrections c ON c.sale_id = s.id "
                "ORDER BY s.created_at DESC, s.id DESC",
            )
        ]


def correction_input(data, sale_id):
    correction_id = uuid_field(data.get("id"), "id")
    reason = data.get("reason")
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 300:
        raise ValueError("A correction reason of 1–300 characters is required")
    reason = reason.strip()
    action = data.get("excess_action")
    if action not in (None, "refund_cash", "refund_qr", "apply"):
        raise ValueError("Invalid excess action")
    expected_excess = data.get("expected_excess")
    if expected_excess is not None:
        expected_excess = satang(checkout_number(
            expected_excess, "expected_excess", places=2, maximum=Decimal("1e22"),
        ))
    replacement = data.get("replacement")
    replacement_input = None
    replacement_signature = None
    if replacement is not None:
        if not isinstance(replacement, dict):
            raise ValueError("Replacement must be a checkout object")
        replacement_input = validate_checkout(replacement)
        replacement_signature = (replacement_input[0], checkout_hash(*replacement_input[1:]))
    signature = hashlib.sha256(json.dumps(
        (sale_id, reason, replacement_signature, action, expected_excess), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    return correction_id, reason, action, replacement_input, signature, expected_excess


def restore_stock(db, sale_id):
    restored = defaultdict(lambda: [Decimal(0), Decimal(0), Decimal(0)])
    with localcontext() as context:
        context.prec = 50
        shortages = {row["position"]: row for row in sale_shortages(db, sale_id)}
        for position, product_id, quantity, multiplier, cost in db.execute(
            "SELECT position, product_id, quantity, multiplier, base_unit_cost "
            "FROM sale_items WHERE sale_id = ?", (sale_id,),
        ):
            quantity = Decimal(quantity) * Decimal(multiplier)
            entry = restored[product_id]
            entry[0] += quantity
            shortage = shortages.get(position)
            if shortage:
                quantity -= Decimal(shortage["quantity"])
                for fill in shortage["fills"]:
                    applied = Decimal(fill["quantity"])
                    entry[1] += applied
                    entry[2] += applied * Decimal(fill["unit_cost"])
            if cost is not None:
                entry[1] += quantity
                entry[2] += quantity * Decimal(cost)

        for product_id, (restored_qty, known_qty, known_value) in restored.items():
            quantity, average = db.execute(
                "SELECT quantity, average_cost FROM products WHERE id = ?", (product_id,),
            ).fetchone()
            quantity = Decimal(quantity)
            if quantity < 0:
                raise SaleConflict(
                    "stock_shortage_unresolved", "Receive stock before correcting a sale for this product",
                )
            new_quantity = quantity + restored_qty
            if known_qty:
                if average is not None:
                    existing_valued_qty = quantity + restored_qty - known_qty
                    new_value = existing_valued_qty * Decimal(average) + known_value
                    average = str(new_value / new_quantity)
                else:
                    average = str(known_value / known_qty)
            db.execute(
                "UPDATE products SET quantity = ?, average_cost = ? WHERE id = ?",
                (str(new_quantity), average, product_id),
            )


def previous_allocations(db, sale_id):
    return [
        {"repayment_id": repayment_id, "amount": amount}
        for repayment_id, amount in db.execute(
            "SELECT a.repayment_id, a.amount FROM debt_allocations a "
            "JOIN debt_repayments r ON r.id = a.repayment_id "
            "WHERE a.sale_id = ? ORDER BY r.created_at, r.id", (sale_id,),
        )
    ]


def choose_destinations(db, original, replacement, paid, action, expected_excess):
    destinations = deque()
    customer_id = original["customer_id"]
    replacement_credit = 0
    replacement_id = None
    if replacement is not None:
        replacement_id = replacement["id"]
        if replacement["customer_id"] == customer_id:
            replacement_credit = min(paid, satang(replacement["payments"]["credit"]))
        if replacement_credit:
            destinations.append((replacement_id, replacement_credit))
    excess = paid - replacement_credit
    if expected_excess is not None and excess != expected_excess:
        raise CorrectionConflict("excess_changed", "The excess amount changed", excess)
    if not excess:
        return destinations, 0, None
    if action is None:
        raise CorrectionConflict(
            "excess_action_required", "Choose how to handle the excess repayment", excess,
        )
    if action != "apply":
        return destinations, excess, action

    remaining = excess
    for bill_id, _, credit, bill_paid in bill_balances(db, customer_id):
        if bill_id in (original["id"], replacement_id):
            continue
        amount = min(remaining, credit - bill_paid)
        if amount > 0:
            destinations.append((bill_id, amount))
            remaining -= amount
        if remaining == 0:
            break
    if remaining:
        raise CorrectionConflict(
            "insufficient_other_debt", "Other bills cannot absorb the full excess", excess,
        )
    return destinations, excess, action


def move_allocations(db, sale_id, previous, destinations):
    changes = []
    db.execute("DELETE FROM debt_allocations WHERE sale_id = ?", (sale_id,))
    for allocation in previous:
        repayment_id = allocation["repayment_id"]
        remaining = satang(allocation["amount"])
        while remaining and destinations:
            target, available = destinations.popleft()
            amount = min(remaining, available)
            existing = db.execute(
                "SELECT amount FROM debt_allocations WHERE repayment_id = ? AND sale_id = ?",
                (repayment_id, target),
            ).fetchone()
            updated = amount + (satang(existing[0]) if existing is not None else 0)
            db.execute(
                "INSERT INTO debt_allocations (repayment_id, sale_id, amount) VALUES (?, ?, ?) "
                "ON CONFLICT(repayment_id, sale_id) DO UPDATE SET amount = excluded.amount",
                (repayment_id, target, baht(updated)),
            )
            changes.append({"repayment_id": repayment_id, "sale_id": target, "amount": baht(amount)})
            remaining -= amount
            if available > amount:
                destinations.appendleft((target, available - amount))
        if remaining:
            changes.append({"repayment_id": repayment_id, "sale_id": None, "amount": baht(remaining)})
    return changes


def correct_sale(db, sale_id, data):
    correction_id, reason, action, replacement_input, signature, expected_excess = correction_input(data, sale_id)
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT request_hash, sale_id, replacement_id, excess, excess_action "
            "FROM sale_corrections WHERE id = ?", (correction_id,),
        ).fetchone()
        if existing is not None:
            if existing[0] != signature:
                raise SaleConflict("idempotency_conflict", "This correction ID was already used")
            return False, correction_result(correction_id, *existing[1:])

        original = read_sale(db, sale_id)
        if original is None:
            raise SaleNotFound("Sale not found")
        if db.execute("SELECT 1 FROM sale_corrections WHERE sale_id = ?", (sale_id,)).fetchone():
            raise SaleConflict("sale_already_voided", "This sale has already been voided")

        replacement_id = replacement_input[0] if replacement_input is not None else None
        if replacement_id is not None and db.execute(
            "SELECT 1 FROM sales WHERE id = ?", (replacement_id,),
        ).fetchone():
            raise SaleConflict("replacement_id_conflict", "This replacement sale ID was already used")

        restore_stock(db, sale_id)
        replacement = None
        if replacement_input is not None:
            _, replacement = checkout_in_transaction(db, replacement_input)
        previous = previous_allocations(db, sale_id)
        paid = sum(satang(allocation["amount"]) for allocation in previous)
        destinations, excess, action = choose_destinations(
            db, original, replacement, paid, action, expected_excess,
        )
        changes = move_allocations(db, sale_id, previous, destinations)
        db.execute(
            "INSERT INTO sale_corrections (id, sale_id, replacement_id, request_hash, reason, "
            "excess, excess_action, previous_allocations, allocation_changes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (correction_id, sale_id, replacement_id, signature, reason, baht(excess), action,
             json.dumps(previous), json.dumps(changes)),
        )
        return True, correction_result(correction_id, sale_id, replacement_id, baht(excess), action)


def correction_result(correction_id, sale_id, replacement_id, excess, action):
    return {
        "id": correction_id,
        "sale_id": sale_id,
        "replacement_id": replacement_id,
        "excess": excess,
        "excess_action": action,
    }
