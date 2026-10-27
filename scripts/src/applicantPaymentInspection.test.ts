import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { inspectApplicantPayment, type PaymentInspectionReader } from "./applicantPaymentInspection";
import { buildApplicantPaymentReport, type ReceiptSnapshot } from "./applicantPaymentReport";

const sessionFields: Partial<Stripe.Checkout.Session> = {
  id: "cs_extra", payment_intent: "pi_test", livemode: false,
  mode: "payment", payment_status: "paid", status: "complete", amount_total: 100,
  currency: "usd", created: 1_700_000_000,
  metadata: { bizAccountId: "biz_test", feeType: "application" },
};
const session = sessionFields as Stripe.Checkout.Session;
const intent = {
  id: "pi_test", livemode: false, currency: "usd", latest_charge: "ch_test",
} as Stripe.PaymentIntent;
function charge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: "ch_test", payment_intent: "pi_test", livemode: false,
    currency: "usd", amount_captured: 100, amount_refunded: 0, disputed: false,
    ...overrides,
  } as Stripe.Charge;
}
function dispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return {
    id: "dp_test", charge: "ch_test", payment_intent: "pi_test",
    livemode: false, status: "needs_response", amount: 100, currency: "usd", ...overrides,
  } as Stripe.Dispute;
}
function refund(overrides: Partial<Stripe.Refund> = {}): Stripe.Refund {
  return {
    id: "re_test", charge: "ch_test", payment_intent: "pi_test",
    currency: "usd", amount: 100, status: "pending", ...overrides,
  } as Stripe.Refund;
}
function reader(overrides: Partial<PaymentInspectionReader> = {}): PaymentInspectionReader {
  return {
    async retrievePaymentIntent(id) { assert.equal(id, "pi_test"); return intent; },
    async listCharges(params) {
      assert.deepEqual(params, { payment_intent: "pi_test", limit: 100 });
      return { data: [charge()], has_more: false };
    },
    async listRefunds() { return { data: [], has_more: false }; },
    async listDisputes(params) {
      assert.deepEqual(params, { payment_intent: "pi_test", limit: 100 });
      return { data: [], has_more: false };
    },
    ...overrides,
  };
}

for (const [amount, status] of [[0, "none"], [40, "partial"], [100, "full"]] as const) {
  test(`reports ${status} refunds without changing paid sessions or clearing review`, async () => {
    const saved = {
      id: "biz_test", stripeSessionId: "cs_saved", paidAt: new Date("2025-01-01"),
      applicationPaidAmountCents: 100, applicationPaidCurrency: "usd",
      onboardingSessionId: null, onboardingPaidAt: null,
      onboardingPaidAmountCents: null, onboardingPaidCurrency: null,
    } satisfies ReceiptSnapshot;
    const before = structuredClone({ session, saved });
    const report = await buildApplicantPaymentReport({
      async list() { return { data: [session], has_more: false }; },
    }, [saved], "test", new Date(), reader({
      async listCharges() { return { data: [charge({ amount_refunded: amount })], has_more: false }; },
    }));
    const inspection = report.groups[0].additionalSessions[0].paymentInspection;
    assert.equal(inspection.status, "complete");
    assert.equal(inspection.refunds.status, status);
    assert.equal(inspection.refunds.amountRefundedCents, amount);
    assert.equal(inspection.refunds.currency, "usd");
    assert.equal(report.summary.groupsNeedingReview, 1);
    assert.deepEqual({ session, saved }, before);
    assert.equal(session.payment_status, "paid");
  });
}

test("inspection is opt-in, and a missing PaymentIntent is unknown without API calls", async () => {
  const uninspected = await inspectApplicantPayment(session);
  assert.equal(uninspected.status, "not_requested");
  assert.deepEqual(uninspected.refundRequests, { status: "not_requested", items: [] });
  const noCalls = new Proxy({} as PaymentInspectionReader, {
    get() { throw new Error("Unexpected API call"); },
  });
  const result = await inspectApplicantPayment({ ...session, payment_intent: null }, noCalls);
  assert.equal(result.status, "unknown");
  assert.equal(result.refunds.amountRefundedCents, null);
  assert.deepEqual(result.refundRequests, { status: "unknown", items: [] });
});

