const { once } = require('node:events');
const { test, expect } = require('@playwright/test');

let server;
let origin;

test.beforeAll(async () => {
  // The actual published web server and Expo export, not a replacement router.
  // No API server or database is needed. Always build first via the package script.
  server = require('../../server/serve-web');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (!server?.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
});

async function mockPublicApi(context, { id, respondToStatus, statusRequests, unexpected }) {
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

const cases = [
  { name: 'paid application', flag: 'success=true', status: 'pending', title: 'Application received!' },
  { name: 'activated account', flag: 'success=true', status: 'approved', title: "You're all set!" },
  { name: 'unpaid cancellation', flag: 'cancelled=true', status: 'awaiting_payment', title: 'Payment cancelled' },
  // An old cancellation link must not override a payment already persisted.
  { name: 'already-paid cancellation', flag: 'cancelled=true', status: 'pending', title: 'Application received!' },
];

for (const suffix of ['', '/']) {
  for (const scenario of cases) {
    test(`${scenario.name} through /mobile/payment-return${suffix}`, async ({ page, context }) => {
      const id = `ba_browser_${scenario.status}_${scenario.flag.startsWith('success') ? 'success' : 'cancel'}`;
      const paid = scenario.status !== 'awaiting_payment';
      const status = {
        id, status: scenario.status,
        paidAt: paid ? '2026-09-01T12:00:00Z' : null,
        // Deliberately different from current pricing: render persisted receipts.
        applicationPayment: paid ? { amountCents: 1900, currency: 'usd' } : null,
        onboardingPayment: scenario.status === 'approved' ? { amountCents: 6400, currency: 'cad' } : null,
      };
      const snapshot = JSON.stringify(status);
      const statusRequests = [];
      const unexpected = [];
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));

      // Fail closed: intercept ALL traffic before navigation, including calls to
      // the API domain baked into the export. Never let a status GET reconcile
      // a real application, and never permit Checkout or other mutations.
      await mockPublicApi(context, {
        id, statusRequests, unexpected,
        respondToStatus: route => route.fulfill({ json: status }),
      });

      // A new context per test has no stored application id or signed-in user:
      // the real router MUST get the id from the redirected query string.
      const query = `?${scenario.flag}&id=${id}&session=cs_test_browser_only&extra=a%2Fb+%26&extra=%E2%9C%93&empty=&flag`;
      const response = await page.goto(`${origin}/mobile/payment-return${suffix}${query}`);
      expect(response.status()).toBe(200);
      const redirectedFrom = response.request().redirectedFrom();
      expect(redirectedFrom.url()).toBe(`${origin}/mobile/payment-return${suffix}${query}`);
      expect(redirectedFrom.redirectedFrom()).toBeNull();
      const redirect = await redirectedFrom.response();
      expect(redirect.status()).toBe(302);
      expect(redirect.headers()['location']).toBe(`/payment-return${query}`);
      expect(redirect.headers()['cache-control']).toBe('no-store');
      expect(page.url()).toBe(`${origin}/payment-return${query}`);

      await expect(page.getByText(scenario.title, { exact: true })).toBeVisible();
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Payment is still processing', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Confirming your payment…', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^Pay .* onboarding fee$/)).toHaveCount(0);
      if (paid) {
        await expect(page.getByText('Application fee paid: $19.00', { exact: true })).toBeVisible();
        await expect(page.getByText('Application fee paid: $1.00', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Payment cancelled', { exact: true })).toHaveCount(0);
        if (scenario.status === 'approved') {
          await expect(page.getByText('Onboarding fee paid: CA$64.00', { exact: true })).toBeVisible();
        }
      } else {
        await expect(page.getByText(/Application checkout was closed before payment was confirmed/)).toBeVisible();
        await expect(page.getByText(/Application fee paid:/)).toHaveCount(0);
      }
      expect(statusRequests).toEqual([`/api/biz-accounts/${id}/status`]);
      expect(JSON.stringify(status)).toBe(snapshot);
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }

  test(`missing application id through /mobile/payment-return${suffix}`, async ({ page, context }) => {
    const statusRequests = [];
    const unexpected = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await mockPublicApi(context, { statusRequests, unexpected });

    // Playwright supplies a fresh context: no fallback id or signed-in account.
    const query = '?success=true';
    await page.goto(`${origin}/mobile/payment-return${suffix}${query}`);
    expect(page.url()).toBe(`${origin}/payment-return${query}`);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await expect(page.getByText('Something went wrong', { exact: true })).toBeVisible();
    await expect(page.getByText('No application id found. Please start over from the sign-up flow.', { exact: true })).toBeVisible();
    await expect(page.getByText('Check application status', { exact: true })).toBeVisible();
    await expect(page.getByText('Confirming your payment…', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Pay .* onboarding fee$/)).toHaveCount(0);
    expect(statusRequests).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  for (const persistedStatus of ['pending', 'approved']) {
    test(`cancelled status error recovers to ${persistedStatus} through /mobile/payment-return${suffix}`, async ({ page, context }) => {
      const id = `ba_browser_recovery_${persistedStatus}`;
      const status = {
        id, status: persistedStatus, paidAt: '2026-09-01T12:00:00Z',
        applicationPayment: { amountCents: 1900, currency: 'usd' },
        onboardingPayment: persistedStatus === 'approved' ? { amountCents: 6400, currency: 'cad' } : null,
      };
      const snapshot = JSON.stringify(status);
      const statusRequests = [];
      const unexpected = [];
      const pageErrors = [];
      let recovered = false;
      page.on('pageerror', error => pageErrors.push(error.message));
      await context.addInitScript(() => {
        window.checkoutOpenAttempts = 0;
        window.open = () => { window.checkoutOpenAttempts += 1; return null; };
      });
      await mockPublicApi(context, {
        id, statusRequests, unexpected,
        respondToStatus: route => recovered
          ? route.fulfill({ json: status })
          : route.fulfill({ status: 503, json: { message: 'Temporarily unavailable' } }),
      });

      const query = `?cancelled=true&id=${id}`;
      await page.goto(`${origin}/mobile/payment-return${suffix}${query}`);
      expect(page.url()).toBe(`${origin}/payment-return${query}`);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      await expect(page.getByText('Something went wrong', { exact: true })).toBeVisible();
      await expect(page.getByText('Could not refresh your application status. Your application has been kept. Check its status before continuing.', { exact: true })).toBeVisible();
      await expect(page.getByText('Payment cancelled', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Application received!', { exact: true })).toHaveCount(0);
      await expect(page.getByText("You're all set!", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^Pay .* onboarding fee$/)).toHaveCount(0);
      await expect(page.getByText('Opening secure checkout…', { exact: true })).toHaveCount(0);
      expect(statusRequests).toEqual([`/api/biz-accounts/${id}/status`]);

      recovered = true;
      await page.getByText('Check application status', { exact: true }).click();
      await expect(page.getByText(persistedStatus === 'pending' ? 'Application received!' : "You're all set!", { exact: true })).toBeVisible();
      await expect(page.getByText('Application fee paid: $19.00', { exact: true })).toBeVisible();
      if (persistedStatus === 'approved') {
        await expect(page.getByText('Onboarding fee paid: CA$64.00', { exact: true })).toBeVisible();
      }
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Payment cancelled', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Confirming your payment…', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^Pay .* onboarding fee$/)).toHaveCount(0);
      await expect(page.getByText('Opening secure checkout…', { exact: true })).toHaveCount(0);
      expect(statusRequests).toEqual(Array(2).fill(`/api/biz-accounts/${id}/status`));
      expect(page.url()).toBe(`${origin}/payment-return${query}`);
      expect(await page.evaluate(() => window.checkoutOpenAttempts)).toBe(0);
      expect(context.pages()).toHaveLength(1);
      expect(JSON.stringify(status)).toBe(snapshot);
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}
