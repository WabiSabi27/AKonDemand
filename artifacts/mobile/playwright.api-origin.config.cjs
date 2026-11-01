const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  testMatch: 'exported-api-origin.spec.cjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: '../../generated-artifacts/api-origin-browser',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 402, height: 874 },
    serviceWorkers: 'block',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
