import { describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { eq, sql } from "drizzle-orm";
import {
  db, pool, deadLetterClaimDb, deadLetterClaimPool, DEAD_LETTER_CLAIM_LIMIT,
  stripeWebhookDeadLetterTable, bizAccountsTable,
} from "@workspace/db";
import { withDeadLetterClaim } from "../src/lib/deadLetterClaim";
import { api, createAdminUser, TEST_PREFIX } from "./helpers";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Recovery queued instead of responding")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("dead-letter claim connection budget", () => {
  it("reclaims after SIGKILL in a fresh process without losing the committed attempt or receipt", async () => {
    const id = `${TEST_PREFIX}_process_crash`;
    const directory = await mkdtemp(join(tmpdir(), "dead-letter-crash-"));
    const children: ReturnType<typeof startWorker>[] = [];
    function startWorker(mode: "hold" | "probe" | "recover") {
      const child = fork(join(directory, "worker.cjs"), [mode, id], {
        execArgv: [],
        silent: true,
        // This worker needs only Postgres, never payment credentials.
        env: { DATABASE_URL: process.env.DATABASE_URL },
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", () => resolve({ code: -1, signal: null }));
      });
      const message = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${mode} worker IPC timed out`)), 5_000);
        const finish = (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        };
        child.once("message", finish);
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error(`${mode} worker failed to start`));
        });
        void exited.then(() => {
          clearTimeout(timer);
          reject(new Error(`${mode} worker exited before its IPC message`));
        });
      });
      // Attach immediately so failure cleanup never leaves a rejection unhandled.
      void message.catch(() => {});
      const worker = { child, message, exited };
      children.push(worker);
      return worker;
    }
    const readAlert = async () => (await db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.id, id)))[0];
    const readReceipt = async () => (await db.select({
      sessionId: bizAccountsTable.onboardingSessionId,
      paidAt: bizAccountsTable.onboardingPaidAt,
      amountCents: bizAccountsTable.onboardingPaidAmountCents,
      currency: bizAccountsTable.onboardingPaidCurrency,
    }).from(bizAccountsTable).where(eq(bizAccountsTable.id, id)))[0];
    try {
      // Bundle the real claim module into a standalone Node program, without
      // importing Vitest setup, app boot, or payment clients in the child.
      await build({
        entryPoints: [fileURLToPath(new URL("./fixtures/deadLetterClaimProcess.ts", import.meta.url))],
        outfile: join(directory, "worker.cjs"),
        bundle: true, platform: "node", format: "cjs", external: ["pg-native"],
        logLevel: "silent",
      });
      await db.insert(bizAccountsTable).values({
        id, email: `${id}@example.test`, businessName: "Synthetic crash fixture",
        ownerName: "Synthetic Owner", passwordHash: "unused", businessType: "home-based",
        status: "accepted", expiresAt: new Date(Date.now() + 86_400_000),
        onboardingSessionId: `cs_${id}`, onboardingPaidAt: new Date("2026-01-02T03:04:05Z"),
        onboardingPaidAmountCents: 6400, onboardingPaidCurrency: "cad",
      });
      await db.insert(stripeWebhookDeadLetterTable).values({
        id, eventId: `evt_${id}`, eventType: "checkout.session.completed",
        handlerName: "synthetic_crash_handler", payload: { syntheticAccountId: id },
        lastError: "synthetic interrupted recovery", attempts: 1,
      });
      const originalAlert = await readAlert();
      const originalReceipt = await readReceipt();
      const holder = startWorker("hold");
      expect(await holder.message).toEqual({ type: "attempt-committed" });
      expect(holder.child.exitCode).toBeNull();
      const committedAlert = await readAlert();
      expect(committedAlert).toEqual({
        ...originalAlert, attempts: 2, lastAttemptAt: expect.any(Date),
      });
      expect(await readReceipt()).toEqual(originalReceipt);

      // A genuinely different process must observe PostgreSQL exclusion, not
      // just the parent's in-memory admission set.
      const probe = startWorker("probe");
      expect(await probe.message).toEqual({
        type: "result", result: { claimed: false, reason: "locked" },
      });
      expect(await promptly(probe.exited)).toEqual({ code: 0, signal: null });
      expect(holder.child.kill("SIGKILL")).toBe(true);
      expect(await promptly(holder.exited)).toEqual({ code: null, signal: "SIGKILL" });

      // No row reset, lease expiry, graceful unlock, or application restart
      // hook is allowed between killing the holder and this new process.
      const recovery = startWorker("recover");
      expect(await recovery.message).toEqual({
        type: "result",
        result: {
          claimed: true,
          result: {
            attempts: 2, status: "pending",
            receipt: { ...originalReceipt, paidAt: originalReceipt.paidAt!.toISOString() },
          },
        },
      });
      expect(await promptly(recovery.exited)).toEqual({ code: 0, signal: null });
      expect(await readAlert()).toEqual(committedAlert);
      expect(await readReceipt()).toEqual(originalReceipt);
    } finally {
      // Kill before deleting fixtures, including on assertion/IPC failures.
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await promptly(Promise.all(children.map(({ exited }) => exited)));
      await db.delete(stripeWebhookDeadLetterTable).where(eq(stripeWebhookDeadLetterTable.id, id));
      await db.delete(bizAccountsTable).where(eq(bizAccountsTable.id, id));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects excess distinct-row retries without starving handler queries, then admits another wave", async () => {
    const admin = await createAdminUser();
    const pendingId = `${TEST_PREFIX}_capacity`;
    await db.insert(stripeWebhookDeadLetterTable).values({
      id: pendingId, eventId: `evt_${pendingId}`, eventType: "checkout.session.completed",
      handlerName: "synthetic_invalid_handler", payload: {}, lastError: "synthetic failure",
    });
    const pendingRow = () => db.select().from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.id, pendingId));
    const before = await pendingRow();
    const release = gate();
    const allEntered = gate();
    let entered = 0;
    // More distinct IDs than the entire normal pool used to have room for.
    const count = (pool.options.max ?? 10) + DEAD_LETTER_CLAIM_LIMIT + 3;
    const attempts = Array.from({ length: count }, (_, index) =>
      withDeadLetterClaim(`${TEST_PREFIX}_saturation_${index}`, async () => {
        if (++entered === DEAD_LETTER_CLAIM_LIMIT) allEntered.open();
        await release.promise;
        // The real handler pool must remain usable while *all* claim slots
        // are occupied. No Stripe calls or production records are involved.
        const result = await db.execute(sql`SELECT 42 AS answer`);
        return result.rows[0].answer;
      }),
    );
    const settled = Promise.all(attempts);
    try {
      await promptly(allEntered.promise);
      expect(entered).toBe(DEAD_LETTER_CLAIM_LIMIT);
      expect(deadLetterClaimPool).not.toBe(pool);
      expect(deadLetterClaimPool.totalCount).toBeLessThanOrEqual(DEAD_LETTER_CLAIM_LIMIT);
      expect(deadLetterClaimPool.waitingCount).toBe(0);
      const sameRowWork = vi.fn(async () => undefined);
      expect(await promptly(withDeadLetterClaim(`${TEST_PREFIX}_saturation_0`, sameRowWork)))
        .toEqual({ claimed: false, reason: "locked" });
      expect(sameRowWork).not.toHaveBeenCalled();
      expect(await promptly(Promise.all(attempts.slice(DEAD_LETTER_CLAIM_LIMIT))))
        .toEqual(Array.from({ length: count - DEAD_LETTER_CLAIM_LIMIT }, () => ({
          claimed: false, reason: "capacity",
        })));
      expect((await promptly(db.execute(sql`SELECT 1 AS available`))).rows[0].available).toBe(1);

      // Both public actions respond without changing an entry or its attempt
      // count. Capacity is checked before either action can run its work.
      for (const action of ["retry", "ignore"]) {
        const response = await promptly(Promise.resolve(api()
          .post(`/api/admin/stripe-webhook-dead-letter/${pendingId}/${action}`)
          .set("Authorization", `Bearer ${admin.token}`)));
        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/busy.*try again/i);
      }
      expect(await pendingRow()).toEqual(before);
    } finally {
      release.open();
      await promptly(settled);
    }
    const results = await settled;
    expect(results.filter((result) => result.claimed)).toEqual(
      Array.from({ length: DEAD_LETTER_CLAIM_LIMIT }, () => ({ claimed: true, result: 42 })),
    );
    expect(entered).toBe(DEAD_LETTER_CLAIM_LIMIT);

    // Rejected IDs remain eligible; no lease expiry or manual reset is needed.
    const nextWave = await promptly(Promise.all(
      Array.from({ length: DEAD_LETTER_CLAIM_LIMIT }, (_, index) =>
        withDeadLetterClaim(`${TEST_PREFIX}_saturation_${count - 1 - index}`, async () => {
          await db.execute(sql`SELECT 1`);
          return "recovered";
        })),
    ));
    expect(nextWave).toEqual(Array.from({ length: DEAD_LETTER_CLAIM_LIMIT }, () => ({
      claimed: true, result: "recovered",
    })));
    const ignore = await api()
      .post(`/api/admin/stripe-webhook-dead-letter/${pendingId}/ignore`)
      .set("Authorization", `Bearer ${admin.token}`);
    expect(ignore.status).toBe(200);
    expect((await pendingRow())[0]).toMatchObject({ status: "ignored", attempts: before[0].attempts });
  });

  it("still rejects a same-row claim held by another connection immediately", async () => {
    const id = `${TEST_PREFIX}_cross_connection_claim`;
    const acquired = gate();
    const release = gate();
    // Bypass local admission to simulate another process's PostgreSQL claim.
    const holder = deadLetterClaimDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`stripe-dead-letter-admin:${id}`}, 0)
      )`);
      acquired.open();
      await release.promise;
    });
    const work = vi.fn(async () => "recovered");
    try {
      await promptly(acquired.promise);
      expect(await promptly(withDeadLetterClaim(id, work))).toEqual({
        claimed: false, reason: "locked",
      });
      expect(work).not.toHaveBeenCalled();
    } finally {
      release.open();
      await holder;
    }
    expect(await promptly(withDeadLetterClaim(id, work))).toEqual({
      claimed: true, result: "recovered",
    });
  });

  it("returns its admission slot after connection failure and handler failure", async () => {
    const connection = vi.spyOn(deadLetterClaimDb, "transaction")
      .mockRejectedValueOnce(new Error("synthetic connection failure"));
    try {
      await expect(withDeadLetterClaim(`${TEST_PREFIX}_connect_failure`, async () => undefined))
        .rejects.toThrow("synthetic connection failure");
    } finally {
      connection.mockRestore();
    }
    await expect(withDeadLetterClaim(`${TEST_PREFIX}_work_failure`, async () => {
      await db.execute(sql`SELECT 1`);
      throw new Error("synthetic handler failure");
    })).rejects.toThrow("synthetic handler failure");

    const release = gate();
    const entered = Array.from({ length: DEAD_LETTER_CLAIM_LIMIT }, () => gate());
    const recovered = entered.map((signal, index) =>
      withDeadLetterClaim(`${TEST_PREFIX}_failure_recovery_${index}`, async () => {
        signal.open();
        await release.promise;
        return true;
      }));
    try {
      await promptly(Promise.all(entered.map((signal) => signal.promise)));
    } finally {
      release.open();
      await Promise.all(recovered);
    }
    expect(await Promise.all(recovered)).toEqual(
      entered.map(() => ({ claimed: true, result: true })),
    );
  });
});
