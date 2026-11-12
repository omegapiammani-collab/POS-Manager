"""Sales and gross margin for inclusive Bangkok business dates."""
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, ROUND_HALF_UP, localcontext
import re


CENT = Decimal("0.01")
ZERO = Decimal(0)
REPORT_SALES = """
WITH RECURSIVE bill_dates(id, business_date) AS (
    SELECT s.id, date(s.created_at, '+7 hours')
    FROM sales s
    WHERE date(s.created_at, '+7 hours') BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.replacement_id = s.id)
    UNION ALL
    SELECT c.replacement_id, b.business_date
    FROM bill_dates b JOIN sale_corrections c ON c.sale_id = b.id
    WHERE c.replacement_id IS NOT NULL
)
SELECT s.id, b.business_date, s.total, s.cash, s.qr, s.credit
FROM bill_dates b JOIN sales s ON s.id = b.id
WHERE NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.sale_id = s.id)
ORDER BY b.business_date, s.rowid
"""


@dataclass
class Totals:
    revenue: Decimal = ZERO
    cost: Decimal = ZERO
    pending: set[str] = field(default_factory=set)
    unknown: set[str] = field(default_factory=set)

    def add_cost(self, sale_id, cost, pending):
        if pending:
            self.pending.add(sale_id)
        if cost is None:
            self.unknown.add(sale_id)
        else:
            self.cost += cost

    def result(self):
        cost = self.cost.quantize(CENT, rounding=ROUND_HALF_UP)
        return {
            "revenue": money(self.revenue),
            "cost": None if self.unknown else money(cost),
            "gross_profit": None if self.unknown else money(self.revenue - cost),
            "pending_cost_bills": len(self.pending),
            "unknown_cost_bills": len(self.unknown),
        }


@dataclass
class SalesTotals(Totals):
    bill_count: int = 0
    cash: Decimal = ZERO
    qr: Decimal = ZERO
    credit: Decimal = ZERO

    def add_bill(self, total, cash, qr, credit):
        self.bill_count += 1
        self.revenue += Decimal(total)
        self.cash += Decimal(cash)
        self.qr += Decimal(qr)
        self.credit += Decimal(credit)

    def result(self):
        return {
            **super().result(), "bill_count": self.bill_count,
            "cash": money(self.cash), "qr": money(self.qr), "credit": money(self.credit),
        }


def money(value):
    return format(value.quantize(CENT, rounding=ROUND_HALF_UP), "f")


def business_date(value):
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("Use YYYY-MM-DD dates")
    return date.fromisoformat(value)


def bill_line_costs(db, sale_id):
    fill_costs = defaultdict(lambda: ZERO)
    for position, quantity, unit_cost in db.execute(
        "SELECT position, quantity, unit_cost FROM stock_shortage_fills WHERE sale_id = ? "
        "UNION ALL SELECT position, quantity, unit_cost FROM stock_shortage_count_fills WHERE sale_id = ?",
        (sale_id, sale_id),
    ):
        fill_costs[position] += Decimal(quantity) * Decimal(unit_cost)

    for row in db.execute(
        "SELECT i.position, i.product_id, i.name, p.base_unit, i.quantity, i.multiplier, "
        "i.total, i.base_unit_cost, q.quantity, q.remaining "
        "FROM sale_items i JOIN products p ON p.id = i.product_id "
        "LEFT JOIN stock_shortages q USING (sale_id, position) WHERE i.sale_id = ? ORDER BY i.position",
        (sale_id,),
    ):
        position, product_id, name, unit, quantity, multiplier, total, base_cost, shortage, remaining = row
        base_qty = Decimal(quantity) * Decimal(multiplier)
        unresolved = Decimal(remaining or "0")
        provisional_qty = base_qty - Decimal(shortage or "0") + unresolved
        cost = fill_costs[position]
        if provisional_qty:
            cost = None if base_cost is None else cost + provisional_qty * Decimal(base_cost)
        yield product_id, name, unit, base_qty, Decimal(total), cost, unresolved > 0


def sales_report(db, start, end):
    if business_date(start) > business_date(end):
        raise ValueError("Start date must be on or before end date")
    summary = SalesTotals()
    days = defaultdict(SalesTotals)
    products = {}
    with db, localcontext() as context:
        context.prec = 70
        db.execute("BEGIN")
        for sale_id, day, *amounts in db.execute(REPORT_SALES, (start, end)):
            daily = days[day]
            summary.add_bill(*amounts)
            daily.add_bill(*amounts)
            for product_id, name, unit, quantity, revenue, cost, pending in bill_line_costs(db, sale_id):
                product = products.setdefault(product_id, {
                    "product_id": product_id, "name": name, "base_unit": unit,
                    "quantity": ZERO, "totals": Totals(),
                })
                product["quantity"] += quantity
                product["totals"].revenue += revenue
                for group in (summary, daily, product["totals"]):
                    group.add_cost(sale_id, cost, pending)
        return {
            "from": start, "to": end, "summary": summary.result(),
            "days": [{"date": day, **group.result()} for day, group in days.items()],
            "products": [
                {
                    "product_id": item["product_id"], "name": item["name"], "base_unit": item["base_unit"],
                    "quantity": format(item["quantity"], "f"), **item["totals"].result(),
                }
                for item in sorted(products.values(), key=lambda row: (row["name"], row["product_id"]))
            ],
        }
