const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function exerciseBillProductSearch(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const bills = ids.map((id, index) => ({ id, created_at: '2025-06-14T12:00:00.000Z', total: '25.00',
    items: [{ name: index === 1 ? 'Milk' : 'Rice', unit_name: 'piece', quantity: '1', unit_price: '25', total: '25.00' }],
    payments: { cash: '25.00', qr: '0.00', credit: '0.00' }, customer_id: null, customer_name: index === 2 ? 'Milk customer' : null,
    status: index === 0 ? 'voided' : 'active', replacement_id: null, correction_reason: null, correction_excess: null, correction_excess_action: null }));
  await context.route('http://localhost:12345/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') throw new Error('search must not write');
    if (path === '/store-identity') return route.fulfill({ json: { binding_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    if (path === '/sale-history') return route.fulfill({ json: bills });
    const files = { '/bills': 'bills.html', '/bills.js': 'bills.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
    return files[path] ? route.fulfill({ path: join(__dirname, '..', 'web', files[path]) }) : route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage(); await page.goto('http://localhost:12345/bills');
    await page.locator('#bill-list button').first().waitFor();
    const ordered = await page.locator('#bill-list button').allTextContents();
    for (let i = 0; i < ids.length; i++) assert.match(ordered[i], new RegExp(ids[i]));
    await page.locator('#bill-filters [name=query]').fill('mIlK');
    assert.equal(await page.locator('#bill-list button').count(), 2, 'matches item name and customer name');
    await page.locator('#bill-filter-status').selectOption('active');
    assert.equal(await page.locator('#bill-list button').count(), 2);
    await page.locator('#bill-filters [name=query]').fill('rice');
    assert.equal(await page.locator('#bill-list button').count(), 1, 'status filter combines with product search');
    assert.match(await page.locator('#bill-list button').first().textContent(), new RegExp(ids[2]));
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#bill-download').click()]);
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, new RegExp(ids[2])); assert.doesNotMatch(csv, new RegExp(ids[0] + '|' + ids[1]));
    await page.locator('#bill-filters [name=query]').fill(ids[1]);
    assert.equal(await page.locator('#bill-list button').count(), 1, 'existing ID search still works');
  } finally { await context.close(); }
};
