// Isolated worker: deliberately imports neither the API app nor Stripe.
import { eq, sql } from "drizzle-orm";
import {
  db, pool, deadLetterClaimPool, bizAccountsTable, stripeWebhookDeadLetterTable,
} from "@workspace/db";
import { withDeadLetterClaim } from "../../src/lib/deadLetterClaim";

async function send(message: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("Worker requires IPC"));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function main() {
  const [mode, id] = process.argv.slice(2);
  if (!id?.startsWith("e2e_") || !["hold", "probe", "recover"].includes(mode)) {
    throw new Error("Worker requires a synthetic fixture ID and a valid mode");
  }
  const result = await withDeadLetterClaim(id, async () => {
    if (mode === "probe") throw new Error("Probe must not enter a held claim");
    if (mode === "hold") {
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
      await send({ type: "attempt-committed" });
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
  await send({ type: "result", result });
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
