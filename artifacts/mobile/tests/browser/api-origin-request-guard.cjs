const listPaths = ['/api/categories', '/api/services', '/api/businesses'];
const legacyPath = '/api/stripe/config';
const fixtureError = 'Isolated origin fixture: payment intentionally disabled';

// Shared by the real exported-app check and its negative controls. Keep this
// installed before navigation so incorrect requests never leave the browser.
async function installApiOriginGuard(context, { origin, unexpected, apiRequests }) {
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
      // Exercise checkout's legacy client without initializing Stripe.
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
}

module.exports = { installApiOriginGuard, listPaths, legacyPath, fixtureError };
