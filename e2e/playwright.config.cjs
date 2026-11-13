const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "*.spec.cjs",
  timeout: 60000,
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.POS_CHROMIUM_PATH },
  },
});
