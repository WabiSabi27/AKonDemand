import Stripe from 'stripe';

const STRIPE_CONNECTION_ID = 'conn_stripe_01KXQ3MHMZ2FZ9D98JBGCMDY5P';

interface ConnectionResponse {
  settings?: {
    publishable?: string;
    secret?: string;
  };
  status?: string;
}

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error('X-Replit-Token not found for repl/depl');
  }
  if (!hostname) {
    throw new Error('REPLIT_CONNECTORS_HOSTNAME is not set');
  }

  const url = new URL(
    `https://${hostname}/api/v2/connection/${STRIPE_CONNECTION_ID}`,
  );
  url.searchParams.set('include_secrets', 'true');

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Replit-Token': xReplitToken,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Stripe connector lookup failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as ConnectionResponse;
  const publishableKey = data.settings?.publishable;
  const secretKey = data.settings?.secret;

  if (!publishableKey || !secretKey) {
    throw new Error(`Stripe connection not found (id: ${STRIPE_CONNECTION_ID})`);
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
