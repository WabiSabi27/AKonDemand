import { expect, it } from "vitest";
import { DuplicateFeePaymentError, stripePaymentReview, withPaymentReview } from "../src/lib/stripePaymentReview";

function fixture(livemode: boolean | undefined = false) {
  const mode = livemode ? "live" : "test";
  const original = `cs_${mode}_Original123`;
  const extra = `cs_${mode}_Extra456`;
  const payload = {
    livemode,
    data: { object: { id: extra, mode: "payment", payment_status: "paid" } },
  };
  return {
    handlerName: "biz_account_paid", eventType: "checkout.session.completed", payload,
    lastError: `Error: Duplicate application payment for biz account ba_synthetic: original paid session ${original}; extra paid session ${extra}; 200 usd (minor units).`,
  };
}

it.each([false, true])("projects historical paid sessions using event livemode=%s", live => {
  const result = stripePaymentReview(fixture(live));
  const mode = live ? "live" : "test";
  const base = `https://dashboard.stripe.com/${live ? "" : "test/"}`;
  expect(result).toEqual({
    mode, originalSessionId: `cs_${mode}_Original123`, extraSessionId: `cs_${mode}_Extra456`,
    originalDashboardUrl: `${base}search?query=cs_${mode}_Original123`,
    extraDashboardUrl: `${base}search?query=cs_${mode}_Extra456`,
  });
});

it("uses structured receipt context without depending on error formatting", () => {
  const row = fixture();
  const error = new DuplicateFeePaymentError("New diagnostic", "cs_test_Original123", "cs_test_Extra456");
  const payload = withPaymentReview(row.payload, error);
  expect(row.payload).not.toHaveProperty("_duplicatePayment");
  expect(stripePaymentReview({ ...row, payload, lastError: error.message })?.originalDashboardUrl)
    .toBe("https://dashboard.stripe.com/test/search?query=cs_test_Original123");
  expect(withPaymentReview(payload, new Error("unrelated"))).toBe(payload);
});

it("keeps connected-account Dashboard searches scoped to the event's account", () => {
  const row = fixture();
  expect(stripePaymentReview({ ...row, payload: { ...row.payload, account: "acct_Synthetic" } })?.extraDashboardUrl)
    .toBe("https://dashboard.stripe.com/acct_Synthetic/test/search?query=cs_test_Extra456");
});

it("withholds links when mode is unknown, contradictory, or account context is invalid", () => {
  const row = fixture();
  const payloads = [
    { ...row.payload, livemode: undefined },
    { ...row.payload, livemode: true },
    { ...row.payload, account: "../evil" },
    { ...row.payload, data: { object: { ...row.payload.data.object, livemode: true } } },
  ];
  for (const payload of payloads) {
    expect(stripePaymentReview({ ...row, payload })).toMatchObject({
      mode: null, originalDashboardUrl: null, extraDashboardUrl: null,
    });
  }
});

it("omits review for malformed, unrelated, unpaid, or mismatched events", () => {
  const row = fixture();
  for (const altered of [
    { ...row, payload: null },
    { ...row, handlerName: "subscription_mirror" },
    { ...row, lastError: "https://evil.test/cs_test_Original123" },
    { ...row, lastError: row.lastError.replace("cs_test_Original123", "cs_test_Original123/../../evil") },
    { ...row, payload: { ...row.payload, data: { object: { ...row.payload.data.object, id: "cs_test_Other" } } } },
    { ...row, payload: { ...row.payload, data: { object: { ...row.payload.data.object, payment_status: "unpaid" } } } },
  ]) expect(stripePaymentReview(altered)).toBeUndefined();
});
