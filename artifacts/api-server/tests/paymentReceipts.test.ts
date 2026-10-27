import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, bizAccountsTable, usersTable, businessesTable, stripeWebhookDeadLetterTable } from "@workspace/db";
import { api, TEST_PREFIX, getAnyCategoryId, createAdminUser } from "./helpers";
import * as stripeClient from "../src/stripeClient";
import * as meetingEmail from "../src/lib/meetingEmail";
import { replayDeadLetterRow, WebhookHandlers } from "../src/webhookHandlers";
import { paymentReceipt } from "../src/lib/paymentReceipts";

const prefix = `${TEST_PREFIX}_receipt`;
let counter = 0;
const retrieve = vi.fn();
beforeEach(() => {
  retrieve.mockReset();
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue(
    { checkout: { sessions: { retrieve } } } as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>,
  );
  vi.spyOn(meetingEmail, "sendMeetingEmail").mockResolvedValue(undefined).mockClear();
});
afterAll(async () => {
  await db.delete(businessesTable).where(like(businessesTable.ownerId, `${prefix}%`));
  await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${prefix}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${prefix}%`));
  await db.delete(stripeWebhookDeadLetterTable).where(like(stripeWebhookDeadLetterTable.id, `${prefix}%`));
  await db.delete(stripeWebhookDeadLetterTable).where(like(stripeWebhookDeadLetterTable.eventId, `${prefix}%`));
  vi.restoreAllMocks();
});

async function application(status: "awaiting_payment" | "accepted" | "pending") {
  const id = `${prefix}_${++counter}`;
  await db.insert(usersTable).values({ id, name: "Synthetic Owner", email: `${id}@example.test`, role: "business" });
  await db.insert(bizAccountsTable).values({
    id, email: `${id}@example.test`, businessName: `${prefix} Historical Payment`,
    ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
    status, ownerId: id, stripeSessionId: `cs_test_${id}`,
    paidAt: status === "awaiting_payment" ? null : new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

async function replay(id: string, feeType: string, amount: number | null, currency: string | null = "usd", expectedOk: boolean | null = true, sessionId = `cs_test_${id}`) {
  const eventId = `${prefix}_event_${++counter}`;
  const event = {
      id: eventId, type: "checkout.session.completed",
      data: { object: {
        id: sessionId, mode: "payment", payment_status: "paid",
        amount_total: amount, currency, metadata: { bizAccountId: id, feeType },
      } },
  };
  await db.insert(stripeWebhookDeadLetterTable).values({
    id: eventId, eventId, eventType: event.type, handlerName: "biz_account_paid",
    payload: event, lastError: "Synthetic receipt replay",
  });
  const result = await replayDeadLetterRow({ id: eventId, handlerName: "biz_account_paid", payload: event });
  if (expectedOk !== null) expect(result.ok).toBe(expectedOk);
  return { eventId, result };
}

it("records the actual application payment from a webhook, not the current $1 fee", async () => {
  const id = await application("awaiting_payment");
  await replay(id, "application", 1900);
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.status).toBe("pending");
  expect(result.body.applicationPayment).toEqual({ amountCents: 1900, currency: "usd" });
  await replay(id, "application", 100);
  const unchanged = await api().get(`/api/biz-accounts/${id}/status`);
  expect(unchanged.body.applicationPayment.amountCents).toBe(1900);
});

it("records the actual onboarding payment, independently from current pricing", async () => {
  await getAnyCategoryId();
  const id = await application("accepted");
  await replay(id, "onboarding", 6400);
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.status).toBe("approved");
  expect(result.body.onboardingPayment).toEqual({ amountCents: 6400, currency: "usd" });
  await replay(id, "onboarding", 200);
  const unchanged = await api().get(`/api/biz-accounts/${id}/status`);
  expect(unchanged.body.onboardingPayment).toEqual({ amountCents: 6400, currency: "usd" });
});

it("preserves an onboarding receipt when approval fails and a later payment retries it", async () => {
  const id = await application("accepted");
  await db.update(bizAccountsTable).set({ ownerId: null }).where(eq(bizAccountsTable.id, id));
  await replay(id, "onboarding", 6400, "cad", false);
  await replay(id, "onboarding", 200, "usd", false);
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.status).toBe("accepted");
  expect(result.body.onboardingPayment).toEqual({ amountCents: 6400, currency: "cad" });
  await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
  await replay(id, "onboarding", 200, "usd");
  const approved = await api().get(`/api/biz-accounts/${id}/status`);
  expect(approved.body.status).toBe("approved");
  expect(approved.body.onboardingPayment).toEqual({ amountCents: 6400, currency: "cad" });
});

it("keeps the actual paid currency instead of replacing it with the current USD offer", async () => {
  const id = await application("awaiting_payment");
  await replay(id, "application", 2900, "CAD");
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.applicationPayment).toEqual({ amountCents: 2900, currency: "cad" });
});

it("leaves a paid session without a total unknown", async () => {
  const id = await application("awaiting_payment");
  await replay(id, "application", null);
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.status).toBe("pending");
  expect(result.body.applicationPayment).toBeNull();
});

it("records the actual amount when recovering a missed application webhook", async () => {
  const id = await application("awaiting_payment");
  retrieve.mockResolvedValue({
    payment_status: "paid", amount_total: 7900, currency: "usd", metadata: { bizAccountId: id },
  });
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.status).toBe("pending");
  expect(result.body.applicationPayment).toEqual({ amountCents: 7900, currency: "usd" });
  await api().get(`/api/biz-accounts/${id}/status`);
  expect(retrieve).toHaveBeenCalledOnce();
});

it("leaves legacy paid amounts unknown instead of inventing a receipt from current fees", async () => {
  const id = await application("pending");
  const result = await api().get(`/api/biz-accounts/${id}/status`);
  expect(result.body.applicationPayment).toBeNull();
  expect(result.body.onboardingPayment).toBeNull();
  expect(retrieve).not.toHaveBeenCalled();
});

it("does not invent receipts from missing or malformed Stripe totals", () => {
  expect(paymentReceipt(null, "usd")).toBeNull();
  expect(paymentReceipt(100, null)).toBeNull();
  expect(paymentReceipt(-100, "usd")).toBeNull();
  expect(paymentReceipt(1.5, "usd")).toBeNull();
  expect(paymentReceipt(100, "US")).toBeNull();
  expect(paymentReceipt(100, "USD")).toEqual({ amountCents: 100, currency: "usd" });
});

let webhookSecretsStubbed = false;
it.each(["application", "onboarding"] as const)(
  "surfaces a separate %s charge to admins, but not repeat delivery of the same session",
  async (feeType) => {
    const id = await application(feeType === "application" ? "awaiting_payment" : "accepted");
    const admin = await createAdminUser();
    const constructEvent = vi.fn();
    vi.spyOn(stripeClient, "getStripeSync").mockResolvedValue({
      processWebhook: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof stripeClient.getStripeSync>>);
    vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
      webhooks: { constructEvent },
    } as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>);
    // Stub only the initial signing-secret lookup; all receipt/queue writes
    // below use the real test DB, never Stripe or real email.
    if (!webhookSecretsStubbed) {
      vi.spyOn(db, "execute").mockResolvedValueOnce({
        rows: [{ secret: "synthetic_webhook_secret" }], rowCount: 1,
      } as Awaited<ReturnType<typeof db.execute>>);
      webhookSecretsStubbed = true;
    }
    const event = {
      id: `${prefix}_live_${++counter}`, type: "checkout.session.completed",
      data: { object: {
        id: `cs_first_${id}`, mode: "payment", payment_status: "paid",
        amount_total: 6400, currency: "cad", metadata: { bizAccountId: id, feeType },
      } },
    };
    const deliver = async () => {
      constructEvent.mockReturnValue(event);
      return WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    };
    const account = async () => (await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id)))[0];
    await deliver();
    const original = await account();
    // A new event ID for the same session is still a harmless redelivery.
    event.id = `${prefix}_live_${++counter}`;
    await deliver();
    expect(await account()).toEqual(original);
    expect(await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.eventId, event.id))).toHaveLength(0);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);

    event.id = `${prefix}_live_${++counter}`;
    event.data.object.id = `cs_extra_${id}`;
    event.data.object.amount_total = 200;
    event.data.object.currency = "usd";
    await expect(deliver()).rejects.toThrow(`Duplicate ${feeType} payment`);
    const [alert] = await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.eventId, event.id));
    expect(alert).toMatchObject({ status: "pending", payload: event, handlerName: "biz_account_paid" });
    expect(alert.payload).toHaveProperty("_duplicatePayment", {
      originalSessionId: `cs_first_${id}`, extraSessionId: `cs_extra_${id}`,
    });
    for (const detail of [id, `cs_first_${id}`, `cs_extra_${id}`, "200 usd", "refund review"]) {
      expect(alert.lastError).toContain(detail);
    }
    const list = await api().get("/api/admin/stripe-webhook-dead-letter?limit=200")
      .set("Authorization", `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.entries).toContainEqual(expect.objectContaining({
      id: alert.id, status: "pending", lastError: expect.stringContaining(`Duplicate ${feeType} payment`),
    }));
    const retry = await api().post(`/api/admin/stripe-webhook-dead-letter/${alert.id}/retry`)
      .set("Authorization", `Bearer ${admin.token}`);
    expect(retry.status).toBe(500);
    expect(retry.body.error).toContain("refund review");
    const [pending] = await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.id, alert.id));
    expect(pending.status).toBe("pending");
    expect(pending.payload).toHaveProperty("_duplicatePayment", {
      originalSessionId: `cs_first_${id}`, extraSessionId: `cs_extra_${id}`,
    });
    expect(await account()).toEqual(original);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    // A different, unpaid checkout is not evidence of a duplicate charge.
    event.id = `${prefix}_live_${++counter}`;
    event.data.object.id = `cs_unpaid_${id}`;
    event.data.object.payment_status = "unpaid";
    await deliver();
    expect(await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.eventId, event.id))).toHaveLength(0);
    expect(await account()).toEqual(original);
  },
);

