import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, bizAccountsTable } from "@workspace/db";
import { api, TEST_PREFIX } from "./helpers";
import * as stripeClient from "../src/stripeClient";
import { ONBOARDING_FEE_CENTS } from "../src/lib/plans";
import * as plans from "../src/lib/plans";
import * as limits from "../src/lib/onboardingCheckoutLimits";

const id = `${TEST_PREFIX}_price_guard`;
const stripe = {
  prices: { search: vi.fn() },
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
};

beforeAll(async () => {
  await db.insert(bizAccountsTable).values({
    id, email: `${id}@example.test`, businessName: `${TEST_PREFIX} Price Guard`,
    ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
    status: "accepted", expiresAt: new Date(Date.now() + 86_400_000),
  });
});
beforeEach(async () => {
  await db.update(bizAccountsTable).set({
    status: "accepted", onboardingSessionId: null, onboardingPaidAt: null,
    paidAt: null, applicationPaidAmountCents: null, applicationPaidCurrency: null,
    onboardingPaidAmountCents: null, onboardingPaidCurrency: null,
  }).where(eq(bizAccountsTable.id, id));
  stripe.prices.search.mockReset().mockResolvedValue({ data: [] });
  stripe.checkout.sessions.create.mockReset().mockResolvedValue({
    id: "cs_test_synthetic", url: "https://checkout.example.test/synthetic",
  });
  stripe.checkout.sessions.retrieve.mockReset().mockResolvedValue({
    id: "cs_test_synthetic", url: "https://checkout.example.test/synthetic",
    status: "open", payment_status: "unpaid", amount_total: ONBOARDING_FEE_CENTS, currency: "usd",
    metadata: { bizAccountId: id, feeType: "onboarding" },
  });
  stripe.checkout.sessions.expire.mockReset().mockResolvedValue({ status: "expired" });
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue(
    stripe as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(bizAccountsTable).where(eq(bizAccountsTable.id, id));
});

it("rejects a stale onboarding amount before contacting Stripe", async () => {
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: ONBOARDING_FEE_CENTS + 1 });
  expect(result.status).toBe(409);
  expect(result.body.error).toMatch(/review/i);
  expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

it.each(["rejected", "approved"])("rejects unchanged-price checkout after acceptance becomes %s, preserving receipts", async status => {
  const applicationReceipt = { amountCents: 1900, currency: "usd" };
  const onboardingReceipt = { amountCents: 7900, currency: "usd" };
  await db.update(bizAccountsTable).set({
    paidAt: new Date("2026-08-01T00:00:00Z"),
    applicationPaidAmountCents: applicationReceipt.amountCents,
    applicationPaidCurrency: applicationReceipt.currency,
    onboardingPaidAmountCents: null, onboardingPaidCurrency: null,
  }).where(eq(bizAccountsTable.id, id));
  const displayedStatus = await api().get(`/api/biz-accounts/${id}/status`);
  const displayedFees = await api().get("/api/application-fees");
  expect(displayedStatus.status).toBe(200);
  expect(displayedStatus.body.status).toBe("accepted");
  expect(displayedStatus.body.applicationPayment).toEqual(applicationReceipt);
  expect(displayedFees.status).toBe(200);
  expect(displayedFees.body.onboardingFeeCents).toBe(ONBOARDING_FEE_CENTS);

  // Simulate the admin's committed change after the acceptance screen loaded.
  await db.update(bizAccountsTable).set({
    status,
    onboardingPaidAt: status === "approved" ? new Date("2026-08-02T00:00:00Z") : null,
    onboardingPaidAmountCents: status === "approved" ? onboardingReceipt.amountCents : null,
    onboardingPaidCurrency: status === "approved" ? onboardingReceipt.currency : null,
  }).where(eq(bizAccountsTable.id, id));
  const [before] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: displayedFees.body.onboardingFeeCents });
  expect(result.status).toBe(409);
  expect(result.body.error).toContain(`current status: "${status}"`);
  expect(result.body.checkoutUrl).toBeUndefined();

  const refreshedFees = await api().get("/api/application-fees");
  const refreshedStatus = await api().get(`/api/biz-accounts/${id}/status`);
  expect(refreshedFees.status).toBe(200);
  expect(refreshedFees.body).toEqual(displayedFees.body);
  expect(refreshedStatus.status).toBe(200);
  expect(refreshedStatus.body.status).toBe(status);
  expect(refreshedStatus.body.applicationPayment).toEqual(applicationReceipt);
  expect(refreshedStatus.body.onboardingPayment).toEqual(status === "approved" ? onboardingReceipt : null);
  expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
  expect(stripe.prices.search).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  const [after] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(after).toEqual(before);
});

