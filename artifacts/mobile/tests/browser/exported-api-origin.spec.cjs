const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'web-dist');
const obsoleteDomain = 'obsolete-preview.invalid';
const listPaths = ['/api/categories', '/api/services', '/api/businesses'];
const legacyPath = '/api/stripe/config';
const fixtureError = 'Isolated origin fixture: payment intentionally disabled';
const servers = [];
let exportBefore;

function fingerprint(directory = dist, prefix = '') {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name);
    const relative = `${prefix}${name}`;
    return fs.statSync(file).isDirectory()
      ? fingerprint(file, `${relative}/`)
      : [[relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  });
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  // Use the production build entry point, not a unit-test transpiler. Both
  // deployment-domain candidates are overwritten so no real preview is baked in.
  const buildOutput = execFileSync(process.execPath, [path.join(root, 'scripts/build-web.js')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    timeout: 150_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CI: '1',
      REPLIT_INTERNAL_APP_DOMAIN: obsoleteDomain,
      REPLIT_DEV_DOMAIN: obsoleteDomain,
      EXPO_PUBLIC_DOMAIN: obsoleteDomain,
      EXPO_PUBLIC_REPL_ID: '',
      REPL_ID: '',
    },
  });
  // Verify the actual build script selected our fixture domain. Do not require
  // the literal in the bundle: Metro may eliminate the native-only fallback
  // branch from an optimized web export.
  expect(buildOutput.split(/\r?\n/)).toContain(`Domain: ${obsoleteDomain}`);
  expect(buildOutput).toContain('Web export complete');
  exportBefore = fingerprint();

  // Load two instances of the real static server. Importing it avoids its
  // development rebuild-on-start branch: there must be exactly ONE export.
  for (let i = 0; i < 2; i += 1) {
    delete require.cache[require.resolve('../../server/serve-web')];
    const server = require('../../server/serve-web');
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
});

test.afterAll(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

test('one stale-domain Metro export uses each isolated page origin for generated and legacy clients', async ({ browser }) => {
  const origins = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  expect(origins[0]).not.toBe(origins[1]);

  for (const origin of origins) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const unexpected = [];
    const apiRequests = [];
    const pageErrors = [];
    const bundleHashes = new Map();
    try {
      // Install BEFORE navigation. Even an incorrect obsolete-host request is
      // aborted, never sent over the network or silently fulfilled as success.
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== 'GET' || url.origin !== origin) {
          unexpected.push(`${request.method()} ${url.href}`);
          return route.abort();
        }
        if (listPaths.includes(url.pathname) && !url.search) {
          apiRequests.push(url.href);
          return route.fulfill({ json: [] });
        }
        if (url.pathname === legacyPath && !url.search) {
          apiRequests.push(url.href);
          // Exercises apiGet -> API_BASE -> getLegacyApiBase in the real
          // checkout route without initializing Stripe or creating any payment.
          return route.fulfill({ status: 503, json: { error: fixtureError } });
        }
        if (!url.pathname.startsWith('/api/') && (
          (request.isNavigationRequest() && url.pathname === '/checkout')
          || /^\/_expo\/static\/.*\.(js|css)$/.test(url.pathname)
          || url.pathname.startsWith('/assets/')
          || url.pathname === '/favicon.ico'
        )) {
          return route.continue();
        }
        unexpected.push(`${request.method()} ${url.href}`);
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.endsWith('.js')) {
          // Save promises synchronously so all hashes are awaited below.
          bundleHashes.set(url.pathname, response.body().then(body =>
            createHash('sha256').update(body).digest('hex')));
        }
      });
      const response = await page.goto(`${origin}/checkout`);
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toBe('no-cache');
      await expect(page.getByText(`Could not load payment config: ${fixtureError}`, { exact: true })).toBeVisible();
      await expect.poll(() => new Set(apiRequests).size).toBe(4);
      expect([...new Set(apiRequests)].sort()).toEqual(
        [...listPaths, legacyPath].map(p => `${origin}${p}`).sort()
      );
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(bundleHashes.size).toBeGreaterThan(0);
      for (const [name, hash] of bundleHashes) {
        expect(await hash).toBe(exportBefore.find(([file]) => `/${file}` === name)?.[1]);
      }
    } finally {
      await context.close();
    }
  }
  // Neither server nor browser navigation may rewrite/rebuild the export.
  expect(fingerprint()).toEqual(exportBefore);
});
