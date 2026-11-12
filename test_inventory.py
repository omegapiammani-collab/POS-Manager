import sqlite3
import unittest
from decimal import Decimal
from inventory import add_product, add_unit, connect, receive

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(':memory:')
        self.product, self.bottle = add_product(self.db, 'W01', 'น้ำดื่ม', 'ขวด', '10', 12)

    def test_mixed_units_and_weighted_average(self):
        pack = add_unit(self.db, self.product, 'แพ็ก', 12, 100)
        receive(self.db, self.product, pack, 1, 120)
        receive(self.db, self.product, self.bottle, 12, 12)
        quantity, average = self.db.execute('SELECT quantity, average_cost FROM products').fetchone()
        self.assertEqual(Decimal(quantity), 24)
        self.assertEqual(Decimal(average), 11)

    def test_invalid_unit_leaves_no_receipt(self):
        with self.assertRaises(ValueError):
            receive(self.db, self.product, 'missing', 1, 10)
        self.assertEqual(self.db.execute('SELECT count(*) FROM receipts').fetchone()[0], 0)

    def test_duplicate_code_does_not_create_partial_product(self):
        with self.assertRaises(sqlite3.IntegrityError):
            add_product(self.db, 'W01', 'duplicate', 'ชิ้น', 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM products').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM units').fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
