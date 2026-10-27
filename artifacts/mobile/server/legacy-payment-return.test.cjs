const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { redirectLegacyPaymentReturn } = require('./legacy-payment-return');

test('only the exact legacy GET/HEAD paths redirect', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
    for (const pathname of [
      '/payment-return',
      '/mobile/payment-return-other',
      '/mobile/payment-return/child',
      '/mobile/manifest',
      '/mobile/',
      '//example.com/mobile/payment-return',
      '/mobile/payment-return',
      '/mobile/payment-return/',
    ]) {
      const expected = ['GET', 'HEAD'].includes(method) &&
        ['/mobile/payment-return', '/mobile/payment-return/'].includes(pathname);
      const headers = [];
      const res = {
        writeHead: (...args) => headers.push(args),
        end() {},
      };
      assert.equal(redirectLegacyPaymentReturn({ method, url: pathname }, res), expected);
      assert.equal(headers.length, expected ? 1 : 0);
      if (expected) assert.equal(headers[0][1].location, '/payment-return');
    }
  }
});

for (const basePath of ['/', '/mobile/']) {
  for (const filename of ['./serve.js', './serve-web.js']) {
    test(`${filename} preserves legacy links with BASE_PATH=${basePath}`, async (t) => {
      const previousBasePath = process.env.BASE_PATH;
      process.env.BASE_PATH = basePath;
      delete require.cache[require.resolve(filename)];
      const server = require(filename);
      if (previousBasePath === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = previousBasePath;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const queries = [
        '',
        '?success=true&id=ba_existing_paid&session=cs_test_existing',
        '?cancelled=true&id=ba_existing_paid',
        '?id=ba_existing_paid&success=true&cancelled=false&session=cs_test_existing&extra=a%2Fb+%26&extra=%E2%9C%93&empty=&flag&return=https%3A%2F%2Fexample.com',
      ];
      for (const method of ['GET', 'HEAD']) {
        for (const pathname of ['/mobile/payment-return', '/mobile/payment-return/']) {
          for (const query of queries) {
            const response = await fetch(`${origin}${pathname}${query}`, {
              method,
              redirect: 'manual',
            });
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), `/payment-return${query}`);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(await response.text(), '');
          }
        }
      }
    });
  }
}
