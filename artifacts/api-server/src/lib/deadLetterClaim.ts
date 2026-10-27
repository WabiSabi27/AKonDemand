import { sql } from "drizzle-orm";
import { deadLetterClaimDb, DEAD_LETTER_CLAIM_LIMIT } from "@workspace/db";

const activeClaimIds = new Set<string>();

/**
 * Cross-process, non-waiting claim shared by admin retry and ignore.
 * PostgreSQL releases it on transaction end or connection/process loss, so
 * interrupted work never leaves a persisted "processing" state stranded.
 *
 * Work deliberately uses the normal db client: attempt/error bookkeeping must
 * commit even if the claim transaction is interrupted. Do not take a row lock
 * here; the dispatched handlers use their own connections and transactions.
 * Claims have a separate, small pool, with non-waiting process-local admission:
 * neither different-row traffic nor same-row conflicts queue behind slow work.
 * PostgreSQL remains the authority for cross-process same-row exclusion.
 */
export async function withDeadLetterClaim<T>(
  id: string,
  work: () => Promise<T>,
): Promise<{ claimed: false; reason: "capacity" | "locked" } | { claimed: true; result: T }> {
  if (activeClaimIds.has(id)) return { claimed: false, reason: "locked" };
  if (activeClaimIds.size >= DEAD_LETTER_CLAIM_LIMIT) return { claimed: false, reason: "capacity" };
  // Reserve synchronously, including connections still being established.
  activeClaimIds.add(id);
  try {
    return await deadLetterClaimDb.transaction(async (tx) => {
      const lock = await tx.execute<{ claimed: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${`stripe-dead-letter-admin:${id}`}, 0)
        ) AS claimed
      `);
      if (!lock.rows[0]?.claimed) return { claimed: false, reason: "locked" };
      return { claimed: true, result: await work() };
    });
  } finally {
    // Also release admission after connect/BEGIN/lock/COMMIT failures.
    activeClaimIds.delete(id);
  }
}
