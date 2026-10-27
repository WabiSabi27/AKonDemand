import type { AdminStripePaymentReview } from "@workspace/api-zod";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
const sessionId = (value: unknown): value is string =>
  typeof value === "string" && /^cs_(test|live)_[A-Za-z0-9]+$/.test(value);

/** Structured receipt context, kept alongside the event without altering it. */
export class DuplicateFeePaymentError extends Error {
  constructor(message: string, readonly originalSessionId: string, readonly extraSessionId: string) {
    super(message);
  }
}

export function withPaymentReview(payload: RecordValue, err: unknown): RecordValue {
  return err instanceof DuplicateFeePaymentError
    ? { ...payload, _duplicatePayment: {
      originalSessionId: err.originalSessionId, extraSessionId: err.extraSessionId,
    } }
    : payload;
}

/** Pure projection: no Stripe calls, credentials, refunds, or account mutations. */
export function stripePaymentReview(row: {
  handlerName: string; eventType: string; payload: unknown; lastError: string;
}): AdminStripePaymentReview | undefined {
  if (row.handlerName !== "biz_account_paid" || row.eventType !== "checkout.session.completed") return;
  const event = record(row.payload);
  const session = record(record(event?.data)?.object);
  if (!session || session.mode !== "payment" || session.payment_status !== "paid") return;
  const stored = record(event?._duplicatePayment);
  // Older alerts predate structured receipt context. Only accept our exact
  // diagnostic prefix, never a URL or arbitrary identifiers from error text.
  const legacy = /^(?:Error: )?Duplicate (?:onboarding|application) payment for biz account [A-Za-z0-9_-]+: original paid session (cs_(?:test|live)_[A-Za-z0-9]+); extra paid session (cs_(?:test|live)_[A-Za-z0-9]+); /.exec(row.lastError);
  const original = stored?.originalSessionId ?? legacy?.[1];
  const extra = stored?.extraSessionId ?? legacy?.[2];
  if (!sessionId(original) || !sessionId(extra) || original === extra || extra !== session.id) return;

  const mode = typeof event?.livemode === "boolean" ? (event.livemode ? "live" : "test") : null;
  const account = event?.account;
  const safeContext = mode !== null
    && original.startsWith(`cs_${mode}_`) && extra.startsWith(`cs_${mode}_`)
    && (session.livemode === undefined || session.livemode === event?.livemode)
    && (account === undefined || (typeof account === "string" && /^acct_[A-Za-z0-9]+$/.test(account)));
  const base = safeContext
    ? `https://dashboard.stripe.com/${account ? `${account}/` : ""}${mode === "test" ? "test/" : ""}`
    : null;
  // Dashboard search supports Checkout Session IDs. Unlike checkout.url this
  // opens the admin Dashboard, never the customer's hosted payment page.
  const dashboardUrl = (id: string) => base ? `${base}search?query=${encodeURIComponent(id)}` : null;
  return {
    mode: safeContext ? mode : null,
    originalSessionId: original,
    extraSessionId: extra,
    originalDashboardUrl: dashboardUrl(original),
    extraDashboardUrl: dashboardUrl(extra),
  };
}
