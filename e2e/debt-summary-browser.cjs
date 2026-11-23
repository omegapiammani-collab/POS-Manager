const assert = require('node:assert/strict');
const { join } = require('node:path');

module.exports = async function exerciseDebtSummary(browser) {
  const context = await browser.newContext();
  let balances = [
    { id: 'a', name: 'Alpha', outstanding: '9007199254740992.01' },
    { id: 'b', name: 'Bravo', outstanding: '0.01' },
    { id: 'c', name: 'Charlie', outstanding: '0.00' },
  ];
  let failure = false;
  await context.route('http://localhost:12345/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') throw new Error('summary must not write');
    if (path === '/store-identity') return route.fulfill({ json: { binding_id: '11111111-1111-4111-8111-111111111111' } });
    if (path === '/customer-debts') return failure ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: balances });
    const files = { '/debts': 'debts.html', '/debts.js': 'debts.js', '/inventory.css': 'inventory.css' };
    if (files[path]) return route.fulfill({ path: join(__dirname, '..', 'web', files[path]) });
    return route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage();
    await page.goto('http://localhost:12345/debts');
    await page.locator('#debt-summary:visible').waitFor();
    assert.equal(await page.locator('#debt-total').textContent(), '9,007,199,254,740,992.02 บาท');
    assert.equal(await page.locator('#debt-count').textContent(), '2 คน');
    await page.setViewportSize({ width: 375, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'summary fits phone width');
    await page.locator('#debt-only-outstanding').check();
    assert.equal(await page.locator('#debt-customers button').count(), 2);
    await page.locator('#debt-search').fill('Bravo');
    assert.equal(await page.locator('#debt-customers button').count(), 1);
    assert.equal(await page.locator('#debt-total').textContent(), '9,007,199,254,740,992.02 บาท', 'total includes all customers regardless of filter');
    failure = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#debt-customers-state').textContent.includes('โหลดรายชื่อลูกค้าไม่สำเร็จ'));
    assert.equal(await page.locator('#debt-summary').isHidden(), true);
    failure = false;
    balances = [{ id: 'a', name: 'Alpha', outstanding: 'not money' }];
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#debt-customers-state').textContent.includes('โหลดรายชื่อลูกค้าไม่สำเร็จ'));
    assert.equal(await page.locator('#debt-summary').isHidden(), true);
    balances = [];
    await page.reload();
    await page.locator('#debt-summary:visible').waitFor();
    assert.equal(await page.locator('#debt-total').textContent(), '0.00 บาท');
    assert.equal(await page.locator('#debt-count').textContent(), '0 คน');
  } finally { await context.close(); }
};
