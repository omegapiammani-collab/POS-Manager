"""Persistent checkout binding and restore ancestry; these are not credentials."""
from uuid import uuid4

SCHEMA = """
CREATE TABLE IF NOT EXISTS store_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS store_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS store_binding_ancestors (
    id TEXT PRIMARY KEY
);
"""


def ensure_binding(db):
    db.execute("INSERT OR IGNORE INTO store_identity (singleton, id) VALUES (1, ?)", (str(uuid4()),))
    db.execute("INSERT OR IGNORE INTO store_binding (singleton, id) SELECT 1, id FROM store_identity WHERE singleton = 1")


def rotate_binding(db):
    ensure_binding(db)
    db.execute("INSERT OR IGNORE INTO store_binding_ancestors (id) SELECT id FROM store_binding WHERE singleton = 1")
    db.execute("UPDATE store_binding SET id = ? WHERE singleton = 1", (str(uuid4()),))
