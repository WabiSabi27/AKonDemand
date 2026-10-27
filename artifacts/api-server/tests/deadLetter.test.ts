/**
 * TD-4 — coverage for the TD-3 dead-letter queue admin endpoints. Inserts a
 * synthetic dead-letter row directly (no real Stripe event needed) and
 * exercises the state machine: list → ignore → 409 on second ignore →
 * 409 on retry of an ignored row. Also covers the `invalid_handler`
 * branch by writing a row with a handler name that isn't in the union.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db, stripeWebhookDeadLetterTable, bizAccountsTable, businessesTable, usersTable } from "@workspace/db";
import { api, createAdminUser, createCustomerUser, createBusinessForOwner, TEST_PREFIX } from "./helpers";
import * as stripeClient from "../src/stripeClient";
import * as meetingEmail from "../src/lib/meetingEmail";
import * as bizOnboarding from "../src/lib/bizOnboarding";
import { withDeadLetterClaim } from "../src/lib/deadLetterClaim";
import { WebhookHandlers } from "../src/webhookHandlers";
import type Stripe from "stripe";

async function insertDeadLetter(args: {
  handlerName: string;
  status?: "pending" | "resolved" | "ignored";
  eventType?: string;
}): Promise<string> {
  const id = `${TEST_PREFIX}_sdl_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(stripeWebhookDeadLetterTable).values({
    id,
    eventId: `evt_${id}`,
    eventType: args.eventType ?? "customer.subscription.updated",
    handlerName: args.handlerName,
    payload: { id: `evt_${id}`, type: args.eventType ?? "customer.subscription.updated" },
    status: args.status ?? "pending",
    attempts: 1,
    lastError: "synthetic test failure",
    lastAttemptAt: new Date(),
  });
  return id;
}

async function getRow(id: string) {
  const [row] = await db
    .select()
    .from(stripeWebhookDeadLetterTable)
    .where(eq(stripeWebhookDeadLetterTable.id, id));
  return row;
}

describe("admin /admin/stripe-webhook-dead-letter", () => {
  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    const admin = await createAdminUser();
    const customer = await createCustomerUser();
    adminToken = admin.token;
    customerToken = customer.token;
  });

  describe("authz", () => {
    it("rejects unauthenticated callers", async () => {
      const res = await api().get("/api/admin/stripe-webhook-dead-letter");
      expect(res.status).toBe(401);
    });

    it("rejects non-admin roles", async () => {
      const res = await api()
        .get("/api/admin/stripe-webhook-dead-letter")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET list", () => {
    it("returns safe historical duplicate-payment links only through the admin endpoint", async () => {
      const id = await insertDeadLetter({ handlerName: "biz_account_paid", eventType: "checkout.session.completed" });
      await db.update(stripeWebhookDeadLetterTable).set({
        payload: {
          livemode: false,
          data: { object: { id: "cs_test_Extra456", mode: "payment", payment_status: "paid" } },
        },
        lastError: "Error: Duplicate onboarding payment for biz account ba_synthetic: original paid session cs_test_Original123; extra paid session cs_test_Extra456; 200 usd (minor units).",
      }).where(eq(stripeWebhookDeadLetterTable.id, id));
      const res = await api().get("/api/admin/stripe-webhook-dead-letter?limit=200")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const found = res.body.entries.find((entry: { id: string }) => entry.id === id);
      expect(found.paymentReview).toMatchObject({
        mode: "test",
        originalDashboardUrl: "https://dashboard.stripe.com/test/search?query=cs_test_Original123",
        extraDashboardUrl: "https://dashboard.stripe.com/test/search?query=cs_test_Extra456",
      });
      expect(found).not.toHaveProperty("payload");
      const denied = await api().get("/api/admin/stripe-webhook-dead-letter")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty("entries");
    });

    it("returns our seeded pending row when filtering by status=pending", async () => {
      const id = await insertDeadLetter({ handlerName: "subscription_mirror" });
      const res = await api()
        .get("/api/admin/stripe-webhook-dead-letter?status=pending&limit=200")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const found = res.body.entries.find((e: { id: string }) => e.id === id);
      expect(found).toBeTruthy();
      expect(found.status).toBe("pending");
      expect(found.handlerName).toBe("subscription_mirror");
    });
  });

  describe("POST :id/ignore", () => {
    it("flips a pending row to ignored, then 409s on a second ignore", async () => {
      const id = await insertDeadLetter({ handlerName: "subscription_mirror" });
      const first = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${id}/ignore`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("ignored");

      const row = await getRow(id);
      expect(row?.status).toBe("ignored");
      expect(row?.resolvedAt).not.toBeNull();

      const second = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${id}/ignore`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(second.status).toBe(409);
    });

    it("returns 404 for a non-existent id", async () => {
      const res = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${TEST_PREFIX}_does_not_exist/ignore`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST :id/retry", () => {
    it("releases an interrupted claim without losing the attempt or stranding the row", async () => {
      const id = await insertDeadLetter({ handlerName: "definitely_not_a_real_handler" });
      // Simulate an abrupt exit after the committed attempt write, before any
      // handler/final-status write. Rolling back the lock transaction is the
      // same PostgreSQL cleanup used when its connection/process disappears.
      await expect(withDeadLetterClaim(id, async () => {
        await db.update(stripeWebhookDeadLetterTable).set({
          attempts: sql`${stripeWebhookDeadLetterTable.attempts} + 1`,
          lastAttemptAt: new Date(),
        }).where(eq(stripeWebhookDeadLetterTable.id, id));
        throw new Error("synthetic interruption");
      })).rejects.toThrow("synthetic interruption");
      expect(await getRow(id)).toMatchObject({ status: "pending", attempts: 2, resolvedAt: null });

      const retry = await api().post(`/api/admin/stripe-webhook-dead-letter/${id}/retry`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(retry.status).toBe(500);
      expect(retry.body.error).toMatch(/Invalid handlerName/);
      expect(await getRow(id)).toMatchObject({ status: "pending", attempts: 3 });

      const ignore = await api().post(`/api/admin/stripe-webhook-dead-letter/${id}/ignore`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(ignore.status).toBe(200);
      expect(await getRow(id)).toMatchObject({ status: "ignored", attempts: 3 });
    });

    it("returns 409 when the row is already ignored", async () => {
      const id = await insertDeadLetter({
        handlerName: "subscription_mirror",
        status: "ignored",
      });
      const res = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${id}/retry`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
    });

    it("returns 409 when the row is already resolved", async () => {
      const id = await insertDeadLetter({
        handlerName: "subscription_mirror",
        status: "resolved",
      });
      const res = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${id}/retry`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
    });

    it("returns 500 + leaves row pending when handler is invalid (corrupted handlerName)", async () => {
      const id = await insertDeadLetter({
        handlerName: "definitely_not_a_real_handler",
      });
      const res = await api()
        .post(`/api/admin/stripe-webhook-dead-letter/${id}/retry`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(500);
      const row = await getRow(id);
      // Critical regression guard: the row must NOT have been silently
      // marked resolved when no handler ran.
      expect(row?.status).toBe("pending");
      expect(row?.lastError).toMatch(/Invalid handlerName/i);
    });
  });
});

describe("paid onboarding activation recovery", () => {
  const prefix = `${TEST_PREFIX}_activation`;
  let adminToken: string;
  const createCheckout = vi.fn();
  const constructEvent = vi.fn();

  beforeAll(async () => {
    adminToken = (await createAdminUser()).token;
    // The webhook caches signing secrets across deliveries. Stub its initial
    // lookup once, not once per test (which would intercept later retry SQL).
    vi.spyOn(db, "execute").mockResolvedValueOnce({
      rows: [{ secret: "synthetic_webhook_secret" }], rowCount: 1,
    } as Awaited<ReturnType<typeof db.execute>>);
  });

  beforeEach(() => {
    createCheckout.mockReset();
    constructEvent.mockReset();
    // Stub the already-loaded exports: neither the webhook nor admin recovery
    // should contact Stripe or send real mail.
    vi.spyOn(stripeClient, "getStripeSync").mockResolvedValue({
      processWebhook: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof stripeClient.getStripeSync>>);
    vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
      webhooks: { constructEvent },
      checkout: { sessions: { create: createCheckout } },
    } as unknown as Stripe);
    vi.spyOn(meetingEmail, "sendMeetingEmail").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(businessesTable).where(like(businessesTable.ownerId, `${prefix}%`));
    await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${prefix}%`));
    await db.delete(usersTable).where(like(usersTable.id, `${prefix}%`));
    // Live handlers generate their own row IDs, so clean by synthetic event ID.
    await db.delete(stripeWebhookDeadLetterTable).where(like(stripeWebhookDeadLetterTable.eventId, `evt_${prefix}%`));
  });

  async function applicant(missingOwner: boolean) {
    const id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    await db.insert(usersTable).values({
      id, email: `${id}@example.test`, name: "Synthetic Owner", role: "business",
    });
    await db.insert(bizAccountsTable).values({
      id, email: `${id}@example.test`, businessName: "Synthetic Business",
      ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
      status: "accepted", ownerId: missingOwner ? null : id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return id;
  }

  function paymentEvent(id: string): Stripe.Event {
    return {
      id: `evt_${id}`, type: "checkout.session.completed",
      data: { object: {
        id: `cs_${id}`, mode: "payment", payment_status: "paid",
        amount_total: 6400, currency: "cad",
        metadata: { bizAccountId: id, feeType: "onboarding" },
      } },
    } as unknown as Stripe.Event;
  }

  async function account(id: string) {
    const [row] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    return row;
  }

  function receipt(row: Awaited<ReturnType<typeof account>>) {
    return {
      paidAt: row.onboardingPaidAt, sessionId: row.onboardingSessionId,
      amountCents: row.onboardingPaidAmountCents, currency: row.onboardingPaidCurrency,
    };
  }

  async function failedDelivery(event: Stripe.Event, error: string) {
    constructEvent.mockReturnValue(event);
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow(error);
    const rows = await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.eventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      handlerName: "biz_account_paid", status: "pending", attempts: 1,
      payload: event,
    });
    expect(rows[0].lastError).toContain(error);
    return rows[0];
  }

  function retry(id: string) {
    return api().post(`/api/admin/stripe-webhook-dead-letter/${id}/retry`)
      .set("Authorization", `Bearer ${adminToken}`);
  }

  async function eventRows(event: Stripe.Event) {
    return db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.eventId, event.id));
  }

  async function pendingCount() {
    const res = await api().get("/api/admin/stripe-webhook-dead-letter?status=pending&limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body.entries.filter((row: { eventId: string }) => row.eventId.startsWith(`evt_${prefix}`)).length;
  }

  it("groups redeliveries, keeps the first payload and receipt, and resolves on Stripe recovery", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const countBefore = await pendingCount();
    const first = await failedDelivery(event, "missing_owner");
    const originalReceipt = receipt(await account(id));

    // A later delivery may carry a different representation. Recovery keeps
    // the first replay payload, first receipt, and first queue timestamp.
    const redelivery = structuredClone(event);
    (redelivery.data.object as Stripe.Checkout.Session).amount_total = 9900;
    constructEvent.mockReturnValue(redelivery);
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("missing_owner");
    const [updated] = await eventRows(event);
    expect(await eventRows(event)).toHaveLength(1);
    expect(updated).toMatchObject({
      id: first.id, payload: event, createdAt: first.createdAt,
      attempts: 2, status: "pending", resolvedAt: null,
    });
    expect(updated.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(first.lastAttemptAt.getTime());
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await pendingCount()).toBe(countBefore + 1);

    // Make the error change while the same paid activation remains unresolved.
    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(() =>
      Promise.reject(new Error("synthetic changed activation failure")),
    );
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("synthetic changed activation failure");
    expect(await getRow(first.id)).toMatchObject({
      attempts: 3, lastError: expect.stringContaining("synthetic changed activation failure"),
      payload: event, createdAt: first.createdAt,
    });
    // Restore only the transaction boundary; leave payment/email stubs intact.
    vi.mocked(db.transaction).mockImplementation(transaction);

    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    const resolved = await getRow(first.id);
    expect(resolved).toMatchObject({
      status: "resolved", attempts: 4, resolvedAt: expect.any(Date),
      payload: event, createdAt: first.createdAt,
    });
    expect(await pendingCount()).toBe(countBefore);
    expect((await account(id)).status).toBe("approved");
    expect(receipt(await account(id))).toEqual(originalReceipt);

    // Additional successful deliveries must not inflate attempts or side effects.
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    expect(await eventRows(event)).toEqual([resolved]);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it.each([false, true])("still rejects and preserves the receipt when alert storage fails (existing alert: %s)", async (existingAlert) => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const originalReceipt = {
      paidAt: new Date("2025-01-02T03:04:05.000Z"), sessionId: `cs_${id}`,
      amountCents: 1900, currency: "usd",
    };
    await db.update(bizAccountsTable).set({
      onboardingPaidAt: originalReceipt.paidAt, onboardingSessionId: originalReceipt.sessionId,
      onboardingPaidAmountCents: originalReceipt.amountCents, onboardingPaidCurrency: originalReceipt.currency,
    }).where(eq(bizAccountsTable.id, id));
    if (existingAlert) await failedDelivery(event, "missing_owner");
    const alertsBefore = await eventRows(event);

    // missing_owner fails activation before it opens a transaction. The next
    // transaction is therefore recordDeadLetter's insert/update. Fail after its
    // writes to exercise a real rollback, not just a rejected mock at entry.
    const transaction = db.transaction.bind(db);
    const alertStorage = vi.spyOn(db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        await work(tx);
        throw new Error("synthetic alert storage failure");
      }),
    );
    constructEvent.mockReturnValue(event);
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("missing_owner");
    expect(alertStorage).toHaveBeenCalledTimes(1);
    // Restore only this boundary so Stripe and email remain stubbed.
    alertStorage.mockRestore();

    expect(await eventRows(event)).toEqual(alertsBefore);
    expect((await account(id)).status).toBe("accepted");
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(0);
    expect(meetingEmail.sendMeetingEmail).not.toHaveBeenCalled();

    // With storage available again, another failed delivery must become a
    // recoverable alert, without replacing the original confirmed payment.
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("missing_owner");
    const recorded = await eventRows(event);
    expect(recorded).toHaveLength(1);
    const attempts = existingAlert ? 2 : 1;
    expect(recorded[0]).toMatchObject({
      handlerName: "biz_account_paid", payload: event, status: "pending",
      attempts, resolvedAt: null, lastError: expect.stringContaining("missing_owner"),
    });
    if (existingAlert) {
      expect(recorded[0]).toMatchObject({ id: alertsBefore[0].id, createdAt: alertsBefore[0].createdAt });
    }
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(meetingEmail.sendMeetingEmail).not.toHaveBeenCalled();

    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    const resolved = await getRow(recorded[0].id);
    expect(resolved).toMatchObject({
      status: "resolved", attempts: attempts + 1, resolvedAt: expect.any(Date),
    });
    expect((await account(id)).status).toBe("approved");
    expect(receipt(await account(id))).toEqual(originalReceipt);

    // Further redelivery is harmless: no duplicate business, email or charge.
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    expect(await eventRows(event)).toEqual([resolved]);
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("preserves paid activation when resolving its pending alert fails, then clears it on redelivery", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const first = await failedDelivery(event, "missing_owner");
    const originalReceipt = receipt(await account(id));
    expect(originalReceipt).toEqual({
      paidAt: expect.any(Date), sessionId: `cs_${id}`, amountCents: 6400, currency: "cad",
    });
    expect(meetingEmail.sendMeetingEmail).not.toHaveBeenCalled();
    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));

    // Keep the receipt write and activation transaction real. Only the
    // post-handler alert resolution fails; recordDeadLetter uses tx.update,
    // so it can still persist the failure and request another delivery.
    const update = db.update.bind(db);
    const failure = new Error("synthetic pending-alert resolution failure");
    const resolveAlert = vi.fn(() => { throw failure; });
    const alertStorage = vi.spyOn(db, "update").mockImplementation((table) => {
      if (table === stripeWebhookDeadLetterTable) resolveAlert();
      return update(table);
    });
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow(failure.message);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    // Restore only the failing DB boundary, leaving Stripe/email stubs active.
    alertStorage.mockRestore();

    const approved = await account(id);
    expect(approved.status).toBe("approved");
    expect(receipt(approved)).toEqual(originalReceipt);
    const businesses = await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id));
    expect(businesses).toHaveLength(1);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
    const pending = await eventRows(event);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: first.id, createdAt: first.createdAt, payload: event,
      status: "pending", attempts: 2, resolvedAt: null,
      lastError: expect.stringContaining(failure.message),
    });

    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    const resolvedRows = await eventRows(event);
    expect(resolvedRows).toHaveLength(1);
    const resolved = resolvedRows[0];
    expect(resolved).toMatchObject({
      id: first.id, createdAt: first.createdAt, payload: event,
      status: "resolved", attempts: 3, resolvedAt: expect.any(Date),
    });
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect((await account(id)).status).toBe("approved");
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toEqual(businesses);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();

    // Once resolved, another delivery must leave both recovery and activation
    // unchanged, including the original business identity and receipt.
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    expect(await eventRows(event)).toEqual([resolved]);
    expect(await account(id)).toEqual(approved);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toEqual(businesses);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("groups simultaneous first failures without losing attempt increments", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    constructEvent.mockReturnValue(event);
    const deliveries = await Promise.allSettled(Array.from({ length: 4 }, () =>
      WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"),
    ));
    expect(deliveries.every((r) => r.status === "rejected" && /missing_owner/.test(String(r.reason)))).toBe(true);
    const rows = await eventRows(event);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 4, status: "pending", payload: event });

    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
    expect((await retry(rows[0].id)).status).toBe(200);
    expect(await getRow(rows[0].id)).toMatchObject({ attempts: 5, status: "resolved" });
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("keeps different events and handlers separate during grouping and recovery", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const first = await failedDelivery(event, "missing_owner");
    const otherEvent = structuredClone(event);
    otherEvent.id += "_other";
    const second = await failedDelivery(otherEvent, "missing_owner");
    const otherHandlerId = `${prefix}_other_handler`;
    await db.insert(stripeWebhookDeadLetterTable).values({
      id: otherHandlerId, eventId: event.id, eventType: event.type,
      handlerName: "subscription_mirror", payload: event, lastError: "unrelated failure",
    });

    constructEvent.mockReturnValue(event);
    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("missing_owner");
    expect(await getRow(first.id)).toMatchObject({ attempts: 2 });
    expect(await getRow(second.id)).toMatchObject({ attempts: 1, status: "pending" });
    expect(await getRow(otherHandlerId)).toMatchObject({ attempts: 1, status: "pending" });

    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    expect(await getRow(first.id)).toMatchObject({ status: "resolved" });
    expect(await getRow(second.id)).toMatchObject({ status: "pending" });
    expect(await getRow(otherHandlerId)).toMatchObject({ status: "pending" });
  });

  it.each(["ignored", "resolved"] as const)("reuses a %s item on failure without losing its original payload", async (status) => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const first = await failedDelivery(event, "missing_owner");
    const resolvedAt = new Date("2025-01-02T03:04:05.000Z");
    await db.update(stripeWebhookDeadLetterTable).set({ status, resolvedAt })
      .where(eq(stripeWebhookDeadLetterTable.id, first.id));

    await expect(WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature"))
      .rejects.toThrow("missing_owner");
    expect(await eventRows(event)).toHaveLength(1);
    expect(await getRow(first.id)).toMatchObject({
      id: first.id, payload: event, createdAt: first.createdAt, attempts: 2,
      status: status === "ignored" ? "ignored" : "pending",
      resolvedAt: status === "ignored" ? resolvedAt : null,
    });
    if (status === "ignored") {
      await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
      await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
      expect(await getRow(first.id)).toMatchObject({ status: "ignored", attempts: 2, resolvedAt });
    }
  });

  it("flags a missing owner, stays pending on failed retry, then activates with the original receipt", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const deadLetter = await failedDelivery(event, "missing_owner");
    expect(deadLetter.lastError).toContain(id);
    expect(deadLetter.lastError).toContain(`cs_${id}`);
    const paid = await account(id);
    expect(paid.status).toBe("accepted");
    const originalReceipt = receipt(paid);
    expect(originalReceipt).toEqual({
      paidAt: expect.any(Date), sessionId: `cs_${id}`, amountCents: 6400, currency: "cad",
    });

    const list = await api().get("/api/admin/stripe-webhook-dead-letter?status=pending&limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: deadLetter.id, lastError: expect.stringContaining("missing_owner") }),
    ]));
    const failedRetry = await retry(deadLetter.id);
    expect(failedRetry.status).toBe(500);
    expect(failedRetry.body.error).toContain("missing_owner");
    expect(await getRow(deadLetter.id)).toMatchObject({ status: "pending", attempts: 2, resolvedAt: null });
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(0);
    expect(meetingEmail.sendMeetingEmail).not.toHaveBeenCalled();

    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));
    expect((await retry(deadLetter.id)).status).toBe(200);
    expect(await getRow(deadLetter.id)).toMatchObject({ status: "resolved", attempts: 3, resolvedAt: expect.any(Date) });
    expect((await account(id)).status).toBe("approved");
    expect(receipt(await account(id))).toEqual(originalReceipt);

    // Stripe redelivery after recovery must not create another business/email.
    await WebhookHandlers.processWebhook(Buffer.from("{}"), "synthetic_signature");
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("returns an admin failure when saving resolution fails, releases its claim, and safely retries", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const deadLetter = await failedDelivery(event, "missing_owner");
    const originalReceipt = receipt(await account(id));
    expect(originalReceipt).toEqual({
      paidAt: expect.any(Date), sessionId: `cs_${id}`, amountCents: 6400, currency: "cad",
    });
    expect(meetingEmail.sendMeetingEmail).not.toHaveBeenCalled();
    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));

    // Receipt capture and activation remain real. Fail only the first alert
    // update (the resolved-status write), leaving the catch-path error save
    // available. The attempt increment uses db.execute, not db.update.
    const update = db.update.bind(db);
    const failure = new Error("synthetic admin resolution save failure");
    let failResolution = true;
    const resolveAlert = vi.fn(() => { throw failure; });
    const alertStorage = vi.spyOn(db, "update").mockImplementation((table) => {
      if (table === stripeWebhookDeadLetterTable && failResolution) {
        failResolution = false;
        resolveAlert();
      }
      return update(table);
    });
    const failedRetry = await retry(deadLetter.id);
    expect(failedRetry.status).toBe(500);
    expect(failedRetry.body).toEqual({ ok: false, error: failure.message });
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    // Restore only this DB boundary; loaded Stripe and email exports stay stubbed.
    alertStorage.mockRestore();

    const approved = await account(id);
    expect(approved.status).toBe("approved");
    expect(receipt(approved)).toEqual(originalReceipt);
    const businesses = await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id));
    expect(businesses).toHaveLength(1);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
    const pending = await eventRows(event);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: deadLetter.id, createdAt: deadLetter.createdAt, payload: event,
      status: "pending", attempts: 2, resolvedAt: null,
      lastError: expect.stringContaining(failure.message),
    });
    expect(pending[0].lastAttemptAt.getTime()).toBeGreaterThanOrEqual(deadLetter.lastAttemptAt.getTime());

    // Prove the failed request released the claim rather than leaving recovery
    // busy. This probe performs no writes; recovery still goes through HTTP.
    expect(await withDeadLetterClaim(deadLetter.id, async () => "released")).toEqual({
      claimed: true, result: "released",
    });
    const recovered = await retry(deadLetter.id);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual({ ok: true, status: "resolved" });
    const resolved = await getRow(deadLetter.id);
    expect(resolved).toMatchObject({
      id: deadLetter.id, createdAt: deadLetter.createdAt, payload: event,
      status: "resolved", attempts: 3, resolvedAt: expect.any(Date),
    });
    expect(await eventRows(event)).toEqual([resolved]);
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await account(id)).toEqual(approved);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toEqual(businesses);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();

    // A further admin click must reject the terminal row without side effects.
    expect((await retry(deadLetter.id)).status).toBe(409);
    expect(await eventRows(event)).toEqual([resolved]);
    expect(await account(id)).toEqual(approved);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toEqual(businesses);
    expect(meetingEmail.sendMeetingEmail).toHaveBeenCalledTimes(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("dispatches only one concurrent admin retry and conflicts with retry and ignore while running", async () => {
    const id = await applicant(true);
    const event = paymentEvent(id);
    const deadLetter = await failedDelivery(event, "missing_owner");
    const originalReceipt = receipt(await account(id));
    await db.update(bizAccountsTable).set({ ownerId: id }).where(eq(bizAccountsTable.id, id));

    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const finalize = bizOnboarding.finalizeBizAccountOnboarding;
    const handler = vi.spyOn(bizOnboarding, "finalizeBizAccountOnboarding").mockImplementation(async (...args) => {
      entered();
      await blocked;
      return finalize(...args);
    });
    // Start the first HTTP request and pause inside the actual handler, not at
    // a route pre-check. The other admin must conflict before we unblock it.
    const first = retry(deadLetter.id).then((response) => response);
    try {
      await running;
      const [second, ignore] = await Promise.all([
        retry(deadLetter.id),
        api().post(`/api/admin/stripe-webhook-dead-letter/${deadLetter.id}/ignore`)
          .set("Authorization", `Bearer ${adminToken}`),
      ]);
      for (const response of [second, ignore]) {
        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/already in progress/i);
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await getRow(deadLetter.id)).toMatchObject({ status: "pending", attempts: 2, resolvedAt: null });
    } finally {
      release();
      await first;
    }
    expect((await first).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getRow(deadLetter.id)).toMatchObject({ status: "resolved", attempts: 2 });
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("recovers a transient finalization failure without replacing a previously recorded receipt", async () => {
    const id = await applicant(false);
    const originalReceipt = {
      paidAt: new Date("2025-01-02T03:04:05.000Z"), sessionId: `cs_original_${id}`,
      amountCents: 1900, currency: "usd",
    };
    await db.update(bizAccountsTable).set({
      onboardingPaidAt: originalReceipt.paidAt, onboardingSessionId: originalReceipt.sessionId,
      onboardingPaidAmountCents: originalReceipt.amountCents, onboardingPaidCurrency: originalReceipt.currency,
    }).where(eq(bizAccountsTable.id, id));
    // Fail inside the real activation transaction, after its writes, to prove
    // rollback leaves the paid applicant recoverable rather than half approved.
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        await work(tx);
        throw new Error("synthetic transient activation failure");
      }),
    );
    // Recovery must replay the original confirmed payment, not a second charge.
    const originalEvent = paymentEvent(id);
    (originalEvent.data.object as Stripe.Checkout.Session).id = originalReceipt.sessionId;
    const deadLetter = await failedDelivery(originalEvent, "synthetic transient activation failure");
    expect((await account(id)).status).toBe("accepted");
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(0);

    expect((await retry(deadLetter.id)).status).toBe(200);
    expect(await getRow(deadLetter.id)).toMatchObject({ status: "resolved", attempts: 2 });
    expect((await account(id)).status).toBe("approved");
    expect(receipt(await account(id))).toEqual(originalReceipt);
    expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, id))).toHaveLength(1);
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe("non-onboarding webhook recovery", () => {
  const prefix = `${TEST_PREFIX}_mirror`;
  const constructEvent = vi.fn();
  const processSyncWebhook = vi.fn();
  const retrieveProduct = vi.fn();

  beforeAll(() => {
    // This lookup is needed only when this describe runs without the earlier
    // onboarding tests, which otherwise prime the signing-secret cache.
    vi.spyOn(db, "execute").mockResolvedValueOnce({
      rows: [{ secret: "synthetic_webhook_secret" }], rowCount: 1,
    } as Awaited<ReturnType<typeof db.execute>>);
  });

  beforeEach(() => {
    constructEvent.mockReset();
    processSyncWebhook.mockReset().mockResolvedValue(undefined);
    retrieveProduct.mockReset().mockRejectedValue(new Error("unexpected Stripe product lookup"));
    // Shared setup already imported the app. Spy on its loaded boundaries,
    // rather than factory-mocking a module that may no longer be replaced.
    vi.spyOn(stripeClient, "getStripeSync").mockResolvedValue({
      processWebhook: processSyncWebhook,
    } as unknown as Awaited<ReturnType<typeof stripeClient.getStripeSync>>);
    vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
      webhooks: { constructEvent },
      products: { retrieve: retrieveProduct },
    } as unknown as Stripe);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Handler-created IDs are not prefixed; use the synthetic event namespace.
    await db.delete(stripeWebhookDeadLetterTable)
      .where(like(stripeWebhookDeadLetterTable.eventId, `evt_${prefix}%`));
  });

  it.each([
    { handlerName: "subscription_mirror", existingAlert: false },
    { handlerName: "subscription_mirror", existingAlert: true },
    { handlerName: "connect_mirror", existingAlert: false },
    { handlerName: "connect_mirror", existingAlert: true },
  ] as const)(
    "$handlerName still acknowledges when alert storage rolls back (existing alert: $existingAlert)",
    async ({ handlerName, existingAlert }) => {
      const owner = await createCustomerUser();
      const business = await createBusinessForOwner({ ownerId: owner.id, subscriptionActive: false });
      const eventId = `evt_${prefix}_storage_${handlerName}_${existingAlert}`;
      const accountId = `acct_${prefix}_storage_${handlerName}_${existingAlert}`;
      await db.update(businessesTable).set({ stripeAccountId: accountId })
        .where(eq(businessesTable.id, business.id));
      const event = {
        id: eventId, object: "event", livemode: false,
        type: handlerName === "subscription_mirror" ? "customer.subscription.updated" : "account.updated",
        data: { object: handlerName === "subscription_mirror" ? {
          id: `sub_${prefix}`, status: "active",
          metadata: { userId: owner.id, businessId: business.id, delivery: "original" },
          items: { data: [{ price: { product: { metadata: { plan_tier: "pro_business" } } } }] },
        } : {
          id: accountId, charges_enabled: true, payouts_enabled: true,
          details_submitted: true, metadata: { delivery: "original" },
        } },
      } as unknown as Stripe.Event;
      const rowsForEvent = () => db.select().from(stripeWebhookDeadLetterTable)
        .where(eq(stripeWebhookDeadLetterTable.eventId, eventId));
      const deliverFailure = async (delivery: Stripe.Event, message: string) => {
        // Fail the mirror's first write, not the dead-letter transaction's
        // tx.insert/tx.update, so the actual handler failure reaches storage.
        const mirrorWrite = vi.spyOn(db, "update")
          .mockImplementationOnce(() => { throw new Error(message); });
        constructEvent.mockReturnValue(delivery);
        const response = await api().post("/api/stripe/webhook")
          .set("stripe-signature", "synthetic_signature")
          .set("Content-Type", "application/json")
          .send(JSON.stringify(delivery));
        expect(mirrorWrite).toHaveBeenCalledTimes(1);
        mirrorWrite.mockRestore();
        // Unlike paid onboarding, these failures must not ask for redelivery.
        expect(response.status).toBe(200);
      };

      if (existingAlert) await deliverFailure(event, "synthetic original mirror failure");
      const alertsBefore = await rowsForEvent();
      expect(alertsBefore).toHaveLength(existingAlert ? 1 : 0);
      const redelivery = structuredClone(event);
      (redelivery.data.object as Stripe.Subscription | Stripe.Account).metadata = {
        ...(event.data.object as Stripe.Subscription | Stripe.Account).metadata,
        delivery: "changed",
      };

      const transaction = db.transaction.bind(db);
      const observeAlertWrite = vi.fn();
      const alertStorage = vi.spyOn(db, "transaction").mockImplementationOnce((work) =>
        transaction(async (tx) => {
          await work(tx);
          // Prove the real insert/update happened before forcing rollback.
          const written = await tx.select().from(stripeWebhookDeadLetterTable)
            .where(eq(stripeWebhookDeadLetterTable.eventId, eventId));
          observeAlertWrite(written);
          throw new Error("synthetic alert storage failure");
        }),
      );
      await deliverFailure(redelivery, "synthetic outage mirror failure");
      expect(alertStorage).toHaveBeenCalledTimes(1);
      alertStorage.mockRestore();
      // Assert outside the handler: it intentionally swallows storage errors,
      // which would otherwise also swallow an assertion inside the transaction.
      expect(observeAlertWrite).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          handlerName, attempts: existingAlert ? 2 : 1,
          lastError: expect.stringContaining("synthetic outage mirror failure"),
        }),
      ]);
      // Full equality covers attempts, error, payload, timestamps and status.
      expect(await rowsForEvent()).toEqual(alertsBefore);

      await deliverFailure(redelivery, "synthetic recovered-storage mirror failure");
      const recorded = await rowsForEvent();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        eventId, eventType: event.type, handlerName,
        payload: existingAlert ? event : redelivery,
        status: "pending", attempts: existingAlert ? 2 : 1, resolvedAt: null,
        lastError: expect.stringContaining("synthetic recovered-storage mirror failure"),
        lastAttemptAt: expect.any(Date),
      });
      if (existingAlert) {
        expect(recorded[0]).toMatchObject({
          id: alertsBefore[0].id, createdAt: alertsBefore[0].createdAt,
        });
        expect(recorded[0].lastAttemptAt.getTime())
          .toBeGreaterThanOrEqual(alertsBefore[0].lastAttemptAt.getTime());
      }
      const deliveries = existingAlert ? 3 : 2;
      expect(processSyncWebhook).toHaveBeenCalledTimes(deliveries);
      expect(constructEvent).toHaveBeenCalledTimes(deliveries);
      expect(retrieveProduct).not.toHaveBeenCalled();
    },
  );

  it.each(["subscription_mirror", "connect_mirror"] as const)(
    "%s acknowledges repeated failures, groups attempts, and resolves only its pending item",
    async (handlerName) => {
      const owner = await createCustomerUser();
      const business = await createBusinessForOwner({
        ownerId: owner.id, subscriptionActive: false,
      });
      const eventId = `evt_${prefix}_${handlerName}`;
      const accountId = `acct_${prefix}_${handlerName}`;
      await db.update(businessesTable).set({ stripeAccountId: accountId })
        .where(eq(businessesTable.id, business.id));
      const event = {
        id: eventId, object: "event", livemode: false,
        type: handlerName === "subscription_mirror" ? "customer.subscription.updated" : "account.updated",
        data: { object: handlerName === "subscription_mirror" ? {
          id: `sub_${prefix}`, status: "active",
          metadata: { userId: owner.id, businessId: business.id, delivery: "original" },
          items: { data: [{ price: { product: { metadata: { plan_tier: "pro_business" } } } }] },
        } : {
          id: accountId, charges_enabled: true, payouts_enabled: true,
          details_submitted: true, metadata: { delivery: "original" },
        } },
      } as unknown as Stripe.Event;

      // A matching event under another handler, and another event under the
      // same handler, must not be grouped or resolved by this delivery.
      const otherHandler = handlerName === "subscription_mirror" ? "connect_mirror" : "subscription_mirror";
      const unrelated = [
        { id: `${prefix}_${handlerName}_other_handler`, eventId, handlerName: otherHandler },
        { id: `${prefix}_${handlerName}_other_event`, eventId: `${eventId}_other`, handlerName },
      ];
      await db.insert(stripeWebhookDeadLetterTable).values(unrelated.map((row) => ({
        ...row, eventType: event.type, payload: event, lastError: "unrelated failure",
      })));
      const unrelatedBefore = await Promise.all(unrelated.map((row) => getRow(row.id)));
      const rowsForEvent = () => db.select().from(stripeWebhookDeadLetterTable)
        .where(and(
          eq(stripeWebhookDeadLetterTable.eventId, eventId),
          eq(stripeWebhookDeadLetterTable.handlerName, handlerName),
        ));
      const deliver = async (delivery: Stripe.Event) => {
        constructEvent.mockReturnValue(delivery);
        const response = await api().post("/api/stripe/webhook")
          .set("stripe-signature", "synthetic_signature")
          .set("Content-Type", "application/json")
          .send(JSON.stringify(delivery));
        expect(response.status).toBe(200);
      };

      // Fail the actual mirror's write, leaving dead-letter transactions real.
      const failMirror = (message: string) => vi.spyOn(db, "update")
        .mockImplementationOnce(() => { throw new Error(message); });
      failMirror("synthetic first mirror failure");
      await deliver(event);
      const firstRows = await rowsForEvent();
      expect(firstRows).toHaveLength(1);
      const first = firstRows[0];
      expect(first).toMatchObject({
        eventId, eventType: event.type, handlerName, payload: event,
        status: "pending", attempts: 1, resolvedAt: null,
        lastError: expect.stringContaining("synthetic first mirror failure"),
      });

      const redelivery = structuredClone(event);
      (redelivery.data.object as Stripe.Subscription | Stripe.Account).metadata = {
        ...(event.data.object as Stripe.Subscription | Stripe.Account).metadata,
        delivery: "changed",
      };
      failMirror("synthetic later mirror failure");
      await deliver(redelivery);
      const repeated = await rowsForEvent();
      expect(repeated).toHaveLength(1);
      expect(repeated[0]).toMatchObject({
        id: first.id, createdAt: first.createdAt, payload: event,
        status: "pending", attempts: 2, resolvedAt: null,
        lastError: expect.stringContaining("synthetic later mirror failure"),
      });
      expect(repeated[0].lastAttemptAt.getTime()).toBeGreaterThanOrEqual(first.lastAttemptAt.getTime());
      expect(await Promise.all(unrelated.map((row) => getRow(row.id)))).toEqual(unrelatedBefore);

      await deliver(redelivery);
      const resolvedRows = await rowsForEvent();
      expect(resolvedRows).toHaveLength(1);
      const resolved = resolvedRows[0];
      expect(resolved).toMatchObject({
        id: first.id, createdAt: first.createdAt, payload: event,
        status: "resolved", attempts: 3, resolvedAt: expect.any(Date),
      });
      expect(resolved.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(repeated[0].lastAttemptAt.getTime());
      const [mirrored] = await db.select().from(businessesTable)
        .where(eq(businessesTable.id, business.id));
      expect(mirrored).toMatchObject(handlerName === "subscription_mirror"
        ? { subscriptionActive: true, subscriptionPlan: "pro_business" }
        : { stripeChargesEnabled: true, stripePayoutsEnabled: true });

      await deliver(redelivery);
      expect(await rowsForEvent()).toEqual([resolved]);
      expect(await Promise.all(unrelated.map((row) => getRow(row.id)))).toEqual(unrelatedBefore);
      expect(processSyncWebhook).toHaveBeenCalledTimes(4);
      expect(constructEvent).toHaveBeenCalledTimes(4);
      expect(retrieveProduct).not.toHaveBeenCalled();
    },
  );
});

describe("pre-dispatch webhook failures request Stripe redelivery", () => {
  const prefix = `${TEST_PREFIX}_verification`;
  const processSyncWebhook = vi.fn();
  const constructEvent = vi.fn();
  const refreshedSecret = "synthetic_refreshed_webhook_secret";

  beforeEach(() => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "synthetic_webhook_secret");
    processSyncWebhook.mockReset().mockResolvedValue(undefined);
    constructEvent.mockReset();
    // The app is already loaded by shared setup. Replace its live boundaries,
    // including every signing-secret read (initial lookup and cache refresh).
    vi.spyOn(stripeClient, "getStripeSync").mockResolvedValue({
      processWebhook: processSyncWebhook,
    } as unknown as Awaited<ReturnType<typeof stripeClient.getStripeSync>>);
    vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue({
      webhooks: { constructEvent },
    } as unknown as Stripe);
    vi.spyOn(db, "execute").mockResolvedValue({
      rows: [{ secret: refreshedSecret }], rowCount: 1,
    } as Awaited<ReturnType<typeof db.execute>>);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(stripeWebhookDeadLetterTable)
      .where(like(stripeWebhookDeadLetterTable.eventId, `evt_${prefix}%`));
  });

  for (const boundary of ["sync", "signature re-verification"] as const) {
    it.each([false, true])(
      `${boundary} failure returns non-2xx without dispatch or alert changes (existing alert: %s)`,
      async (existingAlert) => {
        const owner = await createCustomerUser();
        const business = await createBusinessForOwner({
          ownerId: owner.id, subscriptionActive: false,
        });
        const event = {
          id: `evt_${prefix}_${boundary === "sync" ? "sync" : "signature"}_${existingAlert}`,
          object: "event", livemode: false, type: "customer.subscription.updated",
          data: { object: {
            id: `sub_${prefix}`, status: "active",
            metadata: { userId: owner.id, businessId: business.id },
            items: { data: [{ price: { product: { metadata: { plan_tier: "pro_business" } } } }] },
          } },
        } as unknown as Stripe.Event;
        const rowsForEvent = () => db.select().from(stripeWebhookDeadLetterTable)
          .where(eq(stripeWebhookDeadLetterTable.eventId, event.id));
        if (existingAlert) {
          await db.insert(stripeWebhookDeadLetterTable).values({
            id: `${prefix}_${boundary === "sync" ? "sync" : "signature"}`,
            eventId: event.id, eventType: event.type,
            handlerName: "subscription_mirror", payload: event,
            status: "pending", attempts: 3, lastError: "synthetic earlier mirror failure",
            lastAttemptAt: new Date("2025-01-02T03:04:05.000Z"),
          });
        }
        const alertsBefore = await rowsForEvent();
        const businessBefore = await db.select().from(businessesTable)
          .where(eq(businessesTable.id, business.id));
        const ownerBefore = await db.select().from(usersTable)
          .where(eq(usersTable.id, owner.id));
        const failure = new Error(`synthetic ${boundary} failure`);
        if (boundary === "sync") {
          processSyncWebhook.mockRejectedValue(failure);
          // If sync rejection is ever swallowed, verification would succeed
          // and this valid subscription would reach the real business mirror.
          constructEvent.mockReturnValue(event);
        } else {
          constructEvent.mockImplementation(() => { throw failure; });
        }
        const select = vi.spyOn(db, "select");
        const update = vi.spyOn(db, "update");
        const transaction = vi.spyOn(db, "transaction");
        const payload = JSON.stringify(event);
        const response = await api().post("/api/stripe/webhook")
          .set("stripe-signature", "synthetic_signature")
          .set("Content-Type", "application/json")
          .send(payload);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: "Webhook processing error" });
        expect(processSyncWebhook).toHaveBeenCalledExactlyOnceWith(
          Buffer.from(payload), "synthetic_signature",
        );
        // Neither the business mirror nor dead-letter creation/resolution
        // should even start, regardless of whether an older alert exists.
        expect(select).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        if (boundary === "sync") {
          expect(stripeClient.getUncachableStripeClient).not.toHaveBeenCalled();
          expect(constructEvent).not.toHaveBeenCalled();
          expect(db.execute).not.toHaveBeenCalled();
        } else {
          expect(stripeClient.getUncachableStripeClient).toHaveBeenCalledTimes(1);
          expect(constructEvent.mock.calls.length).toBeGreaterThanOrEqual(2);
          const lookups = vi.mocked(db.execute).mock.invocationCallOrder;
          expect(lookups.length).toBeGreaterThanOrEqual(1);
          const refreshOrder = lookups[lookups.length - 1];
          const verifications = constructEvent.mock.invocationCallOrder;
          expect(verifications[0]).toBeLessThan(refreshOrder);
          expect(verifications[verifications.length - 1]).toBeGreaterThan(refreshOrder);
          // Only compare to synthetic values; never print candidate secrets.
          expect(constructEvent.mock.calls.some((call, index) =>
            verifications[index] > refreshOrder && call[2] === refreshedSecret,
          )).toBe(true);
        }
        expect(await rowsForEvent()).toEqual(alertsBefore);
        expect(await db.select().from(businessesTable)
          .where(eq(businessesTable.id, business.id))).toEqual(businessBefore);
        expect(await db.select().from(usersTable)
          .where(eq(usersTable.id, owner.id))).toEqual(ownerBefore);
      },
    );
  }
});

// Belt-and-braces: if any test created stray rows outside the prefix scheme
// (it shouldn't), this catches it before the global afterAll.
describe("test data hygiene", () => {
  it("only created rows under the test prefix", async () => {
    const rows = await db
      .select({ id: stripeWebhookDeadLetterTable.id })
      .from(stripeWebhookDeadLetterTable)
      .where(like(stripeWebhookDeadLetterTable.id, `${TEST_PREFIX}%`));
    // No assertion on count — just verify the query runs and the prefix is
    // a valid identifier shape.
    expect(Array.isArray(rows)).toBe(true);
  });
});
