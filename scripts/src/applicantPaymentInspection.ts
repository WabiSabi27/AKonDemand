import type Stripe from "stripe";

type Page<T> = { data: T[]; has_more: boolean };
// Deliberately excludes every write operation.
export interface PaymentInspectionReader {
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  listCharges(params: Stripe.ChargeListParams): Promise<Page<Stripe.Charge>>;
  listRefunds(params: Stripe.RefundListParams): Promise<Page<Stripe.Refund>>;
  listDisputes(params: Stripe.DisputeListParams): Promise<Page<Stripe.Dispute>>;
}

export interface PaymentInspection {
  paymentIntentId: string | null;
  status: "not_requested" | "complete" | "unknown" | "unavailable";
  reason: string | null;
  refunds: {
    status: "not_requested" | "none" | "partial" | "full" | "unknown" | "unavailable";
    amountRefundedCents: number | null;
    amountCapturedCents: number | null;
    currency: string | null;
    charges: {
      chargeId: string;
      amountCapturedCents: number;
      amountRefundedCents: number;
      currency: string;
      disputed: boolean;
    }[];
  };
  refundRequests: {
    status: "not_requested" | "none" | "found" | "unknown" | "unavailable";
    items: { refundId: string; chargeId: string; status: string; amountCents: number; currency: string }[];
  };
  disputes: {
    status: "not_requested" | "none" | "found" | "unknown" | "unavailable";
    items: { disputeId: string; chargeId: string | null; status: string; amountCents: number; currency: string }[];
  };
}

export function emptyInspection(
  paymentIntentId: string | null,
  status: "not_requested" | "unknown" | "unavailable",
  reason: string | null,
): PaymentInspection {
  return {
    paymentIntentId, status, reason,
    refunds: { status, amountRefundedCents: null, amountCapturedCents: null, currency: null, charges: [] },
    refundRequests: { status, items: [] },
    disputes: { status, items: [] },
  };
}

function objectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

/**
 * Create once per scan, bound to that scan's reader/Stripe account. Cache the
 * first inspection (including unknown/unavailable evidence) per mode and intent.
 * A new scan retries reads; this is not an atomic Stripe snapshot. Each caller
 * receives a detached result so editing one session's evidence cannot affect
 * another session or the cache. Pending reads are shared too.
 */
export function createApplicantPaymentInspector(reader?: PaymentInspectionReader) {
  const inspections = new Map<string, Promise<PaymentInspection>>();
  return async (session: Stripe.Checkout.Session): Promise<PaymentInspection> => {
    const id = objectId(session.payment_intent);
    if (!reader || !id) return inspectApplicantPayment(session, reader);
    const key = JSON.stringify([session.livemode, id]);
    let inspection = inspections.get(key);
    if (!inspection) {
      inspection = inspectApplicantPayment(session, reader);
      inspections.set(key, inspection);
    }
    return structuredClone(await inspection);
  };
}

// A failed later page must never turn a partial list into a "none" result.
async function allPages<T extends { id: string }>(
  list: (cursor?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const items = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await list(cursor);
    for (const item of page.data) items.set(item.id, item);
    if (!page.has_more) return [...items.values()];
    const next = page.data.at(-1)?.id;
    if (!next || cursors.has(next)) throw new Error("Inspection pagination did not advance");
    cursors.add(next);
    cursor = next;
  }
}