it.each([-1, 1.5, "200", null])("rejects an invalid expected amount (%s)", async amount => {
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: amount });
  expect(result.status).toBe(400);
  expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

it("rejects the previously displayed offer after a config change, then accepts the freshly reviewed amount", async () => {
  const displayed = await api().get("/api/application-fees");
  expect(displayed.body.onboardingFeeCents).toBe(200);
  const [before] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));

  // Change only the in-process configuration export, never Stripe or live data.
  vi.spyOn(plans, "ONBOARDING_FEE_CENTS", "get").mockReturnValue(350);
  const stale = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: displayed.body.onboardingFeeCents });
  expect(stale.status).toBe(409);
  expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
  expect(stripe.prices.search).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  const [after] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(after).toEqual(before);

  const refreshed = await api().get("/api/application-fees");
  expect(refreshed.body.onboardingFeeCents).toBe(350);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  const retried = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: refreshed.body.onboardingFeeCents });
  expect(retried.status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(350);
});

it.each([true, false])("uses the unchanged configured fee (expected-amount supplied: %s)", async supplied => {
  const request = api().post(`/api/biz-accounts/${id}/onboarding-checkout`);
  const result = await (supplied ? request.send({ expectedOnboardingFeeCents: ONBOARDING_FEE_CENTS }) : request.send());
  expect(result.status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  const options = stripe.checkout.sessions.create.mock.calls[0][0];
  expect(options.line_items[0].price_data.unit_amount).toBe(ONBOARDING_FEE_CENTS);
  expect(options.line_items[0].price_data.currency).toBe("usd");
});

it("reuses one unpaid checkout across simultaneous requests and later retries", async () => {
  const requests = () => api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: ONBOARDING_FEE_CENTS });
  const results = await Promise.all([requests(), requests(), requests()]);
  results.push(await requests());
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(result.body.checkoutUrl).toBe("https://checkout.example.test/synthetic");
  }
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(3);
  expect(stripe.checkout.sessions.create.mock.calls[0][1]).toMatchObject({
    idempotencyKey: `onboarding:${id}:initial:${ONBOARDING_FEE_CENTS}`,
    maxNetworkRetries: 0,
  });
  expect(stripe.checkout.sessions.create.mock.calls[0][1].timeout).toBeGreaterThan(0);
  expect(stripe.checkout.sessions.create.mock.calls[0][1].timeout).toBeLessThanOrEqual(limits.ONBOARDING_NETWORK_BUDGET_MS);
  const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(saved.onboardingSessionId).toBe("cs_test_synthetic");
});

it("keeps the same idempotency key when an ambiguous Stripe failure is retried", async () => {
  stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("Synthetic response lost"));
  const request = () => api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect((await request()).status).toBe(502);
  expect((await request()).status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  expect(stripe.checkout.sessions.create.mock.calls[0][0]).toEqual(stripe.checkout.sessions.create.mock.calls[1][0]);
  expect(stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey)
    .toBe(stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey);
});

