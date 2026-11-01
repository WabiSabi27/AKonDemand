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
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName,
    use: {
      browserName,
      launchOptions: {
        executablePath: process.env[`PLAYWRIGHT_${browserName.toUpperCase()}_EXECUTABLE_PATH`] || undefined,
      },
    },
  })),
  use: {
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
