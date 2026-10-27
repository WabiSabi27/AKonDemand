import { and, eq, lte, sql } from "drizzle-orm";
import { db, emailOutboxTable } from "@workspace/db";
import type { Logger } from "pino";
import { genId } from "./ids";
import { deliverEmail } from "./meetingEmail";

/**
 * Task #7 — DB-backed email outbox with retry.
 *
 * Contract:
 *  - `enqueueAndSendEmail` persists the email FIRST, then attempts an
 *    immediate send. If the transport is down, the row stays `pending`
 *    with backoff and the worker picks it up later.
 *  - `processDueOutboxEmails` is called on an interval from index.ts; it
 *    claims due pending rows atomically (UPDATE … WHERE status='pending'
 *    RETURNING) so overlapping ticks / multiple instances can't double-send.
 *  - After MAX_ATTEMPTS the row flips to `failed` — visible to admins via
 *    GET /admin/email-outbox, retryable or dismissible from there.
 */

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000; // 1m, 2m, 4m, … capped at 1h

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/**
 * Attempt delivery for an already-claimed row and record the outcome.
 * The row must have been claimed (attempts already incremented) by the caller.
 */
async function attemptClaimedRow(
  row: {
    id: string;
    toEmail: string;
    subject: string;
    html: string;
    text: string;
    attempts: number;
    icalContent?: string | null;
    icalMethod?: string | null;
  },
  log: Logger,
): Promise<boolean> {
  try {
    const via = await deliverEmail(row);
    await db
      .update(emailOutboxTable)
      .set({ status: "sent", sentAt: new Date(), lastError: null })
      .where(eq(emailOutboxTable.id, row.id));
    log.info(
      { outboxId: row.id, toEmail: row.toEmail, attempts: row.attempts, via },
      "meetingEmail.sent",
    );
    return true;
  } catch (err) {
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    await db
      .update(emailOutboxTable)
      .set({
        status: exhausted ? "failed" : "pending",
        lastError: errText(err),
        nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
      })
      .where(eq(emailOutboxTable.id, row.id));
    log.warn(
      { outboxId: row.id, toEmail: row.toEmail, attempts: row.attempts, exhausted, err },
      "emailOutbox.attempt_failed",
    );
    return false;
  }
}

/** Persist the email, then try to send it immediately. Never throws. */
export async function enqueueAndSendEmail(
  msg: {
    toEmail: string;
    subject: string;
    html: string;
    text: string;
    kind: string;
    ical?: { content: string; method: "REQUEST" | "CANCEL" };
  },
  log: Logger,
): Promise<void> {
  const id = genId("eml");
  await db.insert(emailOutboxTable).values({
    id,
    toEmail: msg.toEmail,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    kind: msg.kind,
    icalContent: msg.ical?.content ?? null,
    icalMethod: msg.ical?.method ?? null,
    status: "pending",
    attempts: 1, // the immediate attempt below counts as attempt #1
    nextAttemptAt: new Date(),
  });
  await attemptClaimedRow(
    {
      id,
      toEmail: msg.toEmail,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attempts: 1,
      icalContent: msg.ical?.content ?? null,
      icalMethod: msg.ical?.method ?? null,
    },
    log,
  );
}

/**
 * Worker tick: claim and attempt all due pending emails. The claim bumps
 * `attempts` and pushes `nextAttemptAt` out atomically so a crash mid-send
 * can't cause a tight retry loop, and concurrent ticks can't double-claim.
 */
export async function processDueOutboxEmails(log: Logger): Promise<void> {
  const now = new Date();
  const claimed = await db
    .update(emailOutboxTable)
    .set({
      attempts: sql`${emailOutboxTable.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + 60 * 60_000), // provisional; overwritten on outcome
    })
    .where(and(eq(emailOutboxTable.status, "pending"), lte(emailOutboxTable.nextAttemptAt, now)))
    .returning();

  for (const row of claimed) {
    await attemptClaimedRow(row, log);
  }
}

/**
 * Task #14 — retention cleanup. Deletes `sent` and `dismissed` rows older
 * than RETENTION_DAYS so the outbox (which stores full HTML bodies) doesn't
 * grow unbounded. `pending` and `failed` rows are never touched: pending
 * rows are still in flight and failed rows are actionable until an admin
 * dismisses them (at which point they age out like any dismissed row).
 */
export const OUTBOX_RETENTION_DAYS = 90;

export async function cleanupOldOutboxEmails(log: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60_000);
  const deleted = await db
    .delete(emailOutboxTable)
    .where(
      and(
        sql`${emailOutboxTable.status} IN ('sent','dismissed')`,
        lte(emailOutboxTable.createdAt, cutoff),
      ),
    )
    .returning({ id: emailOutboxTable.id });
  if (deleted.length > 0) {
    log.info({ deleted: deleted.length, cutoff }, "emailOutbox.cleanup");
  }
  return deleted.length;
}

/**
 * Manual retry of a `failed` (or stuck `pending`) row from the admin UI.
 * Claims atomically; returns the outcome for the HTTP response.
 */
export async function retryOutboxEmail(
  id: string,
  log: Logger,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_retryable" | "send_failed"; error?: string }> {
  const [claimed] = await db
    .update(emailOutboxTable)
    .set({ status: "pending", attempts: sql`${emailOutboxTable.attempts} + 1` })
    .where(and(eq(emailOutboxTable.id, id), sql`${emailOutboxTable.status} IN ('pending','failed')`))
    .returning();
  if (!claimed) {
    const [row] = await db
      .select({ id: emailOutboxTable.id })
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.id, id));
    return { ok: false, reason: row ? "not_retryable" : "not_found" };
  }
  const sent = await attemptClaimedRow(claimed, log);
  if (sent) return { ok: true };
  const [after] = await db
    .select({ lastError: emailOutboxTable.lastError })
    .from(emailOutboxTable)
    .where(eq(emailOutboxTable.id, id));
  return { ok: false, reason: "send_failed", error: after?.lastError ?? "unknown error" };
}
