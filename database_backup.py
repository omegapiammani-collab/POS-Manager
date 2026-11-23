"""Create a consistent SQLite copy or restore one into a new POS database file."""
import argparse
from contextlib import closing
from decimal import Decimal, DecimalException, ROUND_HALF_UP, localcontext
import json
from pathlib import Path
import sqlite3
from uuid import UUID
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
    "expenses", "cash_drawers", "drawer_movements", "customer_requests",
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


def validate_customer_requests(db, objects):
    if "customer_requests" not in objects:
        return
    if objects["customer_requests"] != "table" or objects.get("customers") != "table":
        raise ValueError("The backup contains an incomplete customer request dependency")
    columns = {row[1]: row for row in db.execute("PRAGMA table_info(customer_requests)")}
    required = {"request_id", "name", "customer_id"}
    if (not required.issubset(columns) or columns["request_id"][5] != 1
            or any(columns[key][2].upper() != "TEXT" for key in required)
            or not columns["name"][3] or not columns["customer_id"][3]):
        raise ValueError("The backup contains an invalid customer request schema")
    primary = [column for column in columns.values() if column[5]]
    foreign_keys = list(db.execute("PRAGMA foreign_key_list(customer_requests)"))
    if len(primary) != 1 or not any(row[2] == "customers" and row[3] == "customer_id" and row[4] == "id" for row in foreign_keys):
        raise ValueError("The backup contains an invalid customer request dependency")
    rows = db.execute("SELECT r.request_id, r.name, r.customer_id, c.name FROM customer_requests r LEFT JOIN customers c ON c.id = r.customer_id")
    for request_id, name, customer_id, customer_name in rows:
        try:
            if not isinstance(request_id, str) or str(UUID(request_id)) != request_id:
                raise ValueError()
        except (TypeError, ValueError, AttributeError):
            raise ValueError("The backup contains an invalid customer request ID") from None
        if (not isinstance(name, str) or not name or name != name.strip() or len(name) > 120
                or not isinstance(customer_id, str) or customer_name != name):
            raise ValueError("The backup contains an inconsistent customer request")


def validate_cost_baselines(db, objects):
    """Validate the additive tables when present; older backups may omit both."""
    names = ("stock_revisions", "cost_baselines")
    if not any(name in objects for name in names):
        return
    required = {
        "stock_revisions": {"product_id": "TEXT", "version": "INTEGER"},
        "cost_baselines": {"id": "TEXT", "product_id": "TEXT", "expected_quantity": "TEXT",
                           "expected_version": "INTEGER", "unit_cost": "TEXT", "reason": "TEXT", "created_at": "TEXT"},
    }
    for name, fields in required.items():
        if objects.get(name) != "table":
            raise ValueError("The backup contains incomplete cost baseline tables")
        columns = {row[1]: row for row in db.execute(f"PRAGMA table_info({name})")}
        if not all(field in columns and columns[field][2].upper() == kind and columns[field][3]
                   for field, kind in fields.items()):
            raise ValueError("The backup contains an invalid cost baseline schema")
        key = "product_id" if name == "stock_revisions" else "id"
        if columns[key][5] != 1 or sum(bool(column[5]) for column in columns.values()) != 1:
            raise ValueError("The backup contains an invalid cost baseline key")
        if not any(row[2:5] == ("products", "product_id", "id") for row in db.execute(f"PRAGMA foreign_key_list({name})")):
            raise ValueError("The backup contains an invalid cost baseline reference")
    for product, version in db.execute("SELECT product_id, version FROM stock_revisions"):
        if not isinstance(product, str) or type(version) is not int or version < 0:
            raise ValueError("The backup contains an invalid stock revision")
    for request_id, quantity, version, cost, reason, revision in db.execute(
        "SELECT b.id, b.expected_quantity, b.expected_version, b.unit_cost, b.reason, r.version "
        "FROM cost_baselines b LEFT JOIN stock_revisions r ON r.product_id = b.product_id"
    ):
        try:
            if str(UUID(request_id)) != request_id or len(quantity) > 100 or len(cost) > 100:
                raise ValueError()
            quantity_number, cost_number = Decimal(quantity), Decimal(cost)
            if (not quantity_number.is_finite() or quantity_number <= 0 or not cost_number.is_finite()
                    or cost_number < 0 or cost_number > Decimal('1000000000')
                    or type(version) is not int or version < 0 or type(revision) is not int or revision <= version
                    or not isinstance(reason, str) or reason != reason.strip() or not 1 <= len(reason) <= 300):
                raise ValueError()
        except (ValueError, TypeError, AttributeError, DecimalException):
            raise ValueError("The backup contains an invalid cost baseline")


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
    validate_customer_requests(db, objects)
    validate_cost_baselines(db, objects)
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("SQLite reported a damaged backup")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("The backup contains missing references")


def copy_database(source, target):
    with closing(read_only_database(source)) as source_db:
        with closing(sqlite3.connect(target)) as target_db:
            source_db.backup(target_db)


def check_backup(source):
    """Check a snapshot without creating or changing a database file."""
    with closing(read_only_database(source)) as source_db:
        source_db.execute("PRAGMA trusted_schema = OFF")
        source_db.execute("BEGIN")
        validate_backup(source_db)


def inventory_backup(source):
    """Describe a validated snapshot without returning row values or modifying it."""
    with closing(read_only_database(source)) as source_db:
        source_db.execute("PRAGMA trusted_schema = OFF")
        source_db.execute("BEGIN")
        validate_backup(source_db)
        tables = []
        names = [row[0] for row in source_db.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
        ) if not row[0].startswith("sqlite_")]
        for name in names:
            identifier = '"' + name.replace('"', '""') + '"'
            columns = [
                {"name": row[1], "type": row[2], "not_null": bool(row[3]), "primary_key_position": row[5], "hidden": row[6]}
                for row in source_db.execute(f"PRAGMA table_xinfo({identifier})")
            ]
            foreign_keys = [
                {"id": row[0], "sequence": row[1], "table": row[2], "from": row[3], "to": row[4],
                 "on_update": row[5], "on_delete": row[6]}
                for row in source_db.execute(f"PRAGMA foreign_key_list({identifier})")
            ]
            count = source_db.execute(f"SELECT COUNT(*) FROM {identifier}").fetchone()[0]
            tables.append({"name": name, "row_count": count, "columns": columns, "foreign_keys": foreign_keys})
        return {"format": "pos-sqlite-inventory", "version": 1,
                "user_version": source_db.execute("PRAGMA user_version").fetchone()[0], "tables": tables}


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
    check = actions.add_parser("check", help="Check a backup without restoring it")
    check.add_argument("backup", type=Path)
    inventory = actions.add_parser("inventory", help="Describe a validated backup without exporting row values")
    inventory.add_argument("backup", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "check":
            check_backup(args.backup)
        elif args.action == "inventory":
            report = inventory_backup(args.backup)
        else:
            restore_database(args.backup, args.new_database)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"{args.action.capitalize()} failed: {exc}\n")
    if args.action == "check":
        print(f"Backup check passed: {args.backup}")
    elif args.action == "inventory":
        print(json.dumps(report, ensure_ascii=True, indent=2))
    else:
        print(f"Restored database: {args.new_database}")


if __name__ == "__main__":
    main()
