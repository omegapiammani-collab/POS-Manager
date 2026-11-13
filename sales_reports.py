"""Sales and gross margin for inclusive Bangkok business dates."""
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, localcontext

from expenses import active_expenses, validate_date_range


CENT = Decimal("0.01")
ZERO = Decimal(0)
REPORT_SALES = """
WITH RECURSIVE bill_dates(id, business_date) AS (
    SELECT s.id, date(COALESCE(t.sold_at, s.created_at), '+7 hours')
    FROM sales s LEFT JOIN offline_sale_times t ON t.sale_id = s.id
    WHERE date(COALESCE(t.sold_at, s.created_at), '+7 hours') BETWEEN ? AND ?
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
    cash_drawer_expenses: Decimal = ZERO
    external_expenses: Decimal = ZERO

    def add_bill(self, total, cash, qr, credit):
        self.bill_count += 1
        self.revenue += Decimal(total)
        self.cash += Decimal(cash)
        self.qr += Decimal(qr)
        self.credit += Decimal(credit)

    def add_expense(self, amount, source):
        if source == "cash_drawer":
            self.cash_drawer_expenses += amount
        else:
            self.external_expenses += amount

    def result(self):
        totals = super().result()
        expenses = self.cash_drawer_expenses + self.external_expenses
        gross = totals["gross_profit"]
        return {
            **totals, "bill_count": self.bill_count,
            "cash": money(self.cash), "qr": money(self.qr), "credit": money(self.credit),
            "expenses": money(expenses),
            "cash_drawer_expenses": money(self.cash_drawer_expenses),
            "external_expenses": money(self.external_expenses),
            "profit_after_expenses": None if gross is None else money(Decimal(gross) - expenses),
        }


def money(value):
    return format(value.quantize(CENT, rounding=ROUND_HALF_UP), "f")


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
    validate_date_range(start, end)
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
        for day, amount, source in active_expenses(db, start, end):
            summary.add_expense(amount, source)
            days[day].add_expense(amount, source)
        return {
            "from": start, "to": end, "summary": summary.result(),
            "days": [{"date": day, **group.result()} for day, group in sorted(days.items())],
            "products": [
                {
                    "product_id": item["product_id"], "name": item["name"], "base_unit": item["base_unit"],
                    "quantity": format(item["quantity"], "f"), **item["totals"].result(),
                }
                for item in sorted(products.values(), key=lambda row: (row["name"], row["product_id"]))
            ],
        }