it.each(["expired", "wrong amount", "wrong currency"])("replaces an %s checkout safely", async reason => {
  await db.update(bizAccountsTable).set({ onboardingSessionId: "cs_test_old" }).where(eq(bizAccountsTable.id, id));
  stripe.checkout.sessions.retrieve.mockResolvedValue({
    id: "cs_test_old", url: "https://checkout.example.test/old",
    status: reason === "expired" ? "expired" : "open", payment_status: "unpaid",
    amount_total: reason === "wrong amount" ? 1900 : ONBOARDING_FEE_CENTS,
    currency: reason === "wrong currency" ? "cad" : "usd",
    metadata: { bizAccountId: id, feeType: "onboarding" },
  });
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(result.status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.create.mock.calls[0][1]).toMatchObject({
    idempotencyKey: `onboarding:${id}:cs_test_old:${ONBOARDING_FEE_CENTS}`,
    maxNetworkRetries: 0,
  });
  if (reason === "expired") {
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  } else {
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledExactlyOnceWith(
      "cs_test_old", {}, expect.objectContaining({ maxNetworkRetries: 0, timeout: expect.any(Number) }),
    );
    expect(stripe.checkout.sessions.expire.mock.invocationCallOrder[0])
      .toBeLessThan(stripe.checkout.sessions.create.mock.invocationCallOrder[0]);
  }
});

it.each([
  { status: "complete", payment_status: "paid" },
  { status: "complete", payment_status: "unpaid" },
  { status: "open", payment_status: "paid" },
])("does not create a checkout while the previous payment is $status/$payment_status", async state => {
  await db.update(bizAccountsTable).set({ onboardingSessionId: "cs_test_synthetic" }).where(eq(bizAccountsTable.id, id));
  stripe.checkout.sessions.retrieve.mockResolvedValue({
    ...state, metadata: { bizAccountId: id, feeType: "onboarding" },
  });
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(result.status).toBe(409);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

it.each(["retrieve", "expire"])("fails closed if Stripe cannot %s the existing checkout", async operation => {
  await db.update(bizAccountsTable).set({ onboardingSessionId: "cs_test_synthetic" }).where(eq(bizAccountsTable.id, id));
  stripe.checkout.sessions.retrieve.mockResolvedValue({
    id: "cs_test_synthetic", status: "open", payment_status: "unpaid", amount_total: 1900, currency: "usd",
    metadata: { bizAccountId: id, feeType: "onboarding" },
  });
  stripe.checkout.sessions[operation as "retrieve" | "expire"].mockRejectedValue(new Error("Synthetic Stripe failure"));
  const result = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(result.status).toBe(502);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(saved.onboardingSessionId).toBe("cs_test_synthetic");
});

it("recovers a lost expiration reply without creating a second payable checkout", async () => {
  const predecessorId = "cs_test_old";
  const replacementId = "cs_test_synthetic";
  const attemptKey = `onboarding:${id}:${predecessorId}:${ONBOARDING_FEE_CENTS}`;
  const predecessor = {
    id: predecessorId, url: "https://checkout.example.test/old",
    status: "open", payment_status: "unpaid", amount_total: ONBOARDING_FEE_CENTS + 1, currency: "usd",
    metadata: { bizAccountId: id, feeType: "onboarding" },
  };
  const providerSessions = new Map([[predecessorId, predecessor]]);
  const retrievedStatuses: string[] = [];
  stripe.checkout.sessions.retrieve.mockImplementation(async sessionId => {
    const session = providerSessions.get(sessionId);
    if (!session) throw new Error("Unexpected synthetic checkout session");
    retrievedStatuses.push(session.status);
    // Return a snapshot, not a reference changed by the later expiration.
    return { ...session };
  });
  stripe.checkout.sessions.expire.mockImplementation(async sessionId => {
    expect(sessionId).toBe(predecessorId);
    predecessor.status = "expired";
    // The provider committed the mutation, but its reply never reached us.
    throw new Error("Synthetic expiration response lost");
  });
  stripe.checkout.sessions.create.mockImplementation(async () => {
    expect(predecessor.status).toBe("expired");
    const replacement = {
      ...predecessor, id: replacementId, url: "https://checkout.example.test/synthetic",
      status: "open", amount_total: ONBOARDING_FEE_CENTS,
    };
    providerSessions.set(replacementId, replacement);
    return replacement;
  });
  await db.update(bizAccountsTable).set({ onboardingSessionId: predecessorId }).where(eq(bizAccountsTable.id, id));
  const [before] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  const request = () => api().post(`/api/biz-accounts/${id}/onboarding-checkout`)
    .send({ expectedOnboardingFeeCents: ONBOARDING_FEE_CENTS });

  const failed = await request();
  expect(failed.status).toBe(502);
  expect(failed.body.checkoutUrl).toBeUndefined();
  expect(predecessor.status).toBe("expired");
  expect(retrievedStatuses).toEqual(["open"]);
  expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledOnce();
  expect(stripe.prices.search).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  const [afterFailure] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(afterFailure).toEqual(before);
  expect(afterFailure.onboardingSessionId).toBe(predecessorId);

  // Only a new, deliberate request can recover the provider's expired state.
  const retried = await request();
  expect(retried.status).toBe(200);
  expect(retried.body.checkoutUrl).toBe("https://checkout.example.test/synthetic");
  expect(retrievedStatuses).toEqual(["open", "expired"]);
  expect(stripe.checkout.sessions.retrieve.mock.calls.map(call => call[0]))
    .toEqual([predecessorId, predecessorId]);
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.create).toHaveBeenCalledExactlyOnceWith(
    expect.any(Object), expect.objectContaining({ idempotencyKey: attemptKey, maxNetworkRetries: 0 }),
  );
  expect(stripe.checkout.sessions.retrieve.mock.invocationCallOrder[1])
    .toBeLessThan(stripe.checkout.sessions.create.mock.invocationCallOrder[0]);
  const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(saved).toEqual({ ...before, onboardingSessionId: replacementId });

  const reused = await request();
  expect(reused.status).toBe(200);
  expect(reused.body.checkoutUrl).toBe(retried.body.checkoutUrl);
  expect(retrievedStatuses).toEqual(["open", "expired", "open"]);
  expect(stripe.checkout.sessions.retrieve.mock.calls.at(-1)![0]).toBe(replacementId);
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledOnce();
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  expect([...providerSessions.values()].filter(session => session.status === "open").map(session => session.id))
    .toEqual([replacementId]);
});

it("bounds lock contention, returns a retryable error and succeeds after release", async () => {
  vi.spyOn(limits, "ONBOARDING_LOCK_WAIT_MS", "get").mockReturnValue(50);
  let unlock!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const held = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding-checkout:${id}`}, 0))`);
    acquired();
    await release;
  });
  await ready;
  try {
    const response = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body.checkoutUrl).toBeUndefined();
    expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  } finally {
    unlock();
    await held;
  }
  expect((await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send()).status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
});

