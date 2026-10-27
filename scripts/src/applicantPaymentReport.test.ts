import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import type Stripe from "stripe";
import {
  buildApplicantPaymentReport,
  type CheckoutReader,
  type ReceiptSnapshot,
} from "./applicantPaymentReport";

const now = new Date("2026-10-23T12:00:00Z");
function session(id: string, overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id, mode: "payment", payment_status: "paid", status: "complete",
    amount_total: 1900, currency: "usd", livemode: false,
    created: 1_700_000_000,
    metadata: { bizAccountId: "biz_1", feeType: "application" },
    ...overrides,
  } as Stripe.Checkout.Session;
}
function account(overrides: Partial<ReceiptSnapshot> = {}): ReceiptSnapshot {
  return {
    id: "biz_1", stripeSessionId: "cs_first", paidAt: new Date("2025-01-01"),
    applicationPaidAmountCents: 1900, applicationPaidCurrency: "usd",
    onboardingSessionId: null, onboardingPaidAt: null,
    onboardingPaidAmountCents: null, onboardingPaidCurrency: null,
    ...overrides,
  };
}
function pages(...responses: { data: Stripe.Checkout.Session[]; has_more: boolean }[]) {
  const calls: Stripe.Checkout.SessionListParams[] = [];
  const reader: CheckoutReader = {
    async list(params) {
      calls.push(params);
      const response = responses.shift();
      assert.ok(response, "unexpected extra Stripe call");
      return response;
    },
  };
  return { reader, calls };
}
function onePage(...sessions: Stripe.Checkout.Session[]) {
  return pages({ data: sessions, has_more: false }).reader;
}

test("paginates and compares both fees against the preserved receipt, not the earliest created session", async () => {
  const saved = account({
    onboardingSessionId: "cs_onboarding_first", onboardingPaidAt: new Date("2025-02-01"),
    onboardingPaidAmountCents: 6000, onboardingPaidCurrency: "usd",
  });
  const snapshot = structuredClone(saved);
  const { reader, calls } = pages(
    { data: [
      session("cs_extra", { amount_total: 100, currency: "cad", created: 1_600_000_000 }),
      session("cs_onboarding_extra", {
        amount_total: 200, metadata: { bizAccountId: "biz_1", feeType: "onboarding" },
      }),
    ], has_more: true },
    { data: [
      session("cs_first"),
      session("cs_onboarding_first", {
        amount_total: 6000, metadata: { bizAccountId: "biz_1", feeType: "onboarding" },
      }),
    ], has_more: false },
  );
  const report = await buildApplicantPaymentReport(reader, [saved], "test", now);
  assert.deepEqual(calls, [
    { limit: 100, created: { lte: now.getTime() / 1000 } },
    { limit: 100, created: { lte: now.getTime() / 1000 }, starting_after: "cs_onboarding_extra" },
  ]);
  assert.equal(report.summary.groupsWithMultipleSuccessfulSessions, 2);
  assert.equal(report.summary.groupsWithAdditionalSessions, 2);
  assert.deepEqual(report.groups[0].additionalSessions.map(s => [s.sessionId, s.amountCents, s.currency, s.stripeMode]),
    [["cs_extra", 100, "cad", "test"]]);
  assert.equal(report.groups[0].preservedReceipt?.sessionId, "cs_first");
  assert.equal(report.groups[1].additionalSessions[0].sessionId, "cs_onboarding_extra");
  assert.deepEqual(saved, snapshot, "report must not mutate the receipt input");
});

test("ignores unpaid, expired, free, subscription, and unattributable sessions; supports legacy application metadata", async () => {
  const report = await buildApplicantPaymentReport(onePage(
    session("cs_unpaid", { payment_status: "unpaid" }),
    session("cs_expired", { payment_status: "unpaid", status: "expired" }),
    session("cs_free", { payment_status: "no_payment_required" }),
    session("cs_subscription", { mode: "subscription" }),
    session("cs_unrelated", { metadata: {} }),
    session("cs_first", { metadata: { bizAccountId: "biz_1" } }),
    session("cs_future", { metadata: { bizAccountId: "biz_1", feeType: "other" } }),
  ), [account()], "test", now);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0].successfulSessions.map(s => s.sessionId), ["cs_first"]);
  assert.deepEqual(report.groups[0].issues, []);
  assert.deepEqual(report.unsupportedFeeSessions.map(s => [s.sessionId, s.bizAccountId, s.feeType]),
    [["cs_future", "biz_1", "other"]]);
});

test("a repeated session across pages is not a second charge", async () => {
  const { reader } = pages(
    { data: [session("cs_first")], has_more: true },
    { data: [session("cs_first")], has_more: false },
  );
  const report = await buildApplicantPaymentReport(reader, [account()], "test", now);
  assert.equal(report.groups[0].successfulSessions.length, 1);
  assert.equal(report.summary.sessionsScanned, 1);
  assert.equal(report.summary.groupsWithMultipleSuccessfulSessions, 0);
});

