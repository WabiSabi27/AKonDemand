import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getProxyHeaders } = vi.hoisted(() => {
  // Global setup imports the app (and this client) before test mocks run.
  vi.resetModules();
  return { getProxyHeaders: vi.fn(async () => ({ 'X-Replit-Token': 'test-identity' })) };
});

vi.mock('@replit/connectors-sdk', () => ({
  ReplitConnectors: class {
    getProxyUrl() { return 'https://connectors.example/api/v2/proxy'; }
    getProxyHeaders = getProxyHeaders;
  },
}));

import { getStripePublishableKey, getStripeSecretKey, getUncachableStripeClient } from '../src/stripeClient';

// Synthetic credentials only: no network requests or real secrets.
const dev = {
  id: 'conn_stripe_01KXQ3MHMZ2FZ9D98JBGCMDY5P',
  connector_name: 'stripe',
  environment: 'development',
  settings: { publishable: 'pk_test_fake_dev', secret: 'sk_test_fake_dev' },
};
const prod = {
  id: 'different-stripe-account',
  connector_name: 'stripe',
  environment: 'production',
  settings: { publishable: 'pk_test_fake_prod', secret: 'sk_test_fake_prod' },
};

describe('Stripe runtime connection lookup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getProxyHeaders.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function collection(items: object[], extra = {}) {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ items, ...extra }), { status: 200 })
    );
  }

  it('uses the collection API and SDK identity, not the removed individual endpoint', async () => {
    collection([prod, dev]);
    expect(await getStripePublishableKey()).toBe(dev.settings.publishable);
    const [rawUrl, options] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe('/api/v2/connection');
    expect(url.searchParams.get('connector_names')).toBe('stripe');
    expect(url.searchParams.get('environment')).toBe('development');
    expect(url.searchParams.get('include_secrets')).toBe('true');
    expect(options.headers['X-Replit-Token']).toBe('test-identity');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves the existing development account, independent of collection order', async () => {
    collection([dev, prod]);
    expect(await getStripeSecretKey()).toBe(dev.settings.secret);
    expect(await getStripePublishableKey()).toBe(dev.settings.publishable);
  });

  it('explicitly scopes development to its original connection', async () => {
    fetchMock.mockImplementation(async (rawUrl: string) => {
      const environment = new URL(rawUrl).searchParams.get('environment') ?? 'production';
      return new Response(JSON.stringify({
        items: environment === 'development' ? [dev] : [prod],
      }), { status: 200 });
    });
    expect(await getStripeSecretKey()).toBe(dev.settings.secret);
  });

  it('never substitutes a different account when the configured connection is absent', async () => {
    collection([prod]);
    await expect(getStripeSecretKey()).rejects.toThrow('configured Stripe connection; found 0');
  });

  it('ignores disabled connections and other providers', async () => {
    collection([dev, { ...dev, disabled: true }, { ...dev, connector_name: 'other' }]);
    expect(await getStripeSecretKey()).toBe(dev.settings.secret);
  });

  it('fails rather than choosing silently between multiple connections', async () => {
    collection([dev, { ...dev }]);
    await expect(getStripeSecretKey()).rejects.toThrow('configured Stripe connection; found 2');
  });

  it('rejects missing credentials without exposing returned connection data', async () => {
    collection([{ ...dev, settings: { secret: 'private-placeholder' } }]);
    await expect(getStripeSecretKey()).rejects.toThrow('credentials are missing');
  });

  it('rebuilds runtime identity and retries once on 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [dev] }), { status: 200 }));
    expect(await getStripeSecretKey()).toBe(dev.settings.secret);
    expect(getProxyHeaders).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly on a lookup error without echoing the response body', async () => {
    fetchMock.mockResolvedValue(new Response('private-placeholder', { status: 404, statusText: 'Not Found' }));
    await expect(getStripeSecretKey()).rejects.toThrow('Stripe connector lookup failed: 404 Not Found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete paginated collection', async () => {
    collection([dev], { has_next_page: true });
    await expect(getStripeSecretKey()).rejects.toThrow('incomplete collection');
  });

  it('retrieves fresh credentials for successive clients', async () => {
    collection([dev]);
    await getUncachableStripeClient();
    await getUncachableStripeClient();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses only supplied test keys in production, even when the connector is inaccessible', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_test_synthetic');
    vi.stubEnv('STRIPE_TEST_PUBLISHABLE_KEY', 'pk_test_synthetic');
    vi.stubEnv('STRIPE_TEST_ACCOUNT_ID', 'acct_original');
    fetchMock.mockImplementation(async (url: string) => {
      expect(url).toBe('https://api.stripe.com/v1/account');
      return new Response(JSON.stringify({ id: 'acct_original' }), { status: 200 });
    });
    expect(await getStripeSecretKey()).toBe('sk_test_synthetic');
    expect(await getStripePublishableKey()).toBe('pk_test_synthetic');
    await getUncachableStripeClient();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getProxyHeaders).not.toHaveBeenCalled();
  });
});