test("expanded PaymentIntent IDs are re-read; charge and dispute pagination deduplicates across pages", async () => {
  const chargeCalls: Stripe.ChargeListParams[] = [];
  const disputeCalls: Stripe.DisputeListParams[] = [];
  const result = await inspectApplicantPayment({ ...session, payment_intent: intent }, reader({
    async listCharges(params) {
      chargeCalls.push(params);
      return params.starting_after
        ? { data: [charge({ amount_refunded: 25, disputed: true }), charge({ id: "ch_second", amount_captured: 50, amount_refunded: 50 })], has_more: false }
        : { data: [charge({ amount_refunded: 25, disputed: true })], has_more: true };
    },
    async listDisputes(params) {
      disputeCalls.push(params);
      return params.starting_after
        ? { data: [dispute(), dispute({ id: "dp_closed", charge: "ch_second", status: "won" })], has_more: false }
        : { data: [dispute()], has_more: true };
    },
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.refunds.amountRefundedCents, 75);
  assert.equal(result.refunds.amountCapturedCents, 150);
  assert.equal(result.refunds.charges.length, 2);
  assert.equal(result.disputes.status, "found");
  assert.deepEqual(result.disputes.items.map(item => item.status), ["needs_response", "won"]);
  assert.deepEqual(chargeCalls.map(call => call.starting_after), [undefined, "ch_test"]);
  assert.deepEqual(disputeCalls.map(call => call.starting_after), [undefined, "dp_test"]);
});

test("lookup errors are unavailable and never leak raw errors; independent evidence survives", async () => {
  const fail = async (): Promise<never> => { throw new Error("SECRET_DO_NOT_PRINT"); };
  const missing = await inspectApplicantPayment(session, reader({ retrievePaymentIntent: fail }));
  assert.equal(missing.status, "unavailable");
  const refundOnly = await inspectApplicantPayment(session, reader({ listDisputes: fail }));
  assert.equal(refundOnly.refunds.status, "none");
  assert.equal(refundOnly.disputes.status, "unavailable");
  const disputeOnly = await inspectApplicantPayment(session, reader({ listCharges: fail }));
  assert.equal(disputeOnly.refunds.amountRefundedCents, null);
  assert.equal(disputeOnly.disputes.status, "none");
  assert.ok(!JSON.stringify([missing, refundOnly, disputeOnly]).includes("SECRET"));
});

for (const kind of ["charges", "disputes"] as const) {
  for (const failure of ["later_page", "empty_page", "stalled_cursor"] as const) {
    test(`${kind} ${failure} cannot be reported as complete or none`, async () => {
      let calls = 0;
      const list = async () => {
        calls++;
        if (failure === "later_page" && calls > 1) throw new Error("Synthetic outage");
        return { data: failure === "empty_page" ? [] : [kind === "charges" ? charge() : dispute()], has_more: true };
      };
      const result = await inspectApplicantPayment(session, reader(kind === "charges"
        ? { listCharges: list as PaymentInspectionReader["listCharges"] }
        : { listDisputes: list as PaymentInspectionReader["listDisputes"] }));
      const detail = kind === "charges" ? result.refunds : result.disputes;
      assert.equal(result.status, "unavailable");
      assert.equal(detail.status, "unavailable");
      assert.ok(calls <= 2);
    });
  }
}

test("missing charges, mismatched modes, and inconsistent dispute flags remain unknown", async () => {
  const cases: Partial<PaymentInspectionReader>[] = [
    { async retrievePaymentIntent() { return { ...intent, livemode: true }; } },
    { async listCharges() { return { data: [], has_more: false }; } },
    { async listCharges() { return { data: [charge({ currency: "cad" })], has_more: false }; } },
    { async listCharges() { return { data: [charge({ disputed: true })], has_more: false }; } },
    { async listDisputes() { return { data: [dispute({ livemode: true })], has_more: false }; } },
  ];
  for (const overrides of cases) {
    assert.equal((await inspectApplicantPayment(session, reader(overrides))).status, "unknown");
  }
});

for (const status of ["succeeded", "pending", "requires_action", "failed", "canceled"] as const) {
  test(`enumerates ${status} requests without inflating settled totals or resolving manual review`, async () => {
    const before = structuredClone(session);
    const report = await buildApplicantPaymentReport({
      async list() { return { data: [session, { ...session, id: "cs_another" }], has_more: false }; },
    }, [], "test", new Date(), reader({
      async listRefunds(params) {
        assert.deepEqual(params, { charge: "ch_test", limit: 100 });
        return { data: [refund({ status })], has_more: false };
      },
    }));
    const inspection = report.groups[0].successfulSessions[0].paymentInspection;
    assert.equal(inspection.status, "complete");
    assert.deepEqual(inspection.refundRequests, {
      status: "found",
      items: [{ refundId: "re_test", chargeId: "ch_test", status, amountCents: 100, currency: "usd" }],
    });
    // Charge totals remain the source of truth even if Stripe reads differ in time.
    assert.equal(inspection.refunds.amountRefundedCents, 0);
    assert.equal(inspection.refunds.status, "none");
    assert.equal(report.summary.groupsNeedingReview, 1);
    assert.deepEqual(session, before);
    assert.equal(session.payment_status, "paid");
  });
}

test("refund pagination deduplicates IDs and resets the cursor for each charge", async () => {
  const calls: Stripe.RefundListParams[] = [];
  const result = await inspectApplicantPayment(session, reader({
    async listCharges() {
      return { data: [charge({ amount_refunded: 40 }), charge({ id: "ch_second", amount_refunded: 20 })], has_more: false };
    },
    async listRefunds(params) {
      calls.push(params);
      if (params.charge === "ch_second") {
        return { data: [refund({ id: "re_second", charge: { id: "ch_second" } as Stripe.Charge, amount: 20, status: "succeeded" })], has_more: false };
      }
      return params.starting_after
        ? { data: [refund({ amount: 40 }), refund({ id: "re_done", amount: 40, status: "succeeded" })], has_more: false }
        : { data: [refund({ amount: 40 })], has_more: true };
    },
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.refunds.amountRefundedCents, 60);
  assert.equal(result.refundRequests.status, "found");
  assert.deepEqual(result.refundRequests.items.map(item => item.refundId), ["re_test", "re_done", "re_second"]);
  assert.deepEqual(calls, [
    { charge: "ch_test", limit: 100 },
    { charge: "ch_test", limit: 100, starting_after: "re_test" },
    { charge: "ch_second", limit: 100 },
  ]);
});

test("empty refund requests are none only after every charge page succeeds", async () => {
  const result = await inspectApplicantPayment(session, reader());
  assert.equal(result.status, "complete");
  assert.deepEqual(result.refundRequests, { status: "none", items: [] });
});

for (const failure of ["first_page", "later_page", "empty_page", "stalled_cursor"] as const) {
  test(`refund ${failure} is unavailable while settled totals and disputes survive`, async () => {
    let calls = 0;
    const result = await inspectApplicantPayment(session, reader({
      async listCharges() { return { data: [charge({ amount_refunded: 40 })], has_more: false }; },
      async listRefunds() {
        calls++;
        if (failure === "first_page" || (failure === "later_page" && calls > 1)) throw new Error("SECRET_DO_NOT_PRINT");
        return { data: failure === "empty_page" ? [] : [refund()], has_more: true };
      },
      async listDisputes() { return { data: [dispute({ status: "won" })], has_more: false }; },
    }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "refund_request_lookup_failed");
    assert.deepEqual(result.refundRequests, { status: "unavailable", items: [] });
    assert.equal(result.refunds.status, "partial");
    assert.equal(result.refunds.amountRefundedCents, 40);
    assert.equal(result.disputes.items[0].status, "won");
    assert.ok(calls <= 2);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  });
}

test("a failed charge refund list retains independently inspected request evidence", async () => {
  const result = await inspectApplicantPayment(session, reader({
    async listCharges() { return { data: [charge(), charge({ id: "ch_second" })], has_more: false }; },
    async listRefunds(params) {
      if (params.charge === "ch_test") throw new Error("Synthetic outage");
      return { data: [refund({ charge: "ch_second" })], has_more: false };
    },
  }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.refundRequests.status, "unavailable");
  assert.equal(result.refundRequests.items[0].chargeId, "ch_second");
  assert.equal(result.refunds.amountCapturedCents, 200);
});

test("inconsistent refund identity, currency, amounts or status remain unknown", async () => {
  for (const overrides of [
    { charge: "ch_other" }, { payment_intent: "pi_other" }, { currency: "cad" },
    { amount: -1 }, { amount: 0.5 }, { amount: 101 }, { amount: Number.NaN },
    { status: null }, { status: "unexpected" as Stripe.Refund["status"] },
  ] satisfies Partial<Stripe.Refund>[]) {
    const result = await inspectApplicantPayment(session, reader({
      async listRefunds() { return { data: [refund(overrides)], has_more: false }; },
    }));
    assert.equal(result.status, "unknown");
    assert.deepEqual(result.refundRequests, { status: "unknown", items: [] });
    assert.equal(result.refunds.status, "none");
    assert.equal(result.reason, "refund_request_data_incomplete_or_inconsistent");
  }
});

test("invalid or unavailable charges never trigger refund reads", async () => {
  for (const listCharges of [
    async () => ({ data: [], has_more: false }),
    async () => ({ data: [charge({ livemode: true })], has_more: false }),
    async (): Promise<never> => { throw new Error("Synthetic outage"); },
  ]) {
    const result = await inspectApplicantPayment(session, reader({
      listCharges,
      async listRefunds(): Promise<never> { assert.fail("Unexpected refund read"); },
    }));
    assert.ok(["unknown", "unavailable"].includes(result.refundRequests.status));
    assert.deepEqual(result.refundRequests.items, []);
  }
});
