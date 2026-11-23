const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const product = (name, revenue, id = name) => ({
  product_id: id, name, base_unit: 'unit', quantity: '1', revenue,
  cost: '0.00', gross_profit: revenue, pending_cost_bills: 0, unknown_cost_bills: 0,
});
const summary = {
  revenue: '0.00', bill_count: 0, cost: '0.00', gross_profit: '0.00', expenses: '0.00',
  cash_drawer_expenses: '0.00', external_expenses: '0.00', profit_after_expenses: '0.00',
  cash: '0.00', qr: '0.00', credit: '0.00', debt_repayments_cash: '0.00', debt_repayments_qr: '0.00', pending_cost_bills: 0, unknown_cost_bills: 0,
};

async function csvNames(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#report-download-products').click(),
  ]);
  const csv = await readFile(await download.path(), 'utf8');
  return csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1).map(line => line.split(',')[0]);
}

async function names(page) {
  return page.locator('#report-products tr th').allTextContents();
}

test('product report sorts exact revenue, resolves ties and exports the displayed order', async ({ page }) => {
  const products = [
    product('Alpha', '9007199254740992.00'),
    product('Bravo', '9007199254740992.01'),
    product('Charlie', '20.00'),
    product('Delta', '20.00'),
  ];
  await page.route('http://pos.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/sales-report') {
      const from = url.searchParams.get('from');
      const rows = from === '2024-01-01' ? [product('Echo', '5.00'), product('Foxtrot', '10.00')] : products;
      return route.fulfill({ json: { from, to: url.searchParams.get('to'), summary, days: [], products: rows } });
    }
    const files = { '/reports': 'reports.html', '/reports.js': 'reports.js', '/csv.js': 'csv.js', '/inventory.css': 'inventory.css' };
    const file = files[url.pathname];
    if (!file) return route.fulfill({ status: 404 });
    return route.fulfill({ path: join(__dirname, '..', 'web', file) });
  });
  await page.goto('http://pos.test/reports');
  const sort = page.locator('#report-product-sort');
  await expect(page.locator('#report-products tr th')).toHaveText(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  await sort.selectOption('revenue');
  const revenueOrder = ['Bravo', 'Alpha', 'Charlie', 'Delta'];
  await expect(page.locator('#report-products tr th')).toHaveText(revenueOrder);
  expect(await csvNames(page)).toEqual(await names(page));
  await sort.selectOption('name');
  await expect(page.locator('#report-products tr th')).toHaveText(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  expect(await csvNames(page)).toEqual(await names(page));

  await sort.selectOption('revenue');
  await page.locator('input[name=from]').fill('2024-01-01');
  await page.locator('input[name=to]').fill('2024-01-02');
  await page.locator('#report-filters button[type=submit]').click();
  await expect(page.locator('#report-products tr th')).toHaveText(['Foxtrot', 'Echo']);
  expect(await csvNames(page)).toEqual(await names(page));
});
