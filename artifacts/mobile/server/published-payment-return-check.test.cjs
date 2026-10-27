const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkPublishedPaymentReturn } = require('../scripts/check-published-payment-return.cjs');

function fixture({ legacyStatus = 302, destinationStatus = 200, loseQuery = false, paidAt = '2026-01-01T00:00:00Z', changePayment = false } = {}) {
  const calls = [];
  let statusReads = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    calls.push(url.pathname);
    if (url.pathname === '/api/biz-accounts/ba_paid_fixture/status') {
      statusReads++;
      return Response.json({
        id: 'ba_paid_fixture', status: 'pending', paidAt,
        applicationPayment: { amountCents: changePayment && statusReads > 1 ? 200 : 100, currency: 'usd' },
      });
    }
    if (url.pathname.startsWith('/mobile/payment-return')) {
      return new Response('', { status: legacyStatus, headers: {
        location: `/payment-return${loseQuery ? '' : url.search}`, 'cache-control': 'no-store',
      } });
    }
    assert.equal(url.pathname, '/payment-return');
    return new Response('<html><body>Application</body></html>', {
      status: destinationStatus, headers: { 'content-type': 'text/html' },
    });
  };
  return { fetchImpl, calls };
}

test('read-only check covers both outcomes and slash variants with paid status unchanged', async () => {
  const { fetchImpl, calls } = fixture();
  const result = await checkPublishedPaymentReturn({
    origin: 'https://example.com', paidApplicationId: 'ba_paid_fixture', confirmedPaidSandbox: true, fetchImpl,
  });
  assert.equal(result.results.length, 4);
  assert.equal(result.paidApplicationVerified, true);
  assert.equal(calls.length, 10);
});

test('route-only mode explicitly does not claim paid application verification', async () => {
  const { fetchImpl, calls } = fixture();
  const result = await checkPublishedPaymentReturn({ origin: 'https://example.com', fetchImpl });
  assert.equal(result.paidApplicationVerified, false);
  assert.ok(!calls.some((path) => path.startsWith('/api/')));
});

for (const [name, settings] of [
  ['old path 404', { legacyStatus: 404 }],
  ['lost query', { loseQuery: true }],
  ['second redirect', { destinationStatus: 302 }],
  ['unconfirmed payment', { paidAt: null }],
  ['changed payment', { changePayment: true }],
]) {
  test(`fails explicitly on ${name}`, async () => {
    await assert.rejects(checkPublishedPaymentReturn({
      origin: 'https://example.com', paidApplicationId: 'ba_paid_fixture', confirmedPaidSandbox: true,
      fetchImpl: fixture(settings).fetchImpl,
    }));
  });
}
