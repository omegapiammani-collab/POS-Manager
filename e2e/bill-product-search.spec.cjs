const { test } = require('@playwright/test');
const exerciseBillProductSearch = require('./bill-product-search-browser.cjs');

test('bill history searches original product names and exports matching rows', async ({ browser }) => {
  await exerciseBillProductSearch(browser);
});
