import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import type Stripe from "stripe";
import { createApplicantPaymentInspector, type PaymentInspectionReader } from "./applicantPaymentInspection";
import { buildApplicantPaymentReport, type ReceiptSnapshot } from "./applicantPaymentReport";

// Pure synthetic readers only: even an accidental network call must fail.
beforeEach(() => {
  const noNetwork = (): never => { throw new Error("Unexpected network access"); };
  mock.method(globalThis, "fetch", noNetwork);
  mock.method(http, "request", noNetwork);
  mock.method(http, "get", noNetwork);
  mock.method(https, "request", noNetwork);
  mock.method(https, "get", noNetwork);
  mock.method(Socket.prototype, "connect", noNetwork);
});
afterEach(() => mock.restoreAll());

function session(id: string, overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id, payment_intent: "pi_shared", livemode: false, mode: "payment",
    payment_status: "paid", status: "complete", amount_total: 100, currency: "usd",
    created: 1_700_000_000, metadata: { bizAccountId: "biz_test", feeType: "application" },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function synthetic() {
  const calls = { intent: [] as string[], charges: [] as Stripe.ChargeListParams[], refunds: [] as Stripe.RefundListParams[], disputes: [] as Stripe.DisputeListParams[] };
  const state = { live: false, refunded: 25, failure: "" };
  const reader: PaymentInspectionReader = {
    async retrievePaymentIntent(id) {
      calls.intent.push(id);
      if (state.failure === "intent") throw new Error("PRIVATE_SDK_ERROR");
      return {
        id, livemode: state.live, currency: "usd", latest_charge: `ch_${id}_1`,
      } as Stripe.PaymentIntent;
    },
    async listCharges(params) {
      calls.charges.push(params);
      if (state.failure === "charges" && params.starting_after) throw new Error("PRIVATE_SDK_ERROR");
      const second = Boolean(params.starting_after);
      return { has_more: !second, data: [{
        id: `ch_${params.payment_intent}_${second ? 2 : 1}`,
        payment_intent: params.payment_intent, livemode: state.live, currency: "usd",
        amount_captured: 100, amount_refunded: state.refunded, disputed: !second,
      } as Stripe.Charge] };
    },
    async listRefunds(params) {
      calls.refunds.push(params);
      if (state.failure === "refunds") throw new Error("PRIVATE_SDK_ERROR");
      return { has_more: false, data: [{
        id: `re_${params.charge}`, charge: params.charge,
        status: "pending", amount: 10, currency: "usd",
      } as Stripe.Refund] };
    },
    async listDisputes(params) {
      calls.disputes.push(params);
      if (state.failure === "disputes" && params.starting_after) throw new Error("PRIVATE_SDK_ERROR");
      const second = Boolean(params.starting_after);
      return { has_more: !second, data: [{
        id: `dp_${params.payment_intent}_${second ? 2 : 1}`,
        payment_intent: params.payment_intent, livemode: state.live,
        charge: `ch_${params.payment_intent}_1`, status: "won", amount: 100, currency: "usd",
      } as Stripe.Dispute] };
    },
  };
  return { reader, calls, state };
}

test("a report shares paginated reads across sessions, pages, accounts and fees without merging evidence or review findings", async () => {
  const { reader, calls } = synthetic();
  const saved: ReceiptSnapshot = {
    id: "biz_test", stripeSessionId: "cs_saved", paidAt: new Date("2025-01-01"),
    applicationPaidAmountCents: 100, applicationPaidCurrency: "usd",
    onboardingSessionId: null, onboardingPaidAt: null,
    onboardingPaidAmountCents: null, onboardingPaidCurrency: null,
  };
  const sessions = [
    session("cs_saved"),
    session("cs_extra", { amount_total: 200, currency: "cad" }),
    session("cs_onboarding", { metadata: { bizAccountId: "biz_other", feeType: "onboarding" } }),
    session("cs_unsupported", { metadata: { bizAccountId: "biz_test", feeType: "future" } }),
    session("cs_distinct", { payment_intent: "pi_distinct" }),
  ];
  const before = structuredClone({ saved, sessions });
  let page = 0;
  const report = await buildApplicantPaymentReport({
    async list() {
      return ++page === 1
        ? { data: sessions.slice(0, 1), has_more: true }
        : { data: sessions.slice(1), has_more: false };
    },
  }, [saved], "test", new Date(), reader);
  assert.deepEqual(calls.intent, ["pi_shared", "pi_distinct"]);
  assert.deepEqual(calls.refunds.map(p => p.charge), [
    "ch_pi_shared_1", "ch_pi_shared_2", "ch_pi_distinct_1", "ch_pi_distinct_2",
  ]);
  for (const lists of [calls.charges, calls.disputes]) {
    assert.equal(lists.length, 4, "two pages per distinct intent, not per session");
    assert.deepEqual(lists.map(p => p.payment_intent), ["pi_shared", "pi_shared", "pi_distinct", "pi_distinct"]);
    assert.ok(lists[1].starting_after);
    assert.ok(lists[3].starting_after);
  }
  const group = report.groups.find(g => g.bizAccountId === saved.id)!;
  assert.equal(group.successfulSessions.length, 3);
  assert.equal(group.additionalSessions.length, 2);
  assert.ok(group.issues.includes("multiple_successful_sessions"));
  assert.ok(group.issues.includes("successful_sessions_differ_from_preserved_receipt"));
  assert.equal(report.summary.groupsNeedingReview, 2);
  const first = group.successfulSessions.find(s => s.sessionId === "cs_saved")!;
  const extra = group.successfulSessions.find(s => s.sessionId === "cs_extra")!;
  assert.equal(extra.amountCents, 200);
  assert.equal(extra.currency, "cad");
  assert.equal(first.paymentInspection.refunds.status, "partial");
  assert.equal(first.paymentInspection.disputes.items[0].status, "won");
  assert.deepEqual(extra.paymentInspection, first.paymentInspection);
  assert.deepEqual(report.unsupportedFeeSessions[0].paymentInspection, first.paymentInspection);
  const originalEvidence = structuredClone(first.paymentInspection);
  first.paymentInspection.refunds.charges[0].amountRefundedCents = 999;
  first.paymentInspection.disputes.items[0].status = "edited";
  first.paymentInspection.refundRequests.items[0].status = "edited";
  assert.deepEqual(extra.paymentInspection, originalEvidence);
  assert.deepEqual(report.unsupportedFeeSessions[0].paymentInspection, originalEvidence);
  assert.deepEqual({ saved, sessions }, before);
  assert.match(report.limitations.join(" "), /rerun the report to retry/);
});

for (const failure of ["intent", "charges", "refunds", "disputes", "mode"] as const) {
  test(`${failure} failure is retained within a scan with independent evidence, and a new scan retries`, async () => {
    const { reader, calls, state } = synthetic();
    state.failure = failure;
    state.live = failure === "mode";
    const inspect = createApplicantPaymentInspector(reader);
    const first = await inspect(session("cs_first"));
    const counts = structuredClone(calls);
    state.failure = "";
    state.live = false;
    const second = await inspect(session("cs_second"));
    assert.deepEqual(calls, counts, "unavailable/unknown results must not silently retry");
    assert.deepEqual(second, first);
    assert.equal(first.status, failure === "mode" ? "unknown" : "unavailable");
    if (failure === "charges") {
      assert.equal(first.refunds.amountRefundedCents, null);
      assert.equal(first.refunds.status, "unavailable");
      assert.equal(first.disputes.status, "found");
    }
    if (failure === "disputes") {
      assert.equal(first.refunds.amountRefundedCents, 50);
      assert.equal(first.disputes.status, "unavailable");
    }
    if (failure === "refunds") {
      assert.equal(first.refunds.amountRefundedCents, 50);
      assert.equal(first.refundRequests.status, "unavailable");
      assert.equal(first.disputes.status, "found");
    }
    assert.ok(!JSON.stringify(first).includes("PRIVATE"));
    assert.equal(counts.intent.length, 1);
    assert.equal(counts.charges.length, failure === "intent" || failure === "mode" ? 0 : 2);
    assert.equal(counts.disputes.length, failure === "intent" || failure === "mode" ? 0 : 2);
    assert.equal(counts.refunds.length, ["intent", "mode", "charges"].includes(failure) ? 0 : 2);
    const retried = await createApplicantPaymentInspector(reader)(session("cs_retry"));
    assert.equal(retried.status, "complete");
    assert.equal(calls.intent.length, 2);
  });
}

test("same intent IDs in different modes have isolated snapshots and retain identity validation", async () => {
  const { reader, state, calls } = synthetic();
  const inspect = createApplicantPaymentInspector(reader);
  const testResult = await inspect(session("cs_test"));
  // The reader still returns test data, so live must not reuse test success.
  const mismatch = await inspect(session("cs_live", { livemode: true }));
  assert.equal(mismatch.status, "unknown");
  assert.equal(mismatch.reason, "payment_intent_identity_or_mode_mismatch");
  assert.deepEqual(await inspect(session("cs_test_again")), testResult);
  assert.equal(calls.intent.length, 2);
  assert.equal(calls.charges.length, 2);
  state.live = true;
  const fresh = createApplicantPaymentInspector(reader);
  assert.equal((await fresh(session("cs_live_fresh", { livemode: true }))).status, "complete");
  assert.equal(calls.intent.length, 3);
  assert.equal(calls.charges.length, 4);
});

test("concurrent and expanded references share reads but not mutable evidence or cache contents", async () => {
  const { reader, calls } = synthetic();
  const inspect = createApplicantPaymentInspector(reader);
  const [first, second] = await Promise.all([
    inspect(session("cs_first")),
    inspect(session("cs_second", { payment_intent: { id: "pi_shared" } as Stripe.PaymentIntent })),
  ]);
  assert.equal(calls.intent.length, 1);
  assert.equal(calls.charges.length, 2);
  assert.equal(calls.disputes.length, 2);
  const before = structuredClone(second);
  first.refunds.charges[0].currency = "edited";
  second.disputes.items.length = 0;
  assert.deepEqual(await inspect(session("cs_third")), before);
});

test("reports start fresh even with the same reader and sessions", async () => {
  const { reader, state, calls } = synthetic();
  const sessions = [session("cs_one"), session("cs_two")];
  const checkoutReader = { async list() { return { data: sessions, has_more: false }; } };
  const first = await buildApplicantPaymentReport(checkoutReader, [], "test", new Date(), reader);
  state.refunded = 100;
  const second = await buildApplicantPaymentReport(checkoutReader, [], "test", new Date(), reader);
  assert.equal(calls.intent.length, 2);
  assert.equal(calls.charges.length, 4);
  assert.equal(calls.disputes.length, 4);
  assert.equal(first.groups[0].successfulSessions[0].paymentInspection.refunds.status, "partial");
  assert.equal(second.groups[0].successfulSessions[0].paymentInspection.refunds.status, "full");
});

test("opt-out, missing intents and unattributable sessions never read payment evidence", async () => {
  const { reader, calls } = synthetic();
  assert.equal((await createApplicantPaymentInspector()(session("cs_off"))).status, "not_requested");
  const inspect = createApplicantPaymentInspector(reader);
  assert.equal((await inspect(session("cs_missing", { payment_intent: null }))).status, "unknown");
  await buildApplicantPaymentReport({
    async list() { return { data: [session("cs_unattributed", { metadata: {} })], has_more: false }; },
  }, [], "test", new Date(), reader);
  assert.deepEqual(calls, { intent: [], charges: [], refunds: [], disputes: [] });
});
