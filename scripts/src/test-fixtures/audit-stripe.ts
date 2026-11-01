import type Stripe from "stripe";
import { trace } from "./audit-trace";
import { credentialError, privateDiagnostics } from "./audit-errors";
import type { AuditReadOptions } from "../auditDeadline";

trace("fake-stripe-loaded");
const fixtureCase = process.env.AUDIT_FIXTURE_CASE;
let releaseLatePage: (() => void) | undefined;

// The database fixture calls this only after cancellation enters pool shutdown.
// Keep shutdown pending long enough for resumed scan work to become observable.
export async function deliverLateCheckoutPageDuringShutdown() {
  if (fixtureCase !== "stripe-scan-late-reply" || !releaseLatePage) {
    throw new Error("Late Checkout fixture was not waiting for shutdown");
  }
  trace("stripe-late-page-released");
  releaseLatePage();
  await new Promise(resolve => setTimeout(resolve, 150));
  trace("stripe-late-observation-done");
}

type SdkOptions = Omit<AuditReadOptions, "signal">;
function optionsChecked(options: SdkOptions) {
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 ||
      options.maxNetworkRetries !== 0) {
    throw new Error("Audit read must have a positive integer timeout and no retries");
  }
}
function stall(options: SdkOptions & { signal?: AbortSignal }): Promise<never> {
  trace("stripe-stall");
  options.signal?.addEventListener("abort", () => trace("stripe-aborted"), { once: true });
  // Deliberately ignore cancellation: the CLI must bound even a broken reader.
  return new Promise(() => {});
}
export async function getAuditStripeClient(options: AuditReadOptions) {
  optionsChecked(options);
  if (fixtureCase === "stripe-connect-stall") return stall(options);
  if (process.env.AUDIT_FIXTURE_CASE === "stripe-private-connect") {
    throw credentialError("invalid_api_key");
  }
  let pages = 0;
  let chargePages = 0;
  let refundPages = 0;
  let disputePages = 0;
  return {
    paymentIntents: {
      async retrieve(id: string, _params: unknown, options: SdkOptions) {
        optionsChecked(options);
        trace("stripe-intent-read");
        if (fixtureCase === "stripe-intent-stall") return stall(options);
        if (process.env.AUDIT_FIXTURE_CASE === "stripe-private-inspection") {
          throw credentialError("resource_missing");
        }
        return { id, livemode: false, currency: "usd", latest_charge: "ch_fixture" };
      },
    },
    charges: {
      async list(_params: unknown, options: SdkOptions) {
        optionsChecked(options);
        trace("stripe-charges-read");
        chargePages++;
        if (fixtureCase === "stripe-charges-stall" ||
            (fixtureCase === "stripe-charges-later-page-stall" && chargePages > 1)) return stall(options);
        return { data: [{
          id: "ch_fixture", payment_intent: "pi_fixture", livemode: false,
          currency: "usd", amount_captured: 100, amount_refunded: 100, disputed: false,
        }], has_more: fixtureCase === "stripe-charges-later-page-stall" };
      },
    },
    refunds: {
      async list(params: Stripe.RefundListParams, options: SdkOptions) {
        optionsChecked(options);
        trace("stripe-refunds-read");
        refundPages++;
        if (fixtureCase === "stripe-refunds-stall" ||
            (fixtureCase === "stripe-refunds-later-page-stall" && refundPages > 1)) return stall(options);
        return { data: [{
          id: "re_fixture", charge: params.charge, payment_intent: "pi_fixture",
          currency: "usd", amount: 100, status: "succeeded",
        }], has_more: fixtureCase === "stripe-refunds-later-page-stall" };
      },
    },
    disputes: {
      async list(_params: unknown, options: SdkOptions) {
        optionsChecked(options);
        trace("stripe-disputes-read");
        disputePages++;
        if (fixtureCase === "stripe-disputes-stall" ||
            (fixtureCase === "stripe-disputes-later-page-stall" && disputePages > 1)) return stall(options);
        if (fixtureCase === "stripe-disputes-later-page-stall") return {
          data: [{ id: "dp_fixture", payment_intent: "pi_fixture", charge: "ch_fixture",
            livemode: false, status: "needs_response", amount: 100, currency: "usd" }],
          has_more: true,
        };
        return { data: [], has_more: false };
      },
    },
    balance: {
      async retrieve(_params: unknown, options: SdkOptions) {
        optionsChecked(options);
        trace("stripe-mode-read");
        if (fixtureCase === "stripe-mode-stall") return stall(options);
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
        async list(_params: unknown, options: SdkOptions) {
          optionsChecked(options);
          trace("stripe-page", { page: ++pages });
          if (fixtureCase === "stripe-scan-interrupt") {
            trace("stripe-scan-stall");
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          }
          if (fixtureCase === "stripe-scan-late-reply" && pages === 1) {
            await new Promise<void>(resolve => {
              releaseLatePage = resolve;
              trace("stripe-scan-stall");
            });
            trace("stripe-late-page-returned");
          }
          if (fixtureCase === "stripe-page-stall" || fixtureCase === "stripe-page-cleanup-stall" ||
              (fixtureCase === "stripe-later-page-stall" && pages > 1)) return stall(options);
          if (fixtureCase === "stripe-total-deadline") {
            // Each page finishes within its own read limit; only the total
            // budget can stop this steadily advancing but unfinished scan.
            await new Promise(resolve => setTimeout(resolve, 80));
            return {
              data: [{ id: `cs_unrelated_${pages}`, metadata: {}, livemode: false }],
              has_more: true,
            };
          }
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
            has_more: ["stripe-failure", "stripe-and-cleanup-failure", "stripe-later-page-stall",
              "stripe-scan-late-reply"].includes(fixtureCase ?? ""),
          };
        },
      },
    },
  };
}
