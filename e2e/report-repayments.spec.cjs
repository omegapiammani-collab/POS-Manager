const { test } = require('@playwright/test');
const exerciseReportRepayments = require('./report-repayments-browser.cjs');

test('reports show gross debt receipts separately and preserve exact money', async ({ browser }) => {
  await exerciseReportRepayments(browser);
});
