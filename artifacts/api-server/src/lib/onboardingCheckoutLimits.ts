import type Stripe from "stripe";

export const ONBOARDING_LOCK_WAIT_MS = 1_000;
export const ONBOARDING_NETWORK_BUDGET_MS = 10_000;

export class OnboardingCheckoutUnavailable extends Error {
  constructor() {
    super("Onboarding checkout is temporarily unavailable");
    this.name = "OnboardingCheckoutUnavailable";
  }
}

/** Bound credential reads and the entire sequence of Stripe requests. */
export function onboardingCheckoutBudget(timeoutMs = ONBOARDING_NETWORK_BUDGET_MS) {
  // Wall-clock corrections must not shorten or extend this request's budget.
  const deadline = performance.now() + timeoutMs;
  const requestOptions = (): Stripe.RequestOptions => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new OnboardingCheckoutUnavailable();
    // Stripe ignores fractional timeouts; zero would disable its HTTP timeout.
    return { timeout: Math.ceil(remaining), maxNetworkRetries: 0 };
  };
  return {
    requestOptions,
    // Only race read-only credential resolution. Mutating Stripe requests use
    // the SDK's HTTP timeout, never an uncancelled Promise.race.
    async read<T>(operation: () => Promise<T>): Promise<T> {
      const timeout = requestOptions().timeout!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new OnboardingCheckoutUnavailable()), timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function isOnboardingCheckoutUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if (current instanceof OnboardingCheckoutUnavailable) return true;
    const value = current as {
      code?: string; type?: string; statusCode?: number; cause?: unknown;
    };
    if (
      value.code === "55P03" || value.code === "57014" ||
      value.code === "ETIMEDOUT" || value.code === "idempotency_key_in_use" ||
      value.type === "StripeConnectionError" || value.statusCode === 429 ||
      (value.statusCode !== undefined && value.statusCode >= 500)
    ) return true;
    current = value.cause;
  }
  return false;
}
