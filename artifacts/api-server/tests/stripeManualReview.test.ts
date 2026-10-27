import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { db, pool, stripePaymentReviewsTable, stripeWebhookDeadLetterTable, usersTable } from "@workspace/db";
import { withDeadLetterClaim } from "../src/lib/deadLetterClaim";
import { api, createAdminUser, createCustomerUser, mintToken, TEST_PREFIX } from "./helpers";

const base = "/api/admin/stripe-webhook-dead-letter";
let admin: Awaited<ReturnType<typeof createAdminUser>>;
let otherAdmin: Awaited<ReturnType<typeof createAdminUser>>;
let customer: Awaited<ReturnType<typeof createCustomerUser>>;

beforeAll(async () => {
  admin = await createAdminUser();
  otherAdmin = await createAdminUser();
  customer = await createCustomerUser();
});

async function fixture(status: "pending" | "resolved" | "ignored" = "pending", duplicate = true) {
  const id = `${TEST_PREFIX}_review_${crypto.randomUUID()}`;
  await db.insert(stripeWebhookDeadLetterTable).values({
    id, eventId: `evt_${id}`, eventType: "checkout.session.completed", handlerName: "biz_account_paid",
    status, lastError: "synthetic duplicate",
    payload: {
      livemode: false, data: { object: { id: "cs_test_Extra", mode: "payment", payment_status: "paid" } },
      ...(duplicate ? { _duplicatePayment: { originalSessionId: "cs_test_Original", extraSessionId: "cs_test_Extra" } } : {}),
    },
  });
  return id;
}

function post(id: string, token = admin.token, body: unknown = { outcome: "needs_follow_up" }) {
  return api().post(`${base}/${id}/reviews`).set("Authorization", `Bearer ${token}`).send(body);
}

