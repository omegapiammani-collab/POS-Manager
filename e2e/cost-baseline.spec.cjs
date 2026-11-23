const { test } = require('@playwright/test');
const exerciseCostBaseline = require('./cost-baseline-browser.cjs');

test('cost baseline survives ambiguous response and serializes tabs', async ({ browser }) => {
  await exerciseCostBaseline(browser);
});
