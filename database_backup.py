"""Create a consistent SQLite copy or restore one into a new POS database file."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3


CORE_COLUMNS = {
    "products": {"id", "code", "name", "base_unit", "quantity", "average_cost", "minimum_quantity"},
    "units": {"id", "product_id", "name", "multiplier", "price"},
    "receipts": {"id", "product_id", "unit_id", "quantity", "unit_cost", "created_at"},
}


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
