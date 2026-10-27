import type Stripe from "stripe";
import { createApplicantPaymentInspector, type PaymentInspectionReader, type PaymentInspection } from "./applicantPaymentInspection";

export type StripeMode = "test" | "live";
type FeeType = "application" | "onboarding";
export interface ReceiptSnapshot {
  id: string;
  stripeSessionId: string | null;
  paidAt: Date | null;
  applicationPaidAmountCents: number | null;
  applicationPaidCurrency: string | null;
  onboardingSessionId: string | null;
  onboardingPaidAt: Date | null;
  onboardingPaidAmountCents: number | null;
  onboardingPaidCurrency: string | null;
}

// Only expose the one read operation needed by the report.
export interface CheckoutReader {
  list(params: Stripe.Checkout.SessionListParams): Promise<{
    data: Stripe.Checkout.Session[];
    has_more: boolean;
  }>;
}

function sessionDetails(session: Stripe.Checkout.Session, paymentInspection: PaymentInspection) {
  return {
    sessionId: session.id,
    amountCents: session.amount_total,
    currency: session.currency,
    stripeMode: session.livemode ? "live" as const : "test" as const,
    createdAt: new Date(session.created * 1000).toISOString(),
    paymentInspection,
  };
}

export async function buildApplicantPaymentReport(
  reader: CheckoutReader,
  accounts: readonly ReceiptSnapshot[],
  stripeMode: StripeMode,
  scanStartedAt = new Date(),
  inspectionReader?: PaymentInspectionReader,
) {
  const cutoff = Math.floor(scanStartedAt.getTime() / 1000);
  const accountById = new Map(accounts.map(account => [account.id, account]));
  const groups = new Map<string, {
    bizAccountId: string;
    feeType: FeeType;
    sessions: Map<string, Stripe.Checkout.Session>;
  }>();
  function groupFor(bizAccountId: string, feeType: FeeType) {
    const key = JSON.stringify([bizAccountId, feeType]);
    let group = groups.get(key);
    if (!group) {
      group = { bizAccountId, feeType, sessions: new Map() };
      groups.set(key, group);
    }
    return group;
  }
  // Include receipts without a matching paid session in this mode as well.
  for (const account of accounts) {
    if (account.paidAt) groupFor(account.id, "application");
    if (account.onboardingPaidAt) groupFor(account.id, "onboarding");
  }

  let pagesScanned = 0;
  let sessionsScanned = 0;
  const unsupportedFeeSessions: (ReturnType<typeof sessionDetails> & {
    bizAccountId: string;
    feeType: string;
  })[] = [];
  const seenIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const inspections = new Map<string, PaymentInspection>();
  const inspectPayment = createApplicantPaymentInspector(inspectionReader);
  for (;;) {
    const page = await reader.list({
      limit: 100,
      created: { lte: cutoff },
      ...(cursor ? { starting_after: cursor } : {}),
    });
    pagesScanned++;
    for (const session of page.data) {
      if (session.livemode !== (stripeMode === "live")) {
        throw new Error("Stripe mode mismatch; no report was produced.");
      }
      if (seenIds.has(session.id)) continue;
      seenIds.add(session.id);
      sessionsScanned++;
      if (session.mode !== "payment" || session.payment_status !== "paid" ||
          !session.metadata?.bizAccountId) continue;
      // Older application checkouts predate explicit feeType metadata.
      const feeType = session.metadata.feeType ?? "application";
      const inspection = await inspectPayment(session);
      inspections.set(session.id, inspection);
      if (feeType !== "application" && feeType !== "onboarding") {
        unsupportedFeeSessions.push({
          ...sessionDetails(session, inspection),
          bizAccountId: session.metadata.bizAccountId,
          feeType,
        });
        continue;
      }
      groupFor(session.metadata.bizAccountId, feeType).sessions.set(session.id, session);
    }
    if (!page.has_more) break;
    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new Error("Stripe pagination did not advance; no complete report was produced.");
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  const results = [...groups.values()].map(group => {
    const account = accountById.get(group.bizAccountId);
    const onboarding = group.feeType === "onboarding";
    const paidAt = account ? (onboarding ? account.onboardingPaidAt : account.paidAt) : null;
    // An unpaid checkout-offer ID is not a preserved receipt.
    const preservedReceipt = account && paidAt ? {
      sessionId: onboarding ? account.onboardingSessionId : account.stripeSessionId,
      paidAt: paidAt.toISOString(),
      amountCents: onboarding ? account.onboardingPaidAmountCents : account.applicationPaidAmountCents,
      currency: onboarding ? account.onboardingPaidCurrency : account.applicationPaidCurrency,
    } : null;
    const preservedSession = preservedReceipt?.sessionId
      ? group.sessions.get(preservedReceipt.sessionId) : undefined;
    const sessions = [...group.sessions.values()]
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
      .map(session => sessionDetails(session, inspections.get(session.id)!));
    const issues: string[] = [];
    if (!account) issues.push("unknown_biz_account");
    if (!preservedReceipt) issues.push("no_preserved_receipt");
    else if (!preservedReceipt.sessionId) issues.push("preserved_receipt_has_no_session_id");
    else if (!preservedSession) issues.push("preserved_session_not_found_in_scanned_mode");
    if (sessions.length > 1) issues.push("multiple_successful_sessions");
    const additionalSessions = preservedReceipt?.sessionId
      ? sessions.filter(session => session.sessionId !== preservedReceipt.sessionId) : [];
    if (additionalSessions.length) issues.push("successful_sessions_differ_from_preserved_receipt");
    if (preservedSession && preservedReceipt &&
        ((preservedReceipt.amountCents !== null && preservedReceipt.amountCents !== preservedSession.amount_total) ||
         (preservedReceipt.currency !== null && preservedReceipt.currency.toLowerCase() !== preservedSession.currency?.toLowerCase()))) {
      issues.push("preserved_receipt_amount_or_currency_mismatch");
    }
    return {
      bizAccountId: group.bizAccountId,
      feeType: group.feeType,
      preservedReceipt: preservedReceipt ? {
        ...preservedReceipt,
        // IDs alone cannot establish the mode of an unobserved historical receipt.
        stripeMode: preservedSession ? stripeMode : null,
      } : null,
      successfulSessions: sessions,
      additionalSessions,
      issues,
    };
  }).sort((a, b) => a.bizAccountId.localeCompare(b.bizAccountId) || a.feeType.localeCompare(b.feeType));

  return {
    reportVersion: 2,
    readOnly: true,
    paymentInspectionRequested: Boolean(inspectionReader),
    stripeMode,
    scanStartedAt: scanStartedAt.toISOString(),
    stripeCreatedThrough: cutoff,
    scope: "All paid one-time Checkout Sessions in the selected Stripe account/mode; application (including legacy missing feeType) and onboarding only.",
    limitations: [
      "One mode and the currently connected Stripe account only; not a cross-mode or cross-account audit.",
      "Database receipts are a read-only snapshot taken before the Stripe scan; concurrent payments may require a later rerun.",
      "Checkout creation time is not payment time. Stripe listing is not an atomic snapshot.",
      "Paid sessions may subsequently have been refunded or disputed. Optional inspection is read-only, not atomic, and does not resolve review findings; investigate in Stripe before taking action.",
      "Inspection reuses the first result per PaymentIntent and mode within this scan, including unknown/unavailable evidence. Shared sessions are not independent observations; rerun the report to retry or refresh reads.",
      "Refund totals reflect Charge.amount_refunded only. Optional refundRequests separately lists succeeded, pending, requires_action, failed and canceled requests; check its completeness before requesting another refund. Dispute status is separate from refunds and must not be subtracted from them.",
      "Unknown historical receipt amounts and modes remain unknown. No first receipt is inferred or replaced.",
      "Sessions without bizAccountId cannot be attributed and are excluded.",
    ],
    summary: {
      pagesScanned,
      sessionsScanned,
      groups: results.length,
      groupsWithMultipleSuccessfulSessions: results.filter(group => group.successfulSessions.length > 1).length,
      groupsWithAdditionalSessions: results.filter(group => group.additionalSessions.length > 0).length,
      groupsNeedingReview: results.filter(group => group.issues.length > 0).length,
    },
    unsupportedFeeSessions,
    groups: results,
  };
}
