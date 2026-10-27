import Stripe from 'stripe';
import { ReplitConnectors } from '@replit/connectors-sdk';
import { logger } from './lib/logger';
import { runStartupStep } from './lib/startup';
import { getProductionTestCredentials } from './lib/stripeTestCredentials';
import { configureStripeWebhook } from './lib/stripeWebhookLifecycle';

// Development's connector points to the original sandbox account.
// A production-labeled connection exists for a DIFFERENT account: selecting
// it automatically would strand existing products and paid checkout sessions.
const STRIPE_CONNECTION_ID = 'conn_stripe_01KXQ3MHMZ2FZ9D98JBGCMDY5P';

interface ConnectionResponse {
  id?: string;
  connector_name?: string;
  disabled?: boolean;
  settings?: {
    publishable?: string;
    secret?: string;
  };
  status?: string;
}

async function getCredentials() {
  if (process.env.NODE_ENV === 'production') {
    // One credential source per environment: production uses only the
    // explicitly supplied test keys, verified against the original account.
    return getProductionTestCredentials();
  }
  const connectors = new ReplitConnectors();
  // The old /connection/:id endpoint returns 404. Fetch the collection using
  // SDK-managed runtime identity, then resolve the configured connection.
  // Don't select the first Stripe connection or silently switch accounts.
  const url = new URL(connectors.getProxyUrl());
  url.pathname = url.pathname.replace(/\/proxy$/, '/connection');
  url.searchParams.set('connector_names', 'stripe');
  // Keep the development lookup scoped to the original sandbox connection.
  // A filter does not grant deployed identities access across environments.
  url.searchParams.set('environment', 'development');
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('limit', '100');

  const request = async () => fetch(url.toString(), {
    headers: {
      ...await connectors.getProxyHeaders('stripe'),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  let response = await request();
  // Mirror the SDK's retry on expired identity; don't cache credentials.
  if (response.status === 401) response = await request();

  if (!response.ok) {
    throw new Error(
      `Stripe connector lookup failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    items?: ConnectionResponse[];
    has_next_page?: boolean;
  };
  if (!Array.isArray(data.items) || data.has_next_page) {
    throw new Error('Stripe connection lookup returned an incomplete collection');
  }
  const matches = data.items.filter(connection =>
    connection.id === STRIPE_CONNECTION_ID &&
    connection.connector_name === 'stripe' &&
    !connection.disabled
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one configured Stripe connection; found ${matches.length}`);
  }
  const publishableKey = matches[0].settings?.publishable;
  const secretKey = matches[0].settings?.secret;

  if (
    typeof publishableKey !== 'string' || !publishableKey ||
    typeof secretKey !== 'string' || !secretKey
  ) {
    throw new Error('Configured Stripe connection credentials are missing');
  }

  return { publishableKey, secretKey };
}

export async function getUncachableStripeClient() {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, {
    // Pinned API version. Cast retained because the SDK's `LatestApiVersion`
    // literal type tracks the package's bundled version, which may not always
    // match this exact pin during SDK upgrades.
    apiVersion: '2025-08-27.basil' as Stripe.LatestApiVersion,
  });
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

export async function configureCurrentStripeWebhook(url: string) {
  return configureStripeWebhook({
    stripe: await getUncachableStripeClient(),
    store: await getStripeSync(),
    url,
    production: process.env.NODE_ENV === 'production',
    allowPreviewCreation: process.env.NODE_ENV === 'development' &&
      process.env.STRIPE_PREVIEW_WEBHOOK_CREATE === 'true',
  });
}

// `stripe-replit-sync` ships no type declarations; keeping the `any`-typed
// singleton here is the established pattern. Consumers are confined to
// `index.ts` (managed-webhook setup) and `webhookHandlers.ts` (event ingest).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stripeSync: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getStripeSync(): Promise<any> {
  if (!stripeSync) {
    const { StripeSync } = await runStartupStep({
      name: 'stripe-module-load',
      run: () => import('stripe-replit-sync'),
    }, logger);
    const secretKey = await runStartupStep({
      name: 'stripe-credential-lookup',
      // Read-only operation. Bound the entire lookup, including SDK identity
      // resolution and the single HTTP retry, not only fetch itself.
      timeoutMs: 25_000,
      run: getStripeSecretKey,
    }, logger);

    stripeSync = await runStartupStep({
      name: 'stripe-client-construction',
      run: async () => new StripeSync({
        poolConfig: {
          connectionString: process.env.DATABASE_URL!,
          max: 2,
        },
        stripeSecretKey: secretKey,
      }),
    }, logger);
  }
  return stripeSync;
}
