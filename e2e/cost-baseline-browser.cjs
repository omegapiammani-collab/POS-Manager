const assert = require('node:assert/strict');
const { join } = require('node:path');

// Routes are intercepted so no provider or external service is contacted.
module.exports = async function exerciseCostBaseline(browser) {
  const context = await browser.newContext();
  const store = '11111111-1111-4111-8111-111111111111';
  let activeStore = store;
  const productId = '22222222-2222-4222-8222-222222222222';
  const product = { id: productId, code: 'A', name: 'Test', base_unit: 'unit', quantity: '10', average_cost: null,
    stock_version: '0', minimum_quantity: '0', available: true, low_stock: false, units: [] };
  let requests = [], entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await context.route('http://localhost:12345/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/store-identity') return route.fulfill({ json: { binding_id: activeStore } });
    if (path === '/products') return route.fulfill({ json: [product] });
    if (path.endsWith('/cost-baselines') && req.method() === 'POST') {
      requests.push(JSON.parse(req.postData()));
      if (requests.length === 1) { entered(); await hold; return route.fulfill({ status: 200, contentType: 'text/html', body: 'unexpected response' }); }
      product.average_cost = '7'; product.stock_version = '1';
      return route.fulfill({ json: { id: requests[0].id } });
    }
    if (/\/products\/.*\/(receipts|stock-counts|cost-baselines)$/.test(path)) return route.fulfill({ json: [] });
    const files = { '/': 'index.html', '/inventory.js': 'inventory.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
    if (files[path]) return route.fulfill({ path: join(__dirname, '..', 'web', files[path]) });
    return route.fulfill({ status: 404, body: '' });
  });
  const openForm = async page => {
    await page.goto('http://localhost:12345/');
    await page.locator('#products button').first().click();
    await page.locator('#open-cost-baseline').click();
    await page.locator('#cost-baseline [name=unit_cost]').fill('7');
    await page.locator('#cost-baseline [name=reason]').fill('invoice');
    await page.locator('#cost-baseline [name=confirmed]').check();
  };
  try {
    const a = await context.newPage(), b = await context.newPage();
    await openForm(a); await openForm(b);
    await a.locator('#cost-baseline button[type=submit]').click();
    await enteredPromise;
    await b.locator('#cost-baseline button[type=submit]').click();
    await b.locator('#cost-error:visible').waitFor();
    assert.equal(requests.length, 1, 'second tab must not send while lock is held');
    release();
    await a.locator('#cost-error:visible').waitFor();
    const pending = await a.evaluate(() => localStorage.getItem('pos-cost-baseline-pending-v1'));
    assert.equal(JSON.parse(pending).payload.id, requests[0].id, 'ambiguous response keeps original request');
    await a.locator('#cost-close').click();
    activeStore = '33333333-3333-4333-8333-333333333333';
    await a.locator('#cost-retry').click();
    await a.waitForFunction(() => document.querySelector('#cost-pending-message').textContent.includes('ร้านเดิม'));
    assert.equal(requests.length, 1, 'changed store must not receive a retry');
    assert.equal(await a.evaluate(() => localStorage.getItem('pos-cost-baseline-pending-v1')), pending);
    activeStore = store;
    await a.locator('#cost-retry').click();
    await a.waitForFunction(() => localStorage.getItem('pos-cost-baseline-pending-v1') === null);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0], 'retry must use identical payload');
    const c = await browser.newContext();
    try {
      await c.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
      await c.route('http://localhost:12345/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() === 'POST') throw new Error('unexpected POST without Web Locks');
        if (path === '/store-identity') return route.fulfill({ json: { binding_id: store } });
        if (path === '/products') return route.fulfill({ json: [{ ...product, average_cost: null }] });
        if (path.startsWith('/products/')) return route.fulfill({ json: [] });
        const files = { '/': 'index.html', '/inventory.js': 'inventory.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
        if (files[path]) return route.fulfill({ path: join(__dirname, '..', 'web', files[path]) });
        return route.fulfill({ status: 404 });
      });
      const page = await c.newPage(); await page.goto('http://localhost:12345/');
      await page.locator('#products button').first().click();
      assert.equal(await page.locator('#open-cost-baseline').isDisabled(), true, 'must fail closed without locks');
    } finally { await c.close(); }
  } finally { release(); await context.close(); }
};
