/**
 * Old Stripe sessions keep their original /mobile/payment-return URLs forever.
 * Handle them before either server strips BASE_PATH or serves app content.
 * Keep the raw query string, including duplicate keys and encoded values.
 */
function redirectLegacyPaymentReturn(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = req.url || '/';
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (pathname !== '/mobile/payment-return' && pathname !== '/mobile/payment-return/') {
    return false;
  }

  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  res.writeHead(302, {
    location: `/payment-return${query}`,
    'cache-control': 'no-store',
  });
  res.end();
  return true;
}

module.exports = { redirectLegacyPaymentReturn };
