"""Create a consistent SQLite copy or restore one into a new POS database file."""
import argparse
from contextlib import closing
from decimal import Decimal, DecimalException, ROUND_HALF_UP, localcontext
from pathlib import Path
import sqlite3
from store_binding import SCHEMA as BINDING_SCHEMA, rotate_binding


CORE_COLUMNS = {
    "products": {"id", "code", "name", "base_unit", "quantity", "average_cost", "minimum_quantity"},
    "units": {"id", "product_id", "name", "multiplier", "price"},
    "receipts": {"id", "product_id", "unit_id", "quantity", "unit_cost", "created_at"},
}
SALE_COLUMNS = {
    "customers": {"id", "name"},
    "sales": {"id", "request_hash", "created_at", "total", "cash", "qr", "credit", "customer_id", "customer_name"},
    "sale_items": {"sale_id", "position", "product_id", "unit_id", "name", "unit_name", "quantity", "unit_price", "total", "multiplier", "base_unit_cost"},
}
SALE_MARKERS = set(SALE_COLUMNS) | {
    "abandoned_sales", "offline_sale_times", "sale_corrections", "debt_repayments", "debt_allocations",
    "stock_shortages", "stock_shortage_fills", "stock_shortage_count_fills", "stock_counts",
    "expenses", "cash_drawers", "drawer_movements",
}
OPTIONAL_SALE_COLUMNS = {
    "abandoned_sales": {"id", "created_at"},
    "offline_sale_times": {"sale_id", "sold_at"},
    "sale_corrections": {"id", "sale_id", "replacement_id", "request_hash", "created_at", "reason", "excess", "excess_action", "previous_allocations", "allocation_changes"},
    "debt_repayments": {"id", "customer_id", "created_at", "amount", "method", "note"},
    "debt_allocations": {"repayment_id", "sale_id", "amount"},
    "stock_shortages": {"sale_id", "position", "product_id", "quantity", "remaining"},
    "stock_shortage_fills": {"sale_id", "position", "receipt_id", "quantity", "unit_cost"},
    "stock_shortage_count_fills": {"sale_id", "position", "stock_count_id", "quantity", "unit_cost"},
}


def validate_sales(db):
    def decimal(value, *, positive=False):
        if value is None or len(str(value)) > 100:
            raise ValueError("Invalid sale amount")
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or (positive and not amount):
            raise ValueError("Invalid sale amount")
        return amount

    try:
        with localcontext() as context:
            context.prec = 80
            rows = db.execute(
                "SELECT s.id, s.total, s.cash, s.qr, s.credit, s.customer_id, c.id, "
                "i.sale_id, i.quantity, i.unit_price, i.total, i.multiplier, i.base_unit_cost, p.id, u.id "
                "FROM sales s LEFT JOIN customers c ON c.id = s.customer_id "
                "LEFT JOIN sale_items i ON i.sale_id = s.id "
                "LEFT JOIN products p ON p.id = i.product_id "
                "LEFT JOIN units u ON u.id = i.unit_id AND u.product_id = i.product_id "
                "ORDER BY s.rowid, i.position"
            )
            current_id, expected, subtotal = None, None, Decimal(0)
            for (sale_id, total, cash, qr, credit, customer_id, customer_found, item_sale_id, quantity,
                 price, item_total, multiplier, cost, product_found, unit_found) in rows:
                if sale_id is None:
                    raise ValueError("Invalid sale identifier")
                if sale_id != current_id:
                    if current_id is not None and subtotal != expected:
                        raise ValueError("Sale item totals do not match the sale")
                    current_id, subtotal = sale_id, Decimal(0)
                    expected = decimal(total)
                    paid_cash, paid_qr, paid_credit = decimal(cash), decimal(qr), decimal(credit)
                    if (paid_cash + paid_qr + paid_credit != expected or (paid_credit and not customer_id)
                            or (customer_id is not None and customer_found is None)):
                        raise ValueError("Sale payment totals are inconsistent")
                if item_sale_id is None:
                    raise ValueError("A sale has no item details")
                if product_found is None or unit_found is None:
                    raise ValueError("Sale item references are inconsistent")
                decimal(multiplier, positive=True)
                if cost is not None:
                    decimal(cost)
                actual = decimal(item_total)
                line = (decimal(quantity, positive=True) * decimal(price)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                if actual != line:
                    raise ValueError("Sale item amount is inconsistent")
                subtotal += actual
            if current_id is not None and subtotal != expected:
                raise ValueError("Sale item totals do not match the sale")
    except (DecimalException, TypeError, ValueError) as exc:
        raise ValueError("The backup contains incomplete or inconsistent sales") from exc


def read_only_database(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def validate_backup(db):
    objects = dict(db.execute("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"))
    if any(kind not in ("table", "index") for kind in objects.values()):
        raise ValueError("The backup contains unsupported database objects")
    for table, columns in CORE_COLUMNS.items():
        actual_columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        if objects.get(table) != "table" or not columns.issubset(actual_columns):
            raise ValueError("The file does not contain a POS inventory database")
    if SALE_MARKERS.intersection(objects):
        for table, columns in SALE_COLUMNS.items():
            actual_columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            if objects.get(table) != "table" or not columns.issubset(actual_columns):
                raise ValueError("The backup contains an incomplete sales schema")
        for table, columns in OPTIONAL_SALE_COLUMNS.items():
            if table in objects:
                actual_columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                if objects[table] != "table" or not columns.issubset(actual_columns):
                    raise ValueError("The backup contains an incomplete sales dependency")
        for group in (("debt_repayments", "debt_allocations"), ("stock_shortages", "stock_shortage_fills")):
            if any(table in objects for table in group) and not all(table in objects for table in group):
                raise ValueError("The backup contains incomplete sales dependencies")
        if "stock_shortage_count_fills" in objects and ("stock_counts" not in objects or "stock_shortages" not in objects):
            raise ValueError("The backup contains incomplete stock count dependencies")
        validate_sales(db)
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("SQLite reported a damaged backup")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("The backup contains missing references")


def copy_database(source, target):
    with closing(read_only_database(source)) as source_db:
        with closing(sqlite3.connect(target)) as target_db:
            source_db.backup(target_db)


def restore_database(source, target):
    target = Path(target).absolute()
    with closing(read_only_database(source)) as source_db:
        source_db.execute("PRAGMA trusted_schema = OFF")
        source_db.execute("BEGIN")
        validate_backup(source_db)
        # Exclusive creation keeps an existing database intact even if another process
        # creates the target after validation.
        with target.open("xb"):
            pass
        try:
            with closing(sqlite3.connect(target)) as target_db:
                source_db.backup(target_db)
                target_db.executescript(BINDING_SCHEMA)
                rotate_binding(target_db)
                target_db.commit()
        except BaseException:
            target.unlink()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    restore = actions.add_parser("restore", help="Restore a backup into a new database")
    restore.add_argument("backup", type=Path)
    restore.add_argument("new_database", type=Path)
    args = parser.parse_args()
    try:
        restore_database(args.backup, args.new_database)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"Restore failed: {exc}\n")
    print(f"Restored database: {args.new_database}")


if __name__ == "__main__":
    main()
