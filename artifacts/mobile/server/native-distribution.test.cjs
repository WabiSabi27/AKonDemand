const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const template = fs.readFileSync(path.join(__dirname, 'templates/landing-page.html'), 'utf8');
const appName = 'Native Distribution Fixture';
const manifests = {
  ios: { id: 'fixture-ios', runtimeVersion: '1', launchAsset: { url: '/ios/bundle.js' } },
  android: { id: 'fixture-android', runtimeVersion: '1', launchAsset: { url: '/android/bundle.js' } },
};
const assets = [
  ['ios/bundle.js', 'application/javascript; charset=utf-8', Buffer.from('// ios fixture\n')],
  ['android/bundle.js', 'application/javascript; charset=utf-8', Buffer.from('// android fixture\n')],
  ['assets/style.css', 'text/css; charset=utf-8', Buffer.from('body { margin: 0; }\n')],
  ['assets/icon.png', 'image/png', Buffer.from([137, 80, 78, 71, 0, 255])],
  ['assets/data.json', 'application/json; charset=utf-8', Buffer.from('{"fixture":true}\n')],
  ['assets/font.woff2', 'font/woff2', Buffer.from([0, 1, 128, 255])],
  ['assets/unknown.bin', 'application/octet-stream', Buffer.from([0, 255, 1, 254])],
  ['payment-return-other', 'application/octet-stream', Buffer.from('not a payment redirect')],
];

