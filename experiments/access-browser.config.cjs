const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.',
  testMatch: 'access-browser.spec.cjs',
  timeout: 60000,
  workers: 1,
  use: { browserName: 'chromium', launchOptions: { executablePath: process.env.POS_CHROMIUM_PATH } },
});