it("bounds a stalled credential read before any checkout mutation", async () => {
  vi.spyOn(limits, "ONBOARDING_NETWORK_BUDGET_MS", "get").mockReturnValue(40);
  vi.mocked(stripeClient.getUncachableStripeClient).mockImplementationOnce(
    () => new Promise<never>(() => {}),
  );
  const response = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(response.status).toBe(503);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(saved.onboardingSessionId).toBeNull();
});

type BudgetStage = "credentials" | "retrieve" | "expire" | "price" | "create";

function mockBudgetStages(exhaustAfter?: BudgetStage, wallClockAdjustment = 0) {
  // Mock elapsed time separately; real timers keep HTTP and Postgres responsive.
  let now = 0;
  let wallNow = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  vi.spyOn(limits, "ONBOARDING_NETWORK_BUDGET_MS", "get").mockReturnValue(1_000);
  const calls: Array<{ stage: BudgetStage; timeout?: number; maxNetworkRetries?: number }> = [];
  let expired = false;
  let deadline = now + 1_000;
  const finish = (stage: BudgetStage, elapsed: number) => {
    now += elapsed;
    wallNow += elapsed + wallClockAdjustment;
    if (stage === exhaustAfter) now = deadline;
  };
  vi.mocked(stripeClient.getUncachableStripeClient).mockImplementation(async () => {
    // Every HTTP retry gets a fresh budget, but not a new attempt identity.
    deadline = now + 1_000;
    calls.push({ stage: "credentials" });
    finish("credentials", 100);
    return stripe as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>;
  });
  stripe.checkout.sessions.retrieve.mockImplementation(async (_id, _params, options) => {
    calls.push({ stage: "retrieve", ...options });
    finish("retrieve", 200);
    return {
      id: "cs_test_old", status: expired ? "expired" : "open", payment_status: "unpaid",
      amount_total: ONBOARDING_FEE_CENTS + 1, currency: "usd",
      metadata: { bizAccountId: id, feeType: "onboarding" },
    };
  });
  stripe.checkout.sessions.expire.mockImplementation(async (_id, _params, options) => {
    calls.push({ stage: "expire", ...options });
    expired = true;
    finish("expire", 300);
    return { status: "expired" };
  });
  stripe.prices.search.mockImplementation(async (_params, options) => {
    calls.push({ stage: "price", ...options });
    finish("price", 150);
    return { data: [] };
  });
  stripe.checkout.sessions.create.mockImplementation(async (_params, options) => {
    calls.push({ stage: "create", ...options });
    if (exhaustAfter === "create") {
      // The synthetic SDK aborts at its supplied HTTP timeout, not a new budget.
      now += options.timeout;
      throw Object.assign(new Error("Synthetic HTTP timeout"), { type: "StripeConnectionError" });
    }
    finish("create", 100);
    return { id: "cs_test_synthetic", url: "https://checkout.example.test/synthetic" };
  });
  return { calls, recover: () => { exhaustAfter = undefined; } };
}

