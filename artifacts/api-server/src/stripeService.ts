import { storage } from './storage';
import { getUncachableStripeClient } from './stripeClient';

export class StripeService {
  async createCustomer(email: string, userId: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.customers.create({
      email,
      metadata: { userId },
    });
  }

  async createCheckoutSession(customerId: string, priceId: string, successUrl: string, cancelUrl: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
  }

  async createPaymentIntent(amount: number, currency: string, customerId: string, metadata: Record<string, string>) {
    const stripe = await getUncachableStripeClient();
    return await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata,
    });
  }

  async createCustomerPortalSession(customerId: string, returnUrl: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  async getProduct(productId: string) {
    return await storage.getProduct(productId);
  }

  async getSubscription(subscriptionId: string) {
    return await storage.getSubscription(subscriptionId);
  }

  // ─── Stripe Connect (Phase 2 #6) ────────────────────────────────────────
  // SPs onboard via Express to receive payouts; bookings are then charged
  // with destination charges + 8% application_fee_amount.

  /**
   * Create a Stripe Connect Express account for a service provider. Test-mode
   * Express defaults to US/USD and auto-requests card_payments + transfers
   * capabilities (we list them anyway for clarity). The returned `acct_…` id
   * is persisted on `businesses.stripeAccountId`.
   */
  async createConnectAccount(email: string, businessId: string, userId: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { businessId, userId },
    });
  }

  /**
   * Mint a one-shot Account Link that sends the SP through the hosted
   * Express onboarding flow. URL expires ~5 minutes after creation; refresh
   * URL is hit when the link goes stale and we re-mint.
   */
  async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
  }

  /**
   * Mint an Express dashboard login link so an onboarded SP can manage their
   * payout method, see balances, etc. Only valid for accounts in `active`
   * state — Stripe will 400 otherwise.
   */
  async createLoginLink(accountId: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.accounts.createLoginLink(accountId);
  }

  /** Retrieve a Connect account (used to refresh charges/payouts/requirements). */
  async retrieveAccount(accountId: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.accounts.retrieve(accountId);
  }

  /**
   * Retrieve the Connect account's Stripe balance (pending + available).
   * Performed against the connected account via `stripeAccount` header so the
   * SDK queries that account's books, not the platform's. Used by the SP
   * earnings dashboard to show "money Stripe is still holding before payout".
   */
  async retrieveConnectBalance(accountId: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.balance.retrieve({ stripeAccount: accountId });
  }

  /**
   * Create a destination-charge PaymentIntent for a booking.
   *
   * The customer is charged on the platform; Stripe automatically transfers
   * (totalCents - applicationFeeCents) to the SP's Connect account. The 8%
   * platform fee stays on the platform balance.
   *
   *   - `amount` = totalCents (price + platform fee, customer-facing).
   *   - `application_fee_amount` = the platform fee in cents.
   *   - `transfer_data.destination` = SP's `acct_…`.
   *
   * Card brands the SP's connected account doesn't support will surface as
   * StripeInvalidRequestError at confirm time — caller must surface that to
   * the user.
   */
  async createBookingPaymentIntent(args: {
    totalCents: number;
    applicationFeeCents: number;
    destinationAccountId: string;
    customerId: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();
    return await stripe.paymentIntents.create({
      amount: args.totalCents,
      currency: "usd",
      customer: args.customerId,
      automatic_payment_methods: { enabled: true },
      application_fee_amount: args.applicationFeeCents,
      transfer_data: { destination: args.destinationAccountId },
      metadata: args.metadata,
    });
  }

  /**
   * Refund a booking's PaymentIntent in full and reverse the application fee
   * back to the platform's balance (so the SP's Connect account is also
   * debited proportionally — otherwise the platform would absorb the full
   * refund cost while the SP keeps their cut).
   */
  async refundBookingPayment(paymentIntentId: string, amountCents?: number, idempotencyKey?: string) {
    const stripe = await getUncachableStripeClient();
    // Partial refund: pass `amount`. Stripe pro-rates the application-fee
    // refund proportionally when refund_application_fee=true, so the SP and
    // platform each give back their share of the refunded amount. Omitting
    // `amount` (default) is a full refund.
    //
    // `idempotencyKey` (Phase 3 #7) — when provided, Stripe deduplicates
    // refund creation across retries/races: two concurrent calls with the
    // same key return the SAME Refund object instead of creating two. We
    // pair this with a conditional DB claim so a duplicate cancel can never
    // produce a duplicate refund (see executeRefund).
    return await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
        ...(typeof amountCents === "number" && amountCents > 0 ? { amount: amountCents } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }
}

export const stripeService = new StripeService();