async function startFixture(t, basePath) {
  // Copy the real entry point and its dependencies instead of changing its
  // static root or writing anything into the app's actual static-build tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-distribution-'));
  const serverDir = path.join(root, 'server');
  const staticRoot = path.join(root, 'static-build');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(serverDir, 'templates'), { recursive: true });
  for (const file of ['serve.js', 'legacy-payment-return.js']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(serverDir, file));
  }
  fs.writeFileSync(path.join(serverDir, 'templates/landing-page.html'), template);
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ expo: { name: appName } }));
  for (const [platform, manifest] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(staticRoot, platform), { recursive: true });
    fs.writeFileSync(path.join(staticRoot, platform, 'manifest.json'), JSON.stringify(manifest));
  }
  for (const [filename, , bytes] of assets) {
    const target = path.join(staticRoot, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  const previousBasePath = process.env.BASE_PATH;
  let server;
  try {
    process.env.BASE_PATH = basePath;
    server = require(path.join(serverDir, 'serve.js'));
  } finally {
    if (previousBasePath === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = previousBasePath;
  }
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    for (const file of ['serve.js', 'legacy-payment-return.js']) {
      delete require.cache[path.join(serverDir, file)];
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    staticRoot,
    host: new URL(origin).host,
    request: (route, options = {}) => fetch(`${origin}${route}`, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    }),
  };
}

function assertNotRedirected(response) {
  assert.equal(response.headers.get('location'), null);
}

for (const basePath of ['/', '/mobile/']) {
  test(`native distribution with BASE_PATH=${basePath}`, async (t) => {
    const { request, staticRoot, host: nativeHost } = await startFixture(t, basePath);
    // A mounted native service must still accept unprefixed upstream requests.
    const prefixes = basePath === '/' ? ['/'] : ['/mobile/', '/'];

    await t.test('iOS and Android receive their own manifests and Expo protocol headers', async () => {
      for (const prefix of prefixes) {
        for (const route of ['', 'manifest']) {
          for (const platform of ['ios', 'android']) {
            const response = await request(`${prefix}${route}?cache=fixture`, {
              headers: { 'expo-platform': platform },
            });
            assert.equal(response.status, 200);
            assertNotRedirected(response);
            assert.equal(response.headers.get('content-type'), 'application/json');
            assert.equal(response.headers.get('expo-protocol-version'), '1');
            assert.equal(response.headers.get('expo-sfv-version'), '0');
            assert.deepEqual(await response.json(), manifests[platform]);
          }
        }
      }
    });

    await t.test('browser landing page renders the real template, app name, and Expo links', async () => {
      for (const prefix of prefixes) {
        for (const platform of [undefined, 'web']) {
          for (const forwarded of [false, true]) {
            const headers = {};
            if (platform) headers['expo-platform'] = platform;
            if (forwarded) {
              headers['x-forwarded-host'] = 'public.example.test';
              headers['x-forwarded-proto'] = 'http';
            }
            const response = await request(prefix, { headers });
            assert.equal(response.status, 200);
            assertNotRedirected(response);
            assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
            const host = forwarded ? 'public.example.test' : nativeHost;
            const expected = template
              .replace(/BASE_URL_PLACEHOLDER/g, `${forwarded ? 'http' : 'https'}://${host}`)
              .replace(/EXPS_URL_PLACEHOLDER/g, host)
              .replace(/APP_NAME_PLACEHOLDER/g, appName);
            const html = await response.text();
            assert.equal(html, expected);
            assert.ok(html.includes(`<title>${appName}</title>`));
            assert.ok(html.includes(`href="exps://${host}"`));
            assert.ok(html.includes('https://apps.apple.com/app/id982107779'));
            assert.ok(html.includes('https://play.google.com/store/apps/details?id=host.exp.exponent'));
            assert.doesNotMatch(html, /(?:APP_NAME|BASE_URL|EXPS_URL)_PLACEHOLDER/);
          }
        }
      }
    });

    await t.test('static assets retain exact bytes and MIME types, including HEAD requests', async () => {
      for (const prefix of prefixes) {
        for (const [filename, contentType, bytes] of assets) {
          for (const method of ['GET', 'HEAD']) {
            const response = await request(`${prefix}${filename}?v=fixture`, {
              method,
              headers: { 'expo-platform': 'ios' },
            });
            assert.equal(response.status, 200, `${method} ${prefix}${filename}`);
            assertNotRedirected(response);
            assert.equal(response.headers.get('content-type'), contentType);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : bytes);
          }
        }
      }
    });

    await t.test('missing files, directories, and non-native manifest requests remain 404s', async () => {
      for (const prefix of prefixes) {
        for (const route of ['assets/missing.png', 'assets/', 'missing-route', 'payment-return', 'payment-return/child', 'manifest']) {
          if (`${prefix}${route}` === '/mobile/payment-return') continue;
          for (const platform of [undefined, 'web']) {
            const response = await request(`${prefix}${route}`, {
              headers: platform ? { 'expo-platform': platform } : {},
            });
            assert.equal(response.status, 404, `${prefix}${route}`);
            assertNotRedirected(response);
            assert.equal(await response.text(), 'Not Found');
          }
        }
      }
    });

    await t.test('legacy payment redirect still runs before native manifest/static routing', async () => {
      const query = '?cancelled=true&id=fixture&extra=a%2Fb&extra=two';
      for (const route of ['/mobile/payment-return', '/mobile/payment-return/']) {
        for (const platform of ['ios', 'android']) {
          const response = await request(`${route}${query}`, { headers: { 'expo-platform': platform } });
          assert.equal(response.status, 302);
          assert.equal(response.headers.get('location'), `/payment-return${query}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.equal(await response.text(), '');
        }
      }
    });

    await t.test('missing platform manifests return JSON errors, not landing pages or redirects', async () => {
      // Only these disposable fixture files are removed.
      for (const platform of ['ios', 'android']) {
        fs.unlinkSync(path.join(staticRoot, platform, 'manifest.json'));
        for (const prefix of prefixes) {
          for (const route of ['', 'manifest']) {
            const response = await request(`${prefix}${route}`, { headers: { 'expo-platform': platform } });
            assert.equal(response.status, 404);
            assertNotRedirected(response);
            assert.equal(response.headers.get('content-type'), 'application/json');
            assert.deepEqual(await response.json(), { error: `Manifest not found for platform: ${platform}` });
          }
        }
      }
    });
  });
}

test('published /mobile/ remains assigned to native distribution, separately from the root website', () => {
  const config = fs.readFileSync(path.join(__dirname, '../.replit-artifact/artifact.toml'), 'utf8');
  const services = config.split('[[services]]').slice(1);
  const native = services.find((service) => /^\s*name\s*=\s*"expo"\s*$/m.test(service));
  const web = services.find((service) => /^\s*name\s*=\s*"web"\s*$/m.test(service));
  assert.ok(native, 'Native Expo service must remain configured');
  assert.ok(web, 'Root website service must remain configured separately');
  assert.match(native, /^\s*paths\s*=\s*\[\s*"\/mobile\/"\s*\]\s*$/m);
  assert.match(native, /^\s*BASE_PATH\s*=\s*"\/mobile\/"\s*$/m);
  assert.match(native, /\[services\.production\]\s*[\s\S]*?run\s*=\s*\[\s*"pnpm",\s*"--filter",\s*"@workspace\/mobile",\s*"run",\s*"serve"\s*\]/);
  assert.match(web, /^\s*paths\s*=\s*\[\s*"\/"\s*\]\s*$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts.serve, 'node server/serve.js');
});
