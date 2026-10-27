import { createServer, connect, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  db, deadLetterClaimDb, deadLetterClaimPool, DEAD_LETTER_CLAIM_LIMIT,
  bizAccountsTable, businessesTable, stripeWebhookDeadLetterTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { withDeadLetterClaim } from "../src/lib/deadLetterClaim";
import * as stripeClient from "../src/stripeClient";
import * as meetingEmail from "../src/lib/meetingEmail";
import { api, createAdminUser, TEST_PREFIX } from "./helpers";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Restored claim connection did not recover")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("payment recovery after a real claim connection timeout", () => {
  it("does not queue work or change receipts during an outage, then reuses every admission slot", async () => {
    const admin = await createAdminUser();
    const id = `${TEST_PREFIX}_connection_outage`;
    const receipt = {
      onboardingPaidAt: new Date("2025-01-02T03:04:05.000Z"),
      onboardingSessionId: `cs_${id}`,
      onboardingPaidAmountCents: 1900,
      onboardingPaidCurrency: "usd",
    };
    const payload = {
      id: `evt_${id}`, type: "checkout.session.completed",
      data: { object: {
        id: receipt.onboardingSessionId, mode: "payment", payment_status: "paid",
        amount_total: 9900, currency: "cad",
        metadata: { bizAccountId: id, feeType: "onboarding" },
      } },
    };
    await db.insert(bizAccountsTable).values({
      id, email: `${id}@example.test`, businessName: "Outage fixture",
      ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
      status: "accepted", ownerId: admin.id, ...receipt,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(stripeWebhookDeadLetterTable).values({
      id, eventId: payload.id, eventType: payload.type,
      handlerName: "biz_account_paid", payload,
      status: "pending", attempts: 3, lastError: "original activation failure",
      lastAttemptAt: new Date("2025-01-02T03:05:00.000Z"),
    });
    const readAlert = () => db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.id, id));
    const readAccount = () => db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    const beforeAlert = await readAlert();
    const beforeAccount = await readAccount();

    // Use the production pool's actual constructor/configuration and timeout.
    // Only this isolated pool's TCP connections take the loopback detour.
    // TLS/authentication still belong to pg, with the original DB hostname.
    let online = false;
    let accepted = 0;
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      return socket;
    };
    const upstream = new URL(process.env.DATABASE_URL!);
    const proxy = createServer((client) => {
      accepted++;
      track(client);
      if (!online) {
        // Accept TCP but never answer the PostgreSQL/TLS startup exchange.
        // This exercises pg's connection establishment timer, not a rejected
        // transaction mock or an immediate ECONNREFUSED.
        client.resume();
        return;
      }
      const target = track(connect(Number(upstream.port || 5432), upstream.hostname));
      client.on("close", () => target.destroy());
      target.on("close", () => client.destroy());
      client.pipe(target).pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback TCP address");
    const Pool = deadLetterClaimPool.constructor as new (
      options: typeof deadLetterClaimPool.options
    ) => typeof deadLetterClaimPool;
    const isolatedPool = new Pool({
      ...deadLetterClaimPool.options,
      stream: () => {
        const socket = new Socket();
        const socketConnect = socket.connect.bind(socket);
        // pg supplies the original host here; redirect only the TCP dial.
        socket.connect = (() => socketConnect(address.port, "127.0.0.1")) as typeof socket.connect;
        return socket;
      },
    });
    const isolatedDb = drizzle(isolatedPool, { schema });
    // Delegate to a REAL pg-backed transaction. Only replace which pool is
    // used, leaving the production claim/admission and replay paths intact.
    const transaction = vi.spyOn(deadLetterClaimDb, "transaction")
      .mockImplementation(isolatedDb.transaction.bind(isolatedDb));
    const stripe = vi.spyOn(stripeClient, "getUncachableStripeClient")
      .mockRejectedValue(new Error("Unexpected Stripe call in outage test"));
    const sync = vi.spyOn(stripeClient, "getStripeSync")
      .mockRejectedValue(new Error("Unexpected Stripe sync in outage test"));
    const email = vi.spyOn(meetingEmail, "sendMeetingEmail").mockResolvedValue(undefined);
    const retry = (rowId: string) => Promise.resolve(api()
      .post(`/api/admin/stripe-webhook-dead-letter/${rowId}/retry`)
      .set("Authorization", `Bearer ${admin.token}`)
      .timeout({ deadline: 8_000 }));
    const work = vi.fn(async () => "recovered");
    const otherIds = Array.from({ length: DEAD_LETTER_CLAIM_LIMIT - 1 },
      (_, index) => `${id}_other_${index}`);
    const release = gate();
    let attempts: Promise<unknown>[] = [];
    try {
      expect(isolatedPool).not.toBe(deadLetterClaimPool);
      expect(isolatedPool.options.max).toBe(DEAD_LETTER_CLAIM_LIMIT);
      expect(isolatedPool.options.connectionTimeoutMillis).toBe(5_000);
      const started = performance.now();
      // Attach rejection handlers immediately, including if an assertion fails.
      const first = retry(id);
      attempts = [first];
      void first.catch(() => undefined);
      await vi.waitFor(() => expect(accepted).toBe(1));
      attempts = [first, ...otherIds.map((other) => withDeadLetterClaim(other, work))];
      const settled = Promise.allSettled(attempts);
      await vi.waitFor(() => expect(accepted).toBe(DEAD_LETTER_CLAIM_LIMIT));
      expect(isolatedPool.totalCount).toBe(DEAD_LETTER_CLAIM_LIMIT);
      expect(isolatedPool.waitingCount).toBe(0);

      expect(await retry(id)).toMatchObject({ status: 409 });
      const rejectedIds = Array.from({ length: 6 }, (_, index) => `${id}_overflow_${index}`);
      const overflowStarted = performance.now();
      expect(await Promise.all(rejectedIds.map((other) => withDeadLetterClaim(other, work))))
        .toEqual(rejectedIds.map(() => ({ claimed: false, reason: "capacity" })));
      expect(performance.now() - overflowStarted).toBeLessThan(1_000);
      expect(isolatedPool.waitingCount).toBe(0);
      expect((await db.execute(sql`SELECT 42 AS answer`)).rows[0].answer).toBe(42);

      const outcomes = await settled;
      expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { status: 500 } });
      for (const outcome of outcomes.slice(1)) {
        expect(outcome).toMatchObject({
          status: "rejected", reason: expect.objectContaining({
            message: expect.stringMatching(/timeout|terminated.*connection/i),
          }),
        });
      }
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(performance.now() - started).toBeLessThan(8_000);
      await vi.waitFor(() => expect(isolatedPool.totalCount).toBe(0));
      expect(isolatedPool.waitingCount).toBe(0);
      expect(work).not.toHaveBeenCalled();
      expect(email).not.toHaveBeenCalled();
      expect(await readAlert()).toEqual(beforeAlert);
      expect(await readAccount()).toEqual(beforeAccount);

      online = true;
      // Force real concurrent reuse of every slot, including all failed IDs.
      // Holding callbacks open makes a leaked slot observable, not just a
      // sequence of successful requests through a single remaining slot.
      const entered = Array.from({ length: DEAD_LETTER_CLAIM_LIMIT }, () => gate());
      attempts = [id, ...otherIds].map((claimId, index) =>
        withDeadLetterClaim(claimId, async () => {
          entered[index].open();
          await release.promise;
          return work();
        }));
      const recovered = Promise.all(attempts);
      void recovered.catch(() => undefined);
      await promptly(Promise.all(entered.map((signal) => signal.promise)));
      expect(accepted).toBe(DEAD_LETTER_CLAIM_LIMIT * 2);
      expect(isolatedPool.waitingCount).toBe(0);
      expect(work).not.toHaveBeenCalled();
      expect(await readAlert()).toEqual(beforeAlert);
      release.open();
      expect(await promptly(recovered)).toEqual(entered.map(() => ({ claimed: true, result: "recovered" })));

      // Connectivity alone must not run rejected work. A deliberate retry now
      // activates the paid application using its original durable receipt.
      expect(await retry(id)).toMatchObject({ status: 200 });
      const [resolved] = await readAlert();
      expect(resolved).toMatchObject({
        status: "resolved", attempts: beforeAlert[0].attempts + 1,
        resolvedAt: expect.any(Date), payload, createdAt: beforeAlert[0].createdAt,
      });
      expect((await readAccount())[0]).toMatchObject({ status: "approved", ...receipt });
      expect(await db.select().from(businessesTable).where(eq(businessesTable.ownerId, admin.id)))
        .toHaveLength(1);
      expect(await retry(id)).toMatchObject({ status: 409 });
      expect(await readAlert()).toEqual([resolved]);
      expect(work).toHaveBeenCalledTimes(DEAD_LETTER_CLAIM_LIMIT);
      expect(email).toHaveBeenCalledTimes(1);
      expect(stripe).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(isolatedPool.waitingCount).toBe(0);
    } finally {
      release.open();
      // Drop the fixture's sockets before waiting, so failed assertions cannot
      // strand a connecting client or an open transaction in the test process.
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled(attempts);
      await isolatedPool.end();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      transaction.mockRestore();
      stripe.mockRestore();
      sync.mockRestore();
      email.mockRestore();
      await db.delete(businessesTable).where(eq(businessesTable.ownerId, admin.id));
      await db.delete(bizAccountsTable).where(eq(bizAccountsTable.id, id));
      await db.delete(stripeWebhookDeadLetterTable).where(eq(stripeWebhookDeadLetterTable.id, id));
    }
  }, 20_000);
});
