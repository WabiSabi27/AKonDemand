// Production intentionally stays on the original sandbox until an explicit
// live launch. Do not fall back to the production connector: it is a different
// live account. Development continues to use its existing connector.
export async function getProductionTestCredentials() {
  const secretKey = process.env.STRIPE_TEST_SECRET_KEY?.trim();
  const publishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY?.trim();
  const expectedAccount = process.env.STRIPE_TEST_ACCOUNT_ID?.trim();

  if (!secretKey || !publishableKey) {
    throw new Error("Stripe test keys are missing from production secrets");
  }
  if (!/^sk_test_[A-Za-z0-9]+$/.test(secretKey) ||
      !/^pk_test_[A-Za-z0-9]+$/.test(publishableKey)) {
    throw new Error("Stripe production configuration requires test keys; live keys are forbidden");
  }
  if (!expectedAccount || !/^acct_[A-Za-z0-9]+$/.test(expectedAccount)) {
    throw new Error("Original Stripe test account identity is not configured");
  }

  // Verify the account before exposing credentials to checkout or the sync
  // library. Never log a response body, request headers, or the supplied keys.
  let response: Response;
  try {
    response = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Stripe test account verification is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Stripe test account verification failed: HTTP ${response.status}`);
  }
  let account: unknown;
  try {
    account = await response.json();
  } catch {
    throw new Error("Stripe test account verification returned an invalid response");
  }
  if (!account || typeof account !== "object" ||
      !("id" in account) || account.id !== expectedAccount) {
    throw new Error("Stripe test keys do not match the original sandbox account");
  }
  return { secretKey, publishableKey };
}
