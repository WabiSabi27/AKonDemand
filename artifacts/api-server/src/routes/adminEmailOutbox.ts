/**
 * Task #7 — Admin visibility + control over the email outbox.
 *
 *   GET    /admin/email-outbox              — list, filterable by status
 *   POST   /admin/email-outbox/:id/retry    — retry a failed/pending email now
 *   POST   /admin/email-outbox/:id/dismiss  — dismiss a failed record (won't retry)
 *
 * Bodies are never returned in the list (they can be large); only metadata
 * needed to triage: recipient, subject, kind, attempts, last error.
 */

import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, emailOutboxTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { retryOutboxEmail } from "../lib/emailOutbox";

const router: IRouter = Router();

const ListQuery = z.object({
  status: z.enum(["pending", "sent", "failed", "dismissed", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/admin/email-outbox", requireRole("admin"), async (req, res) => {
  const q = ListQuery.parse(req.query);
  const status = q.status ?? "failed";
  const limit = q.limit ?? 50;

  const baseSel = db
    .select({
      id: emailOutboxTable.id,
      toEmail: emailOutboxTable.toEmail,
      subject: emailOutboxTable.subject,
      kind: emailOutboxTable.kind,
      status: emailOutboxTable.status,
      attempts: emailOutboxTable.attempts,
      lastError: emailOutboxTable.lastError,
      nextAttemptAt: emailOutboxTable.nextAttemptAt,
      sentAt: emailOutboxTable.sentAt,
      createdAt: emailOutboxTable.createdAt,
    })
    .from(emailOutboxTable);
  const rows =
    status === "all"
      ? await baseSel.orderBy(desc(emailOutboxTable.createdAt)).limit(limit)
      : await baseSel
          .where(eq(emailOutboxTable.status, status))
          .orderBy(desc(emailOutboxTable.createdAt))
          .limit(limit);

  res.json({
    entries: rows.map((r) => ({
      ...r,
      nextAttemptAt: r.nextAttemptAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post("/admin/email-outbox/:id/retry", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  const result = await retryOutboxEmail(id, req.log);
  if (result.ok) {
    res.json({ ok: true, status: "sent" });
    return;
  }
  if (result.reason === "not_found") {
    res.status(404).json({ error: "Outbox entry not found" });
    return;
  }
  if (result.reason === "not_retryable") {
    res.status(409).json({ error: "Only pending or failed emails can be retried" });
    return;
  }
  res.status(502).json({ ok: false, error: result.error });
});

router.post("/admin/email-outbox/:id/dismiss", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  // Atomic: only pending/failed rows can be dismissed.
  const result = await db.execute(sql`
    UPDATE public.email_outbox
       SET status = 'dismissed'
     WHERE id = ${id} AND status IN ('pending', 'failed')
    RETURNING id
  `);
  if (result.rowCount === 0) {
    const [row] = await db
      .select({ status: emailOutboxTable.status })
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Outbox entry not found" });
      return;
    }
    res.status(409).json({ error: `Already ${row.status}` });
    return;
  }
  res.json({ ok: true, status: "dismissed" });
});

export default router;