it.each(["application", "onboarding"] as const)(
  "still flags an extra %s payment after rejection even if the extra total is unknown",
  async (feeType) => {
    const id = await application(feeType === "application" ? "awaiting_payment" : "accepted");
    await replay(id, feeType, 6400, "cad");
    await db.update(bizAccountsTable).set({ status: "rejected" }).where(eq(bizAccountsTable.id, id));
    const [original] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    const { result } = await replay(id, feeType, null, null, false, `cs_extra_${id}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("amount/currency unknown") });
    expect((await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id)))[0]).toEqual(original);
  },
);

it("flags an extra onboarding charge even when the original payment is awaiting activation recovery", async () => {
  const id = await application("accepted");
  await db.update(bizAccountsTable).set({ ownerId: null }).where(eq(bizAccountsTable.id, id));
  const create = vi.fn().mockResolvedValue({ id: `cs_test_${id}`, url: "https://checkout.example.test/original" });
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
    prices: { search: vi.fn().mockResolvedValue({ data: [] }) },
    checkout: { sessions: { create } },
  } as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>);
  const checkout = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(checkout.status).toBe(200);
  expect(create).toHaveBeenCalledOnce();
  await replay(id, "onboarding", 6400, "cad", false);
  const [original] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  const blocked = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toContain("already been received");
  expect(create).toHaveBeenCalledOnce();
  const { result } = await replay(id, "onboarding", 200, "usd", false, `cs_extra_${id}`);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Duplicate onboarding payment") });
  expect((await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id)))[0]).toEqual(original);
  // Recover using the ORIGINAL payment, not the extra charge.
  await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
  await replay(id, "onboarding", 6400, "cad");
});

it("does not overwrite a confirmed onboarding session when payment arrives during checkout creation", async () => {
  const id = await application("accepted");
  await db.update(bizAccountsTable).set({ ownerId: null }).where(eq(bizAccountsTable.id, id));
  const create = vi.fn().mockImplementation(async () => {
    await replay(id, "onboarding", 6400, "cad", false);
    return { id: `cs_extra_${id}`, url: "https://checkout.example.test/extra" };
  });
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
    prices: { search: vi.fn().mockResolvedValue({ data: [] }) },
    checkout: { sessions: { create } },
  } as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>);
  const response = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`).send();
  expect(response.status).toBe(409);
  expect(response.body.checkoutUrl).toBeUndefined();
  const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  expect(acct).toMatchObject({
    status: "accepted", onboardingSessionId: `cs_test_${id}`,
    onboardingPaidAmountCents: 6400, onboardingPaidCurrency: "cad",
  });
  await replay(id, "onboarding", 200, "usd", false, `cs_extra_${id}`);
  await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
  await replay(id, "onboarding", 6400, "cad");
});

