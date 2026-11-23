const assert = require('node:assert/strict');
const { join } = require('node:path');

module.exports = async function exerciseDrawerQueue(browser) {
  const context = await browser.newContext();
  const store = '11111111-1111-4111-8111-111111111111';
  let activeStore = store, submissions = [];
  const breakdown = Object.fromEntries(['sales_cash', 'sale_corrections_cash', 'repayments_cash', 'added_cash',
    'withdrawn_cash', 'expenses_cash', 'refunds_cash'].map(key => [key, '0.00']));
  const drawer = (date, closed = false) => ({ date, status: closed ? 'closed' : 'open', opening_cash: '100.00',
    opened_at: '2026-11-23T00:00:00Z', closed_at: closed ? '2026-11-23T01:00:00Z' : null,
    actual_cash: closed ? '100.00' : null, closed_expected_cash: closed ? '100.00' : null,
    expected_cash: '100.00', variance: closed ? '0.00' : null, late_difference: closed ? '0.00' : null,
    breakdown, movements: [] });
  await context.route('http://localhost:12345/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/store-identity') return route.fulfill({ json: { binding_id: activeStore } });
    if (url.pathname === '/cash-drawer') return route.fulfill({ json: drawer(url.searchParams.get('date')) });
    if (url.pathname === '/cash-drawer/close') {
      const payload = JSON.parse(request.postData()); submissions.push(payload);
      if (submissions.length === 1) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: drawer(payload.date, true) });
    }
    const files = { '/drawer': 'drawer.html', '/drawer.js': 'drawer.js', '/offline-store.js': 'offline-store.js', '/inventory.css': 'inventory.css' };
    if (files[url.pathname]) return route.fulfill({ path: join(__dirname, '..', 'web', files[url.pathname]) });
    return route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage();
    await page.goto('http://localhost:12345/drawer');
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('ยืนยันคิว'));
    await page.evaluate(async store => { await PosOffline.bindStore(store); }, store);
    await page.locator('#drawer-queue-refresh').click();
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('ไม่พบรายการขายค้าง'));
    await page.evaluate(async store => {
      await PosOffline.put({ id: '22222222-2222-4222-8222-222222222222' }, store);
      await PosOffline.put({ id: '33333333-3333-4333-8333-333333333333' }, store, { reviewRequired: true });
    }, store);
    await page.locator('#drawer-queue-refresh').click();
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('2 รายการ'));
    activeStore = '44444444-4444-4444-8444-444444444444';
    await page.locator('#drawer-filter button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('ยืนยันคิว'));
    activeStore = store;
    await page.locator('#drawer-filter button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('2 รายการ'));
    await page.evaluate(() => { PosOffline.exportQueue = async () => { throw new Error('unavailable'); }; });
    await page.locator('#drawer-queue-refresh').click();
    await page.waitForFunction(() => document.querySelector('#drawer-queue-status').textContent.includes('ตรวจรายการขายค้างในเบราว์เซอร์นี้ไม่ได้'));
    await page.locator('#drawer-close [name=actual_cash]').fill('100');
    await page.locator('#drawer-close button[type=submit]').click();
    assert.equal(submissions.length, 0, 'acknowledgement is required');
    await page.locator('#drawer-close-ack').check();
    await page.locator('#drawer-close button[type=submit]').click();
    await page.locator('#drawer-pending:visible').waitFor();
    assert.equal(submissions.length, 1);
    assert.equal('ack' in submissions[0], false);
    await page.locator('#drawer-retry').click();
    await page.waitForFunction(() => document.querySelector('#drawer-close').hidden);
    assert.deepEqual(submissions[1], submissions[0], 'uncertain close retries the identical request');
    assert.equal((await page.evaluate(() => PosOffline.list())).length, 2, 'inspection never changes the sales queue');
  } finally { await context.close(); }
};
