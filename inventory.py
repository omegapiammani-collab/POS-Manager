"""Inventory foundation. Quantities and costs use exact decimal arithmetic."""
from decimal import Decimal, InvalidOperation, localcontext
from uuid import uuid4
import sqlite3

from stock_shortages import cover_shortages

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 base_unit TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '0',
 average_cost TEXT, minimum_quantity TEXT NOT NULL DEFAULT '0'
);
CREATE TABLE IF NOT EXISTS units (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 name TEXT NOT NULL, multiplier TEXT NOT NULL, price TEXT NOT NULL,
 UNIQUE(product_id, name)
);
CREATE TABLE IF NOT EXISTS discontinued_products (
 product_id TEXT PRIMARY KEY REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS receipts (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 unit_id TEXT NOT NULL REFERENCES units(id), quantity TEXT NOT NULL,
 unit_cost TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

def connect(path):
    db = sqlite3.connect(path, isolation_level=None)
    db.execute('PRAGMA foreign_keys = ON')
    db.executescript(SCHEMA)
    return db

def number(value, *, positive=False):
    try:
        value = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError('Invalid number') from None
    if not value.is_finite() or value < 0 or (positive and value == 0):
        raise ValueError('Number must be finite and non-negative')
    return value

def add_product(db, code, name, base_unit, price, minimum_quantity=0):
    code, name, base_unit = code.strip(), name.strip(), base_unit.strip()
    if not all((code, name, base_unit)):
        raise ValueError('Code, name and unit are required')
    price, minimum_quantity = number(price), number(minimum_quantity)
    product_id, unit_id = str(uuid4()), str(uuid4())
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute('INSERT INTO products (id, code, name, base_unit, minimum_quantity) VALUES (?, ?, ?, ?, ?)', (product_id, code, name, base_unit, str(minimum_quantity)))
        db.execute('INSERT INTO units VALUES (?, ?, ?, ?, ?)', (unit_id, product_id, base_unit, '1', str(price)))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return product_id, unit_id

def add_unit(db, product_id, name, multiplier, price):
    name = name.strip()
    if not name:
        raise ValueError('Unit name is required')
    multiplier, price = number(multiplier, positive=True), number(price)
    unit_id = str(uuid4())
    db.execute('INSERT INTO units VALUES (?, ?, ?, ?, ?)', (unit_id, product_id, name, str(multiplier), str(price)))
    return unit_id

def receive(db, product_id, unit_id, quantity, unit_cost):
    quantity, unit_cost = number(quantity, positive=True), number(unit_cost)
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute('SELECT p.quantity, p.average_cost, u.multiplier FROM products p JOIN units u ON u.product_id = p.id WHERE p.id = ? AND u.id = ?', (product_id, unit_id)).fetchone()
        if row is None:
            raise ValueError('Product or unit not found')
        receipt_id = str(uuid4())
        db.execute(
            'INSERT INTO receipts (id, product_id, unit_id, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)',
            (receipt_id, product_id, unit_id, str(quantity), str(unit_cost)),
        )
        with localcontext() as context:
            context.prec = 50
            old_quantity = Decimal(row[0])
            multiplier = Decimal(row[2])
            added = quantity * multiplier
            new_quantity = old_quantity + added
            if old_quantity < 0:
                incoming_cost = unit_cost / multiplier
                cover_shortages(db, product_id, receipt_id, min(-old_quantity, added), incoming_cost)
                average = str(incoming_cost) if new_quantity >= 0 else row[1]
            else:
                old_value = old_quantity * Decimal(row[1] or '0')
                average = str((old_value + quantity * unit_cost) / new_quantity)
        db.execute('UPDATE products SET quantity = ?, average_cost = ? WHERE id = ?',
                   (str(new_quantity), average, product_id))
        db.commit()
        return receipt_id
    except Exception:
        db.rollback()
        raise
