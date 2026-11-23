const assert = require('node:assert/strict');
const { join } = require('node:path');

module.exports = async function exerciseSaleConfirmation(browser) {
  const context = await browser.newContext();
  const store = '11111111-1111-4111-8111-111111111111';
  const product = { id: '22222222-2222-4222-8222-222222222222', code: 'A', name: 'Test', base_unit: 'piece',
    quantity: '1', average_cost: '5', minimum_quantity: '0', available: true, low_stock: false,
    units: [{ id: '33333333-3333-4333-8333-333333333333', name: 'piece', multiplier: '1', price: '25' }] };
  let committed = null, attempts = [], validResponse = false, stock = 1;
  await context.route('http://localhost:12345/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/store-identity') return route.fulfill({ json: { binding_id: store, restore_ancestors: [] } });
    if (path === '/products') return route.fulfill({ json: [{ ...product, quantity: String(stock) }] });
    if (path === '/customers') return route.fulfill({ json: [] });
    if (path === '/sales' && req.method() === 'POST') {
      const payload = JSON.parse(req.postData()); attempts.push(payload);
      if (!committed) { committed = payload; stock--; }
      assert.equal(payload.id, committed.id);
      if (!validResponse) return route.fulfill({ json: { id: payload.id } });
      return route.fulfill({ json: { id: payload.id, created_at: '2026-11-23T00:00:00Z', total: '25.00',
        items: [{ product_id: product.id, unit_id: product.units[0].id, name: 'Test', unit_name: 'piece', quantity: '1', unit_price: '25', total: '25.00' }],
        payments: { cash: '25.00', qr: '0.00', credit: '0.00' }, customer_id: null, customer_name: null } });
    }
    const files = { '/checkout': 'checkout.html', '/checkout.js': 'checkout.js', '/offline-store.js': 'offline-store.js', '/inventory.css': 'inventory.css' };
    return files[path] ? route.fulfill({ path: join(__dirname, '..', 'web', files[path]) }) : route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage(); await page.goto('http://localhost:12345/checkout');
    const validation = await page.evaluate(() => {
      const payload = { id: 'id', sold_at: '2026-11-23T00:00:00.000Z', customer_id: null,
        items: [{ product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', unit_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: '0.125', expected_unit_price: '2.4' }], payments: { cash: '0.30', qr: '0', credit: '0' } };
      const sale = { id: 'id', created_at: '2026-11-23T01:00:00Z', sold_at: payload.sold_at, customer_id: null,
        customer_name: null, items: [{ product_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', unit_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Test', unit_name: 'piece', quantity: '0.125', unit_price: '2.4', total: '0.30' }],
        total: '0.30', payments: { cash: '0.30', qr: '0.00', credit: '0.00' }, stock_shortages: [{ remaining: '1E+18' }] };
      return [confirmsSale(sale, payload), confirmsSale({ ...sale, total: '0.31' }, payload),
        confirmsSale({ ...sale, items: [{ ...sale.items[0], quantity: '0.126' }] }, payload),
        confirmsSale({ ...sale, payments: { ...sale.payments, cash: '0.31' } }, payload),
        confirmsSale({ ...sale, stock_shortages: {} }, payload), confirmsSale({ ...sale, sold_at: 'wrong' }, payload),
        confirmsSale({ ...sale, items: [{ ...sale.items[0], product_id: 'other' }] }, payload),
        confirmsSale({ ...sale, items: [{ ...sale.items[0], unit_id: 'other' }] }, payload),
        confirmsSale({ ...sale, items: [{ ...sale.items[0], product_id: undefined }] }, payload)];
    });
    assert.deepEqual(validation, [true, false, false, false, false, false, false, false, false]);
    await page.locator('#sale-products button').first().click();
    await page.locator('#sale-cash-all').click();
    await page.locator('#sale-submit').click();
    await page.locator('#sale-receipt:visible').waitFor();
    const queued = await page.evaluate(() => PosOffline.list());
    assert.equal(queued.length, 1, 'matching ID with missing sale must remain pending');
    assert.equal(queued[0].payload.id, committed.id);
    assert.equal(stock, 0);
    await page.locator('#sale-receipt-close').click();
    validResponse = true;
    await page.locator('#sale-retry').click();
    await page.waitForFunction(async () => (await PosOffline.list()).length === 0);
    assert.equal(stock, 0);
    assert.deepEqual(attempts.at(-1), attempts[0]);
  } finally { await context.close(); }
};
