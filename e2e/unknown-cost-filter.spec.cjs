const { test } = require('@playwright/test');
const exerciseUnknownCostFilter = require('./unknown-cost-filter-browser.cjs');

test('owner finds positive unknown-cost stock and can set its baseline', async ({ browser }) => {
  await exerciseUnknownCostFilter(browser);
});
