// Isolated worker: deliberately imports neither the API app nor Stripe.
import { eq, sql } from "drizzle-orm";
import {
  db, pool, deadLetterClaimPool, DEAD_LETTER_CLAIM_LIMIT, bizAccountsTable, stripeWebhookDeadLetterTable,
} from "@workspace/db";
import { withDeadLetterClaim } from "../../src/lib/deadLetterClaim";

async function send(message: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("Worker requires IPC"));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function main() {
  const [mode, ...ids] = process.argv.slice(2);
  const multiple = mode?.endsWith("-many");
  if (!["hold", "hold-before-attempt", "probe", "recover", "hold-many", "probe-many", "recover-many"].includes(mode)
    || ids.length !== (multiple ? DEAD_LETTER_CLAIM_LIMIT : 1)
    || ids.some(id => !id.startsWith("e2e_"))
    || new Set(ids).size !== ids.length) {
    throw new Error("Worker requires distinct synthetic fixture IDs and a valid mode");
  }
  let committed = 0;
  const results = await Promise.all(ids.map(async id => {
    const result = await withDeadLetterClaim(id, async () => {
      if (mode === "probe" || mode === "probe-many") throw new Error("Probe must not enter a held claim");
      if (mode === "hold-before-attempt") {
        // The advisory claim is real, but no attempt or receipt write has run.
        // The parent must kill us at this earlier boundary, without releasing it.
        await send({ type: "claim-acquired" });
        await new Promise<never>(() => {});
      }
      if (mode === "hold" || mode === "hold-many") {
        // A real committed write on the handler connection, NOT the transaction
        // holding the advisory lock. SIGKILL must not roll this attempt back.
        if (pool === deadLetterClaimPool) throw new Error("Handler pool must be separate");
        await db.transaction(async (tx) => {
          const rows = await tx.update(stripeWebhookDeadLetterTable).set({
            attempts: sql`${stripeWebhookDeadLetterTable.attempts} + 1`,
            lastAttemptAt: new Date(),
          }).where(eq(stripeWebhookDeadLetterTable.id, id)).returning();
          if (rows.length !== 1) throw new Error("Missing synthetic alert");
        });
        committed += 1;
        // Do not announce readiness until every handler connection has committed
        // and every advisory claim is simultaneously held by this process.
        if (committed === ids.length) {
          await send(multiple
            ? { type: "attempts-committed", ids }
            : { type: "attempt-committed" });
        }
        // No graceful exit path: the parent must kill this process while the
        // claim transaction is still open.
        await new Promise<never>(() => {});
      }
      const [alert] = await db.select().from(stripeWebhookDeadLetterTable)
        .where(eq(stripeWebhookDeadLetterTable.id, id));
      const [receipt] = await db.select({
        sessionId: bizAccountsTable.onboardingSessionId,
        paidAt: bizAccountsTable.onboardingPaidAt,
        amountCents: bizAccountsTable.onboardingPaidAmountCents,
        currency: bizAccountsTable.onboardingPaidCurrency,
      }).from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
      return { attempts: alert.attempts, status: alert.status, receipt };
    });
    if ((mode === "hold" || mode === "hold-many") && !result.claimed) {
      throw new Error("Holder did not acquire every synthetic claim");
    }
    return multiple ? { id, ...result } : result;
  }));
  await send({ type: "result", result: multiple ? results : results[0] });
}

// Bound even a broken fixture; the parent has its own, shorter IPC deadline.
const watchdog = setTimeout(() => process.exit(2), 20_000);
main().then(async () => {
  await Promise.all([pool.end(), deadLetterClaimPool.end()]);
  clearTimeout(watchdog);
  process.disconnect();
}).catch(async () => {
  // Do not print database errors, which may contain connection details.
  await send({ type: "worker-error" }).catch(() => {});
  process.exit(1);
});
