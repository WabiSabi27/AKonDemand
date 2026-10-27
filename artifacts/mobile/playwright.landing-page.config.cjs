const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  testMatch: 'landing-page.spec.cjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15_000,
  outputDir: '../../generated-artifacts/landing-page-browser',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    serviceWorkers: 'block',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
