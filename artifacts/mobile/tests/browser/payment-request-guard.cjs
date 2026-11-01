async function mockPublicApi(context, { origin, id, respondToStatus, statusRequests, unexpected }) {
  // Fail closed, including the API host baked into the export. Even a real
  // status GET can reconcile payment state, so only static local assets pass.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      if (id && url.pathname === `/api/biz-accounts/${id}/status`) {
        statusRequests.push(url.pathname);
        return respondToStatus(route);
      }
      if (url.pathname === '/api/application-fees') {
        return route.fulfill({ json: { applicationFeeCents: 100, onboardingFeeCents: 200, currency: 'usd' } });
      }
      // Root AppProvider loads these public lists even on this public page.
      if (['/api/categories', '/api/businesses', '/api/services'].includes(url.pathname)) {
        return route.fulfill({ json: [] });
      }
    } else if (url.origin === origin && (
      request.isNavigationRequest()
      || ['script', 'stylesheet', 'font', 'image'].includes(request.resourceType())
    )) {
      return route.continue();
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
}

module.exports = { mockPublicApi };
