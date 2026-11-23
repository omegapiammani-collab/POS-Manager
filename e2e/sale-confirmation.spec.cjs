const { test } = require('@playwright/test');
const exerciseSaleConfirmation = require('./sale-confirmation-browser.cjs');

test('matching ID with an incomplete sale keeps the original bill for retry', async ({ browser }) => {
  await exerciseSaleConfirmation(browser);
});