const expectedBudgetCalls = [
  { stage: "credentials" },
  { stage: "retrieve", timeout: 900, maxNetworkRetries: 0 },
  { stage: "expire", timeout: 700, maxNetworkRetries: 0 },
  { stage: "price", timeout: 400, maxNetworkRetries: 0 },
  { stage: "create", timeout: 250, maxNetworkRetries: 0 },
];

it.each([0, -86_400_000, 86_400_000])("passes a decreasing shared timeout through every checkout stage with a %s ms clock adjustment", async adjustment => {
  await db.update(bizAccountsTable).set({ onboardingSessionId: "cs_test_old" }).where(eq(bizAccountsTable.id, id));
  const { calls } = mockBudgetStages(undefined, adjustment);
  const response = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(response.status).toBe(200);
  expect(response.body.checkoutUrl).toBe("https://checkout.example.test/synthetic");
  expect(calls).toEqual([
    ...expectedBudgetCalls.slice(0, -1),
    { ...expectedBudgetCalls.at(-1), idempotencyKey: `onboarding:${id}:cs_test_old:${ONBOARDING_FEE_CENTS}` },
  ]);
  const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(saved.onboardingSessionId).toBe("cs_test_synthetic");
});

it.each(
  (["credentials", "retrieve", "expire", "price", "create"] as BudgetStage[])
    .flatMap(stage => [0, -86_400_000, 86_400_000].map(adjustment => ({ stage, adjustment }))),
)(
  "stops after $stage exhausts the shared budget with a $adjustment ms clock adjustment and retries the same attempt",
  async ({ stage, adjustment }) => {
    await db.update(bizAccountsTable).set({ onboardingSessionId: "cs_test_old" }).where(eq(bizAccountsTable.id, id));
    const [before] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    const { calls, recover } = mockBudgetStages(stage, adjustment);
    const request = () => api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body.checkoutUrl).toBeUndefined();

    const lastStage = expectedBudgetCalls.findIndex(call => call.stage === stage);
    const expected = expectedBudgetCalls.slice(0, lastStage + 1);
    const attemptKey = `onboarding:${id}:cs_test_old:${ONBOARDING_FEE_CENTS}`;
    expect(calls).toEqual(expected.map(call => call.stage === "create"
      ? { ...call, idempotencyKey: attemptKey } : call));
    // Exact call counts also catch work scheduled after the 503 response.
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(lastStage >= 1 ? 1 : 0);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(lastStage >= 2 ? 1 : 0);
    expect(stripe.prices.search).toHaveBeenCalledTimes(lastStage >= 3 ? 1 : 0);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(lastStage >= 4 ? 1 : 0);
    const [after] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    expect(after).toEqual(before);

    const firstAttempt = stripe.checkout.sessions.create.mock.calls[0];
    recover();
    const retried = await request();
    expect(retried.status).toBe(200);
    expect(retried.body.checkoutUrl).toBe("https://checkout.example.test/synthetic");
    expect(stripe.checkout.sessions.retrieve.mock.calls.at(-1)![0]).toBe("cs_test_old");
    const retryAttempt = stripe.checkout.sessions.create.mock.calls.at(-1)!;
    expect(retryAttempt[1].idempotencyKey).toBe(attemptKey);
    if (firstAttempt) {
      expect(retryAttempt[0]).toEqual(firstAttempt[0]);
      expect(retryAttempt[1].idempotencyKey).toBe(firstAttempt[1].idempotencyKey);
    }
    const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    expect(saved.onboardingSessionId).toBe("cs_test_synthetic");
    expect(saved.onboardingPaidAt).toBeNull();
  },
);

