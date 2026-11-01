const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { installApiOriginGuard, listPaths, legacyPath, fixtureError } = require('./api-origin-request-guard.cjs');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'web-dist');
const obsoleteDomain = 'obsolete-preview.invalid';
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
      await installApiOriginGuard(context, { origin, unexpected, apiRequests });
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

async function startRecorder(label) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url === '/checkout') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Origin guard fixture</body></html>');
      return;
    }
    // A reachable, CORS-enabled success response makes accidental leakage
    // observable instead of letting an unrelated CORS failure pass the test.
    response.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify({ recorder: label }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` };
}

const blockedRequests = [
  ...[...listPaths, legacyPath].map(requestPath => ({
    label: `wrong-origin GET ${requestPath}`,
    requestPath, method: 'GET', wrongOrigin: true,
  })),
  ...[listPaths[0], legacyPath].map(requestPath => ({
    label: `same-origin POST ${requestPath}`,
    requestPath, method: 'POST', wrongOrigin: false,
  })),
];

for (const { label, requestPath, method, wrongOrigin } of blockedRequests) {
  test(`request guard aborts and reports ${label} without reaching a recorder`, async ({ browser }) => {
    const recorders = [];
    let context;
    try {
      recorders.push(await startRecorder('current'));
      recorders.push(await startRecorder('other'));
      const [current, other] = recorders;
      expect(current.origin).not.toBe(other.origin);

      // Prove the other listener is reachable, then clear only this probe.
      const probe = await fetch(`${other.origin}/probe`);
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({ recorder: 'other' });
      expect(other.requests).toEqual([{ method: 'GET', path: '/probe' }]);
      other.requests.length = 0;

      context = await browser.newContext({ serviceWorkers: 'block' });
      const unexpected = [];
      const apiRequests = [];
      await installApiOriginGuard(context, { origin: current.origin, unexpected, apiRequests });
      const page = await context.newPage();
      const navigation = await page.goto(`${current.origin}/checkout`);
      expect(navigation.status()).toBe(200);
      expect(current.requests).toEqual([{ method: 'GET', path: '/checkout' }]);
      expect(unexpected).toEqual([]);

      const url = `${wrongOrigin ? other.origin : current.origin}${requestPath}`;
      const responses = [];
      page.on('response', response => {
        if (response.url() === url) responses.push(response.status());
      });
      const failedRequest = page.waitForEvent('requestfailed', {
        predicate: request => request.url() === url && request.method() === method,
      });
      const result = await page.evaluate(async ({ url, method }) => {
        try {
          const response = await fetch(url, {
            method,
            ...(method === 'POST' ? { body: 'synthetic mutation; must never be delivered' } : {}),
          });
          return { kind: 'response', status: response.status, body: await response.text() };
        } catch (error) {
          return { kind: 'error', name: error.name };
        }
      }, { url, method });

      expect(result).toEqual({ kind: 'error', name: 'TypeError' });
      expect((await failedRequest).failure().errorText).toContain('ERR_FAILED');
      expect(unexpected).toEqual([`${method} ${url}`]);
      expect(apiRequests).toEqual([]);
      expect(responses).toEqual([]);
      expect(other.requests).toEqual([]);
      expect(current.requests).toEqual([{ method: 'GET', path: '/checkout' }]);
    } finally {
      await Promise.all([
        ...(context ? [context.close()] : []),
        ...recorders.map(({ server }) => new Promise(resolve => {
          server.close(resolve);
          server.closeAllConnections();
        })),
      ]);
    }
  });
}
