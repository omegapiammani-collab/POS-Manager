const { test } = require('@playwright/test');
const exerciseDrawerQueue = require('./drawer-queue-browser.cjs');

test('drawer close shows local offline queue and preserves close retry', async ({ browser }) => {
  await exerciseDrawerQueue(browser);
});