it("keeps another applicant responsive during a slow provider call and preserves the retry key", async () => {
  vi.spyOn(limits, "ONBOARDING_NETWORK_BUDGET_MS", "get").mockReturnValue(500);
  const otherId = `${id}_other`;
  await db.insert(bizAccountsTable).values({
    id: otherId, email: `${otherId}@example.test`, businessName: `${TEST_PREFIX} Other applicant`,
    ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
    status: "accepted", expiresAt: new Date(Date.now() + 86_400_000),
  });
  let started!: () => void;
  const creating = new Promise<void>(resolve => { started = resolve; });
  stripe.checkout.sessions.create.mockImplementation(async (params, options) => {
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(500);
    expect(options.maxNetworkRetries).toBe(0);
    if (params.metadata.bizAccountId === id) {
      started();
      // Simulate the SDK aborting its HTTP request at the supplied timeout.
      await new Promise(resolve => setTimeout(resolve, options.timeout));
      throw Object.assign(new Error("Synthetic HTTP timeout"), { type: "StripeConnectionError" });
    }
    return { id: "cs_test_other", url: "https://checkout.example.test/other" };
  });
  const slow = api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send().then(result => result);
  try {
    await creating;
    const other = await api().post(`/api/biz-accounts/${otherId}/onboarding-checkout`).send();
    expect(other.status).toBe(200);
    expect(other.body.checkoutUrl).toBe("https://checkout.example.test/other");
    const failed = await slow;
    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("2");
    const [saved] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    expect(saved.onboardingSessionId).toBeNull();
    expect(saved.onboardingPaidAt).toBeNull();
    const previousKey = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_test_synthetic", url: "https://checkout.example.test/synthetic",
    });
    const retried = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
    expect(retried.status).toBe(200);
    expect(stripe.checkout.sessions.create.mock.calls.at(-1)![1].idempotencyKey).toBe(previousKey);
  } finally {
    await slow;
    await db.delete(bizAccountsTable).where(eq(bizAccountsTable.id, otherId));
  }
});

it("returns a retryable response while Stripe is still finishing the same idempotent attempt", async () => {
  stripe.checkout.sessions.create.mockRejectedValueOnce(Object.assign(
    new Error("Synthetic attempt still in progress"), { code: "idempotency_key_in_use" },
  ));
  const response = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(response.status).toBe(503);
  expect(response.headers["retry-after"]).toBe("2");
  expect(response.body.checkoutUrl).toBeUndefined();
});
