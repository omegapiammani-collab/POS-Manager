"""Ensure choosing a database cannot silently create or overwrite a store."""
from contextlib import contextmanager
from pathlib import Path
import select
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from database_backup import restore_database


SERVER = Path(__file__).with_name("inventory_api.py")


class ServerCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SERVER), "--port", "0", *map(str, args)],
            cwd=self.directory, capture_output=True, text=True, timeout=10,
        )

    @contextmanager
    def server(self, *args):
        process = subprocess.Popen(
            [sys.executable, str(SERVER), "--port", "0", *map(str, args)],
            cwd=self.directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            ready, _, _ = select.select([process.stdout], [], [], 10)
            self.assertTrue(ready, "Server did not report startup")
            line = process.stdout.readline().strip()
            self.assertTrue(line.startswith("Inventory API: http://127.0.0.1:"), line + process.stderr.read() if process.poll() is not None else line)
            yield
        finally:
            process.terminate()
            process.communicate(timeout=10)

    def test_default_can_be_created_and_reopened(self):
        with self.server():
            self.assertTrue((self.directory / "inventory.sqlite3").is_file())
        with self.server():
            pass

    def test_named_missing_database_is_not_created_without_explicit_flag(self):
        missing = self.directory / "typo.sqlite3"
        result = self.run_cli("--database", missing)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--create-database", result.stderr)
        self.assertFalse(missing.exists())

    def test_new_named_database_reopens_and_restored_file_works(self):
        database = self.directory / "store.sqlite3"
        with self.server("--database", database, "--create-database"):
            pass
        with self.server("--database", database):
            pass
        restored = self.directory / "restored.sqlite3"
        restore_database(database, restored)
        with self.server("--database", restored):
            pass
        before = database.read_bytes()
        result = self.run_cli("--database", database, "--create-database")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(database.read_bytes(), before)

    def test_empty_directory_and_unrelated_database_are_not_modified(self):
        empty = self.directory / "empty.sqlite3"
        empty.touch()
        unrelated = self.directory / "unrelated.sqlite3"
        with sqlite3.connect(unrelated) as db:
            db.execute("CREATE TABLE personal_data (value TEXT)")
            db.execute("INSERT INTO personal_data VALUES ('preserve')")
        original = unrelated.read_bytes()
        for target in (empty, self.directory, unrelated):
            with self.subTest(target=target):
                result = self.run_cli("--database", target)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(empty.stat().st_size, 0)
        self.assertEqual(unrelated.read_bytes(), original)
        self.assertFalse((self.directory / "inventory.sqlite3").exists())

    def test_create_flag_requires_a_named_database(self):
        result = self.run_cli("--create-database")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.directory / "inventory.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()
