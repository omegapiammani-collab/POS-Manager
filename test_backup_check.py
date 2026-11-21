"""Exercise the backup check without requiring a running server."""
from contextlib import closing
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

import inventory

SCRIPT = Path(__file__).with_name("database_backup.py")


class BackupCheckTests(unittest.TestCase):
    def test_check_valid_invalid_and_missing_files(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            backup = root / "backup.sqlite3"
            with closing(inventory.connect(backup)) as db:
                inventory.add_product(db, "A", "Water", "bottle", "10")
            original = backup.read_bytes()

            def check(path):
                return subprocess.run([sys.executable, str(SCRIPT), "check", str(path)],
                                      capture_output=True, text=True, timeout=10)

            result = check(backup)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(backup.read_bytes(), original)
            self.assertEqual({path.name for path in root.iterdir()}, {backup.name})
            invalid = root / "invalid.sqlite3"
            invalid.write_bytes(b"not a database")
            self.assertNotEqual(check(invalid).returncode, 0)
            self.assertEqual(invalid.read_bytes(), b"not a database")
            missing = root / "missing.sqlite3"
            self.assertNotEqual(check(missing).returncode, 0)
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
