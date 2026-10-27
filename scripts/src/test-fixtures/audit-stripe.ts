import type Stripe from "stripe";
import { trace } from "./audit-trace";
import { credentialError, privateDiagnostics } from "./audit-errors";

trace("fake-stripe-loaded");
export async function getUncachableStripeClient() {
  if (process.env.AUDIT_FIXTURE_CASE === "stripe-private-connect") {
    throw credentialError("invalid_api_key");
  }
  let pages = 0;
  return {
    paymentIntents: {
      async retrieve(id: string) {
        trace("stripe-intent-read");
        if (process.env.AUDIT_FIXTURE_CASE === "stripe-private-inspection") {
          throw credentialError("resource_missing");
        }
        return { id, livemode: false, currency: "usd", latest_charge: "ch_fixture" };
      },
    },
    charges: {
      async list() {
        trace("stripe-charges-read");
        return { data: [{
          id: "ch_fixture", payment_intent: "pi_fixture", livemode: false,
          currency: "usd", amount_captured: 100, amount_refunded: 100, disputed: false,
        }], has_more: false };
      },
    },
    refunds: {
      async list(params: Stripe.RefundListParams) {
        trace("stripe-refunds-read");
        return { data: [{
          id: "re_fixture", charge: params.charge, payment_intent: "pi_fixture",
          currency: "usd", amount: 100, status: "succeeded",
        }], has_more: false };
      },
    },
    disputes: {
      async list() {
        trace("stripe-disputes-read");
        return { data: [], has_more: false };
      },
    },
    balance: {
      async retrieve() {
        trace("stripe-mode-read");
        if (process.env.AUDIT_FIXTURE_CASE === "stripe-private-mode") {
          throw credentialError(privateDiagnostics.join("\n"));
        }
        if (process.env.AUDIT_FIXTURE_CASE === "stripe-mode-mismatch") {
          return { livemode: true };
        }
        return { livemode: false };
      },
    },
    checkout: {
      sessions: {
        async list() {
          trace("stripe-page", { page: ++pages });
          if (pages > 1) throw credentialError("rate_limit");
          return {
            data: [{
              id: "cs_fixture_receipt", mode: "payment",
              payment_intent: "pi_fixture",
              payment_status: "paid", status: "complete",
              amount_total: 100, currency: "usd", livemode: false,
              created: 1_700_000_000,
              metadata: { bizAccountId: "fixture_account", feeType: "application" },
            } satisfies Partial<Stripe.Checkout.Session>],
            has_more: process.env.AUDIT_FIXTURE_CASE === "stripe-failure",
          };
        },
      },
    },
  };
}