export async function inspectApplicantPayment(
  session: Stripe.Checkout.Session,
  reader?: PaymentInspectionReader,
): Promise<PaymentInspection> {
  const id = objectId(session.payment_intent);
  if (!reader) return emptyInspection(id, "not_requested", null);
  if (!id) return emptyInspection(null, "unknown", "missing_payment_intent");
  let intent: Stripe.PaymentIntent;
  try {
    intent = await reader.retrievePaymentIntent(id);
  } catch {
    // Do not leak SDK errors, request headers, or credentials into reports.
    return emptyInspection(id, "unavailable", "payment_intent_lookup_failed");
  }
  if (intent.id !== id || intent.livemode !== session.livemode) {
    return emptyInspection(id, "unknown", "payment_intent_identity_or_mode_mismatch");
  }
  const result = emptyInspection(id, "unknown", null);
  let charges: Stripe.Charge[] | undefined;
  try {
    charges = await allPages(cursor => reader.listCharges({
      payment_intent: id, limit: 100, ...(cursor ? { starting_after: cursor } : {}),
    }));
    if (!charges.length || charges.some(charge =>
      objectId(charge.payment_intent) !== id || charge.livemode !== session.livemode ||
      charge.currency !== intent.currency ||
      !Number.isSafeInteger(charge.amount_captured) || charge.amount_captured < 0 ||
      !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 ||
      charge.amount_refunded > charge.amount_captured ||
      typeof charge.disputed !== "boolean"
    ) || (intent.latest_charge && !charges.some(charge => charge.id === objectId(intent.latest_charge)))) {
      result.reason = "charge_data_incomplete_or_inconsistent";
    } else {
      const captured = charges.reduce((sum, charge) => sum + charge.amount_captured, 0);
      const refunded = charges.reduce((sum, charge) => sum + charge.amount_refunded, 0);
      result.refunds = {
        status: captured === 0 ? "unknown" : refunded === 0 ? "none" : refunded === captured ? "full" : "partial",
        amountCapturedCents: captured, amountRefundedCents: refunded, currency: intent.currency,
        charges: charges.map(charge => ({
          chargeId: charge.id, amountCapturedCents: charge.amount_captured,
          amountRefundedCents: charge.amount_refunded, currency: charge.currency, disputed: charge.disputed,
        })),
      };
    }
  } catch {
    charges = undefined;
    result.refunds.status = "unavailable";
    result.reason = "charge_lookup_failed";
  }
  // Enumerate requests separately: a pending/failed/canceled request does not
  // contribute to Charge.amount_refunded and must never inflate settled totals.
  if (result.refunds.status === "unavailable") {
    result.refundRequests.status = "unavailable";
  } else if (result.refunds.charges.length) {
    result.refundRequests.status = "none";
    for (const charge of result.refunds.charges) {
      try {
        const requests = await allPages(cursor => reader.listRefunds({
          charge: charge.chargeId, limit: 100, ...(cursor ? { starting_after: cursor } : {}),
        }));
        if (requests.some(refund =>
          objectId(refund.charge) !== charge.chargeId ||
          (refund.payment_intent != null && objectId(refund.payment_intent) !== id) ||
          refund.currency !== charge.currency ||
          !Number.isSafeInteger(refund.amount) || refund.amount < 0 ||
          refund.amount > charge.amountCapturedCents ||
          !["succeeded", "pending", "requires_action", "failed", "canceled"].includes(refund.status ?? "")
        )) {
          if (result.refundRequests.status !== "unavailable") result.refundRequests.status = "unknown";
          result.reason ??= "refund_request_data_incomplete_or_inconsistent";
          continue;
        }
        result.refundRequests.items.push(...requests.map(refund => ({
          refundId: refund.id, chargeId: charge.chargeId, status: refund.status!,
          amountCents: refund.amount, currency: refund.currency,
        })));
      } catch {
        // Keep settled totals and independently completed charge inspections,
        // but never describe an incomplete request list as "none".
        result.refundRequests.status = "unavailable";
        result.reason ??= "refund_request_lookup_failed";
      }
    }
    if (result.refundRequests.status === "none" && result.refundRequests.items.length) {
      result.refundRequests.status = "found";
    }
  }
  try {
    const disputes = await allPages(cursor => reader.listDisputes({
      payment_intent: id, limit: 100, ...(cursor ? { starting_after: cursor } : {}),
    }));
    if (disputes.some(dispute => objectId(dispute.payment_intent) !== id ||
      dispute.livemode !== session.livemode) ||
      charges?.some(charge => charge.disputed && !disputes.some(dispute => objectId(dispute.charge) === charge.id))) {
      result.disputes.status = "unknown";
      result.reason ??= "dispute_data_incomplete_or_inconsistent";
    } else {
      result.disputes = {
        status: disputes.length ? "found" : "none",
        items: disputes.map(dispute => ({
          disputeId: dispute.id, chargeId: objectId(dispute.charge),
          status: dispute.status, amountCents: dispute.amount, currency: dispute.currency,
        })),
      };
    }
  } catch {
    result.disputes.status = "unavailable";
    result.reason ??= "dispute_lookup_failed";
  }
  result.status = result.refunds.status === "unavailable" || result.disputes.status === "unavailable" ||
    result.refundRequests.status === "unavailable"
    ? "unavailable" : result.refunds.status === "unknown" || result.disputes.status === "unknown" ||
      result.refundRequests.status === "unknown"
      ? "unknown" : "complete";
  return result;
}
