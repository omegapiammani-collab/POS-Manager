const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function exerciseUnknownCostFilter(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const store = '11111111-1111-4111-8111-111111111111';
  const rows = [
    ['22222222-2222-4222-8222-222222222221', 'A', 'Alpha', '10', null, true],
    ['22222222-2222-4222-8222-222222222222', 'B', 'Beta', '2', null, false],
    ['22222222-2222-4222-8222-222222222223', 'C', 'Zero stock', '0', null, true],
    ['22222222-2222-4222-8222-222222222224', 'D', 'Negative', '-1', null, true],
    ['22222222-2222-4222-8222-222222222225', 'E', 'Zero cost', '4', '0', true],
  ].map(([id, code, name, quantity, average_cost, available]) => ({
    id, code, name, quantity, average_cost, available, base_unit: 'unit', minimum_quantity: '0',
    low_stock: Number(quantity) <= 0, stock_version: '0', units: [],
  }));
  let posts = 0;
  await context.route('http://localhost:12345/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/store-identity') return route.fulfill({ json: { binding_id: store } });
    if (path === '/products') return route.fulfill({ json: rows });
    if (path.endsWith('/cost-baselines') && request.method() === 'POST') {
      posts++;
      const payload = JSON.parse(request.postData());
      const product = rows.find(row => path.includes(row.id));
      assert.equal(request.headers()['x-pos-store-id'], store);
      assert.equal(payload.expected_quantity, product.quantity);
      product.average_cost = payload.unit_cost; product.stock_version = '1';
      return route.fulfill({ status: 201, json: { id: payload.id } });
    }
    if (/\/products\/.*\/(receipts|stock-counts|cost-baselines)$/.test(path)) return route.fulfill({ json: [] });
    const files = { '/': 'index.html', '/inventory.js': 'inventory.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
    if (files[path]) return route.fulfill({ path: join(__dirname, '..', 'web', files[path]) });
    return route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage();
    await page.goto('http://localhost:12345/');
    await page.locator('#products button').first().waitFor();
    await page.selectOption('#stock-filter', 'unknown-cost');
    assert.equal(await page.locator('#products button').count(), 2);
    assert.match(await page.locator('#products button').nth(1).textContent(), /Beta.*พักขาย.*ยังไม่ทราบต้นทุน/);
    assert.equal(await page.locator('#unknown-cost-note').isVisible(), true);
    await page.locator('#search').fill('Alpha');
    assert.equal(await page.locator('#products button').count(), 1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#stock-download').click()]);
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /Alpha/);
    assert.doesNotMatch(csv, /Beta|Zero stock|Negative|Zero cost/);
    await page.locator('#search').fill('');
    await page.locator('#products button').first().click();
    await page.locator('#open-cost-baseline').click();
    await page.locator('#cost-baseline [name=unit_cost]').fill('7');
    await page.locator('#cost-baseline [name=reason]').fill('invoice');
    await page.locator('#cost-baseline [name=confirmed]').check();
    await page.locator('#cost-baseline button[type=submit]').click();
    await page.waitForFunction(() => document.querySelectorAll('#products button').length === 1);
    assert.equal(posts, 1);
    assert.match(await page.locator('#products button').first().textContent(), /Beta/);
    await page.selectOption('#stock-filter', 'all');
    assert.equal(await page.locator('#products button').count(), 5);
    assert.equal(await page.locator('#unknown-cost-note').isHidden(), true);
  } finally { await context.close(); }
};