test("does not treat an unpaid checkout offer as a receipt or infer a first receipt", async () => {
  const report = await buildApplicantPaymentReport(onePage(
    session("cs_offer"), session("cs_other"),
  ), [account({ stripeSessionId: "cs_offer", paidAt: null })], "test", now);
  assert.equal(report.groups[0].preservedReceipt, null);
  assert.equal(report.groups[0].successfulSessions.length, 2);
  assert.deepEqual(report.groups[0].additionalSessions, []);
  assert.ok(report.groups[0].issues.includes("multiple_successful_sessions"));
  assert.ok(report.groups[0].issues.includes("no_preserved_receipt"));
});

test("unknown accounts and paid receipts with no session ID remain reviewable", async () => {
  const report = await buildApplicantPaymentReport(onePage(
    session("cs_unknown", { metadata: { bizAccountId: "deleted_account" } }),
    session("cs_first"),
  ), [account({ stripeSessionId: null })], "test", now);
  assert.ok(report.groups.find(g => g.bizAccountId === "deleted_account")?.issues.includes("unknown_biz_account"));
  const known = report.groups.find(g => g.bizAccountId === "biz_1")!;
  assert.ok(known.issues.includes("preserved_receipt_has_no_session_id"));
  assert.equal(known.preservedReceipt?.sessionId, null);
  assert.deepEqual(known.additionalSessions, []);
});

test("missing preserved sessions do not acquire an invented amount or mode", async () => {
  const report = await buildApplicantPaymentReport(onePage(session("cs_extra", {
    amount_total: null, currency: null, livemode: true,
  })), [account({ applicationPaidAmountCents: null, applicationPaidCurrency: null })], "live", now);
  const group = report.groups[0];
  assert.deepEqual(group.preservedReceipt, {
    sessionId: "cs_first", paidAt: new Date("2025-01-01").toISOString(),
    amountCents: null, currency: null, stripeMode: null,
  });
  assert.equal(group.additionalSessions[0].stripeMode, "live");
  assert.equal(group.additionalSessions[0].amountCents, null);
  assert.equal(group.additionalSessions[0].currency, null);
  assert.ok(group.issues.includes("preserved_session_not_found_in_scanned_mode"));
});

test("reports amount and currency mismatches without overwriting historical values", async () => {
  const report = await buildApplicantPaymentReport(onePage(session("cs_first", {
    amount_total: 100, currency: "cad",
  })), [account()], "test", now);
  assert.equal(report.groups[0].preservedReceipt?.amountCents, 1900);
  assert.equal(report.groups[0].successfulSessions[0].amountCents, 100);
  assert.ok(report.groups[0].issues.includes("preserved_receipt_amount_or_currency_mismatch"));
});

test("empty Stripe history still shows unmatched saved receipts", async () => {
  const report = await buildApplicantPaymentReport(onePage(), [account()], "test", now);
  assert.equal(report.summary.sessionsScanned, 0);
  assert.ok(report.groups[0].issues.includes("preserved_session_not_found_in_scanned_mode"));
});

test("mode mismatch, empty continuation, stalled pagination and API failures reject instead of returning a partial report", async () => {
  await assert.rejects(buildApplicantPaymentReport(
    onePage(session("cs_live", { livemode: true })), [], "test", now,
  ), /mode mismatch/);
  await assert.rejects(buildApplicantPaymentReport(
    pages({ data: [], has_more: true }).reader, [], "test", now,
  ), /pagination did not advance/);
  await assert.rejects(buildApplicantPaymentReport(
    pages(
      { data: [session("cs_first")], has_more: true },
      { data: [session("cs_first")], has_more: true },
    ).reader, [], "test", now,
  ), /pagination did not advance/);
  let calls = 0;
  await assert.rejects(buildApplicantPaymentReport({
    async list() {
      if (++calls === 1) return { data: [session("cs_first")], has_more: true };
      throw new Error("Synthetic Stripe unavailable");
    },
  }, [], "test", now), /Synthetic Stripe unavailable/);
});

test("CLI help and invalid arguments never require Stripe or database access", () => {
  const cli = new URL("./reconcile-applicant-payments.ts", import.meta.url).pathname;
  const env = { ...process.env, DATABASE_URL: "", REPLIT_CONNECTORS_HOSTNAME: "" };
  const help = execFileSync(process.execPath, ["--import", "tsx", cli, "--help"], { env, encoding: "utf8" });
  assert.match(help, /Read-only historical/);
  for (const args of [[], ["--mode", "invalid"], ["--mode", "test", "--refund"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }
});
