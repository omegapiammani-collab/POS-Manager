const { test } = require('@playwright/test');
const exerciseDebtSummary = require('./debt-summary-browser.cjs');

test('customer balances summary remains exact and supports filtering', async ({ browser }) => {
  await exerciseDebtSummary(browser);
});