describe("append-only manual duplicate-payment review", () => {
  it.each(["pending", "ignored", "resolved"] as const)("persists reviews for %s entries and exposes history to another admin", async status => {
    const id = await fixture(status);
    const [before] = await db.select().from(stripeWebhookDeadLetterTable).where(eq(stripeWebhookDeadLetterTable.id, id));
    const first = await post(id, admin.token, { outcome: "needs_follow_up", note: "  Check the extra charge  " });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      outcome: "needs_follow_up", reviewerId: admin.id, reviewerName: "Test Admin", note: "Check the extra charge",
    });
    expect(Number.isNaN(Date.parse(first.body.reviewedAt))).toBe(false);
    expect(first.body).not.toHaveProperty("deadLetterId");
    // Changing the reviewer name later must not rewrite the audit snapshot.
    await db.update(usersTable).set({ name: "Renamed Admin" }).where(eq(usersTable.id, admin.id));
    const second = await post(id, otherAdmin.token, { outcome: "handled_in_stripe", note: "" });
    expect(second.status).toBe(201);
    expect(second.body.note).toBeNull();
    const list = await api().get(`${base}?status=${status}&limit=200`).set("Authorization", `Bearer ${otherAdmin.token}`);
    expect(list.status).toBe(200);
    const entry = list.body.entries.find((row: { id: string }) => row.id === id);
    expect(entry.manualReviews).toEqual([second.body, first.body]);
    const [after] = await db.select().from(stripeWebhookDeadLetterTable).where(eq(stripeWebhookDeadLetterTable.id, id));
    expect(after).toEqual(before); // No queue transition, attempt/payload/receipt changes.
    await db.update(usersTable).set({ name: "Test Admin" }).where(eq(usersTable.id, admin.id));
  });

  it("shows unreviewed historical dismissals explicitly as empty history", async () => {
    const id = await fixture("ignored");
    const list = await api().get(`${base}?status=ignored&limit=200`).set("Authorization", `Bearer ${otherAdmin.token}`);
    expect(list.body.entries.find((row: { id: string }) => row.id === id).manualReviews).toEqual([]);
    const recorded = await post(id, admin.token, { outcome: "no_action_needed", note: " ".repeat(500) });
    expect(recorded.status).toBe(201);
    expect(recorded.body.note).toBeNull();
  });

  it("preserves overlapping reviews, audit attribution and refresh ordering without touching recovery", async () => {
    const id = await fixture();
    await db.update(usersTable).set({ name: "Second Reviewer" }).where(eq(usersTable.id, otherAdmin.id));
    const [before] = await db.update(stripeWebhookDeadLetterTable).set({
      attempts: 4, lastAttemptAt: new Date("2024-01-02T03:04:05Z"),
      payload: {
        livemode: false,
        data: { object: {
          id: "cs_test_Extra", mode: "payment", payment_status: "paid",
          amount_total: 100, currency: "usd", payment_intent: "pi_test_Extra",
        } },
        _duplicatePayment: { originalSessionId: "cs_test_Original", extraSessionId: "cs_test_Extra" },
      },
    }).where(eq(stripeWebhookDeadLetterTable.id, id)).returning();
    // Equal timestamps exercise the stable ID tie-breaker on every refresh.
    const history = ["a", "z"].map(suffix => ({
      id: `${id}_${suffix}`, deadLetterId: id, outcome: "no_action_needed" as const,
      reviewerId: admin.id, reviewerName: "Historical Reviewer",
      reviewedAt: new Date("2020-01-01T00:00:00Z"), note: `Historical ${suffix}`,
    }));
    await db.insert(stripePaymentReviewsTable).values(history);
    const storedReviews = () => db.select().from(stripePaymentReviewsTable)
      .where(eq(stripePaymentReviewsTable.deadLetterId, id))
      .orderBy(desc(stripePaymentReviewsTable.reviewedAt), desc(stripePaymentReviewsTable.id));
    const exposedReviews = async () => (await storedReviews()).map(({ deadLetterId: _, ...review }) => ({
      ...review, reviewedAt: review.reviewedAt.toISOString(),
    }));
    const refresh = async (token: string) => {
      const response = await api().get(`${base}?status=pending&limit=200`)
        .set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(200);
      const entry = response.body.entries.find((row: { id: string }) => row.id === id);
      expect(entry).toBeDefined();
      return entry;
    };
    const initial = await Promise.all([refresh(admin.token), refresh(otherAdmin.token)]);
    const initialHistory = await exposedReviews();
    expect(initialHistory.map(review => review.id)).toEqual([history[1].id, history[0].id]);
    for (const entry of initial) expect(entry.manualReviews).toEqual(initialHistory);

    const blocker = await pool.connect();
    let submissions: Promise<Awaited<ReturnType<typeof post>>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      // This row-scoped lock blocks the real FK checks on both review inserts,
      // not unrelated records. Hold the real replay claim at the same time.
      await blocker.query("SELECT id FROM stripe_webhook_dead_letter WHERE id = $1 FOR UPDATE", [id]);
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `stripe-dead-letter-admin:${id}`,
      ]);
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const startedAt = await db.execute(sql`SELECT clock_timestamp() AS now`);
      const bodies = [
        { outcome: "needs_follow_up", note: "  First admin finding  " },
        { outcome: "handled_in_stripe", note: "Second admin finding" },
      ];
      submissions = Promise.all([
        post(id, admin.token, bodies[0]),
        post(id, otherAdmin.token, bodies[1]),
      ]);
      // Observe both real INSERTs waiting; Promise.all alone would not prove
      // overlap. Poll a condition with a deadline, never rely on sleep ordering.
      await expect.poll(async () => {
        const result = await db.execute(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE ${pid} = ANY(pg_blocking_pids(pid))
            AND query ILIKE 'insert into "stripe_payment_reviews"%'
        `);
        return result.rows[0].waiting;
      }, { timeout: 3_000, interval: 20 }).toBe(2);
      for (const entry of await Promise.all([refresh(otherAdmin.token), refresh(admin.token)])) {
        expect(entry.manualReviews).toEqual(initialHistory);
        expect(entry.paymentReview).toEqual(initial[0].paymentReview);
      }
      expect(await withDeadLetterClaim(id, async () => {
        throw new Error("A review must not release the active replay claim");
      })).toEqual({ claimed: false, reason: "locked" });
      await blocker.query("COMMIT");
      const responses = await submissions;
      const endedAt = await db.execute(sql`SELECT clock_timestamp() AS now`);
      const expectedReviewers = [
        { reviewerId: admin.id, reviewerName: "Test Admin" },
        { reviewerId: otherAdmin.id, reviewerName: "Second Reviewer" },
      ];
      responses.forEach((response, index) => {
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          ...expectedReviewers[index], outcome: bodies[index].outcome, note: bodies[index].note.trim(),
        });
        expect(response.body).not.toHaveProperty("deadLetterId");
        const timestamp = Date.parse(response.body.reviewedAt);
        expect(timestamp).toBeGreaterThanOrEqual(new Date(startedAt.rows[0].now as string).getTime());
        expect(timestamp).toBeLessThanOrEqual(new Date(endedAt.rows[0].now as string).getTime());
      });
      expect(responses[0].body.id).not.toBe(responses[1].body.id);
      const expectedHistory = await exposedReviews();
      expect(expectedHistory).toHaveLength(4);
      expect(expectedHistory.slice(0, 2)).toEqual(expect.arrayContaining(responses.map(response => response.body)));
      expect(expectedHistory.slice(2)).toEqual(initialHistory);
      // Reverse refresh order, then repeat it: neither admin's history may
      // replace the other review or change any previously recorded audit data.
      for (const token of [otherAdmin.token, admin.token, admin.token, otherAdmin.token]) {
        const entry = await refresh(token);
        expect(entry.manualReviews).toEqual(expectedHistory);
        expect(entry.paymentReview).toEqual(initial[0].paymentReview);
      }
      expect(await storedReviews()).toEqual(expectedHistory.map(review => ({
        ...review, deadLetterId: id, reviewedAt: new Date(review.reviewedAt),
      })));
      expect(await db.select().from(stripeWebhookDeadLetterTable)
        .where(eq(stripeWebhookDeadLetterTable.id, id))).toEqual([before]);
      // Recording reviews neither consumes a claim nor leaves one behind.
      expect(await withDeadLetterClaim(id, async () => "available"))
        .toEqual({ claimed: true, result: "available" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      // Drain requests even on assertion failure before global fixture cleanup.
      if (submissions) await submissions;
      await db.update(usersTable).set({ name: "Test Admin" }).where(eq(usersTable.id, otherAdmin.id));
    }
  });

  it("rejects invalid and forged audit fields without writing", async () => {
    const id = await fixture();
    for (const body of [
      {}, { outcome: "refunded" }, { outcome: "needs_follow_up", note: "x".repeat(501) },
      { outcome: "needs_follow_up", note: 42 }, { outcome: "needs_follow_up", reviewerId: otherAdmin.id },
      { outcome: "needs_follow_up", reviewedAt: "2020-01-01" }, { outcome: "needs_follow_up", reviewerName: "Someone else" },
    ]) expect((await post(id, admin.token, body)).status).toBe(400);
    expect(await db.select().from(stripePaymentReviewsTable).where(eq(stripePaymentReviewsTable.deadLetterId, id))).toEqual([]);
    expect((await post(id, admin.token, { outcome: "no_action_needed", note: "x".repeat(500) })).status).toBe(201);
  });

  it("rejects missing/unrelated entries", async () => {
    expect((await post(`${TEST_PREFIX}_missing`)).status).toBe(404);
    expect((await post(await fixture("pending", false))).status).toBe(400);
  });

  it("denies anonymous, customer, business and expired admin sessions access to history and writes", async () => {
    const id = await fixture();
    expect((await post(id)).status).toBe(201);
    const tokens = [
      { token: "", expected: 401 },
      { token: customer.token, expected: 403 },
      { token: mintToken({ userId: customer.id, role: "business" }), expected: 403 },
      { token: mintToken({ userId: admin.id, role: "admin", tv: -1 }), expected: 401 },
    ];
    for (const { token, expected } of tokens) {
      const read = await api().get(`${base}?status=all`).set("Authorization", `Bearer ${token}`);
      expect(read.status).toBe(expected);
      expect(read.body).not.toHaveProperty("entries");
      expect((await post(id, token)).status).toBe(expected);
    }
    expect(await db.select().from(stripePaymentReviewsTable).where(eq(stripePaymentReviewsTable.deadLetterId, id))).toHaveLength(1);
  });
});