it.each(["application", "onboarding"] as const)(
  "does not silently lose a concurrent separate %s payment",
  async (feeType) => {
    const id = await application(feeType === "application" ? "awaiting_payment" : "accepted");
    // Keep onboarding accepted so this isolates competing receipt capture from
    // activation races; both sessions must fail, but only one is a duplicate.
    if (feeType === "onboarding") {
      await db.update(bizAccountsTable).set({ ownerId: null }).where(eq(bizAccountsTable.id, id));
    }
    const outcomes = await Promise.all([
      replay(id, feeType, 6400, "cad", null),
      replay(id, feeType, 200, "usd", null, `cs_second_${id}`),
    ]);
    const duplicates = outcomes.filter(({ result }) => !result.ok && result.error.includes(`Duplicate ${feeType} payment`));
    expect(duplicates).toHaveLength(1);
    expect(outcomes.filter(({ result }) => result.ok)).toHaveLength(feeType === "application" ? 1 : 0);
    const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    const winningSession = feeType === "application" ? acct.stripeSessionId : acct.onboardingSessionId;
    const winningAmount = feeType === "application" ? acct.applicationPaidAmountCents : acct.onboardingPaidAmountCents;
    expect(winningAmount).toBe(winningSession === `cs_second_${id}` ? 200 : 6400);
  },
);
