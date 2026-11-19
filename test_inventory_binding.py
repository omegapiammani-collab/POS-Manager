"""Inventory retries must remain bound to the database that created them."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from inventory_api import make_server


class InventoryBindingTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.server = make_server(Path(directory.name) / 'store.sqlite3', 0)
        self.addCleanup(self.server.server_close)
        worker = Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.server.shutdown)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.binding = self.request('/store-identity')[1]['binding_id']
        self.product = self.request('/products', {'code': 'A', 'name': 'A', 'base_unit': 'ชิ้น', 'price': '1'})[1]

    def request(self, path, payload=None, binding=None):
        headers = {'Content-Type': 'application/json'}
        if binding is not None:
            headers['X-POS-Store-ID'] = binding
        req = Request(self.origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        try:
            response = urlopen(req, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_mutations_reject_unknown_or_old_binding_and_keep_stock(self):
        product_id = self.product['id']
        receipt = {'id': str(uuid4()), 'unit_id': self.product['base_unit_id'], 'quantity': '2', 'unit_cost': '1'}
        count = {'id': str(uuid4()), 'expected_quantity': '0', 'counted_quantity': '3', 'unit_cost': '1', 'reason': 'ตรวจนับ'}
        for resource, payload in [('receipts', receipt), ('stock-counts', count)]:
            for binding in [None, str(uuid4())]:
                for target in [product_id, str(uuid4())]:
                    status, result = self.request(f'/products/{target}/{resource}', payload, binding)
                    self.assertEqual((status, result['code']), (409, 'store_mismatch'))
        self.assertEqual(self.request('/products')[1][0]['quantity'], '0')
        self.assertEqual(self.request(f'/products/{product_id}/receipts', receipt, self.binding)[0], 201)
        self.assertEqual(self.request(f'/products/{product_id}/receipts', receipt, self.binding)[0], 201)
        self.assertEqual(self.request('/products')[1][0]['quantity'], '2')
        count['expected_quantity'] = '2'
        self.assertEqual(self.request(f'/products/{product_id}/stock-counts', count, self.binding)[0], 201)
        self.assertEqual(self.request(f'/products/{product_id}/stock-counts', count, self.binding)[0], 200)
        self.assertEqual(self.request('/products')[1][0]['quantity'], '3')


if __name__ == '__main__':
    unittest.main()
