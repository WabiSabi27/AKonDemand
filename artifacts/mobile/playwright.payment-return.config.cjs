const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  testMatch: 'legacy-payment-return.spec.cjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: '../../generated-artifacts/payment-return-browser',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 402, height: 874 },
    serviceWorkers: 'block',
    // Nix environments may provide a wrapped system Chromium with its runtime
    // libraries rather than support Playwright's downloaded Linux binary.
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
