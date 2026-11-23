const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function exerciseReportRepayments(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const totals = { revenue: '0.00', bill_count: 0, cost: '0.00', gross_profit: '0.00', expenses: '0.00',
    cash_drawer_expenses: '0.00', external_expenses: '0.00', profit_after_expenses: '-9007199254740992.01',
    cash: '0.00', qr: '0.00', credit: '0.00', debt_repayments_cash: '9007199254740992.01',
    debt_repayments_qr: '0.02', pending_cost_bills: 0, unknown_cost_bills: 0 };
  await context.route('http://localhost:12345/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/sales-report') return route.fulfill({ json: { from: '2026-11-10', to: '2026-11-10', summary: totals,
      days: [{ date: '2026-11-10', ...totals }], products: [] } });
    const files = { '/reports': 'reports.html', '/reports.js': 'reports.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
    return files[path] ? route.fulfill({ path: join(__dirname, '..', 'web', files[path]) }) : route.fulfill({ status: 404 });
  });
  try {
    const page = await context.newPage(); await page.goto('http://localhost:12345/reports');
    await page.locator('#report-results:visible').waitFor();
    const summary = await page.locator('#report-summary').textContent();
    assert.match(summary, /รับชำระหนี้เงินสด9,007,199,254,740,992\.01 บาท/);
    assert.match(summary, /รับชำระหนี้โอน0\.02 บาท/);
    assert.match(summary, /-9,007,199,254,740,992\.01 บาท/);
    assert.match(await page.locator('#report-days').textContent(), /9,007,199,254,740,992\.01/);
    assert.match(await page.locator('#report-summary-title').locator('..').textContent(), /ก่อนหักเงินคืน/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#report-download-days').click()]);
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /รับชำระหนี้เงินสดก่อนหักเงินคืน/);
    assert.match(csv, /9007199254740992\.01/);
    assert.match(csv, /0\.02/);
  } finally { await context.close(); }
};
