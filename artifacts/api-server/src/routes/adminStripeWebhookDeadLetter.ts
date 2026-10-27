/**
 * TD-3 — Admin queue + replay for failed Stripe webhook handler runs.
 *
 *   GET    /admin/stripe-webhook-dead-letter           — list, filterable by status
 *   POST   /admin/stripe-webhook-dead-letter/:id/retry — re-dispatch the stored event
 *   POST   /admin/stripe-webhook-dead-letter/:id/ignore — mark as ignored (won't show in pending)
 *
 * Retry uses the persisted `Stripe.Event` payload so we don't need Stripe
 * to redeliver. On success the row is marked `resolved`; on failure the
 * row stays `pending` with the updated `lastError` / `attempts` /
 * `lastAttemptAt` so the operator can see whether the underlying problem
 * has changed.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { RecordAdminStripePaymentReviewBody } from "@workspace/api-zod";
import { db, stripeWebhookDeadLetterTable, stripePaymentReviewsTable, usersTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { replayDeadLetterRow } from "../webhookHandlers";
import { withDeadLetterClaim } from "../lib/deadLetterClaim";
import { stripePaymentReview } from "../lib/stripePaymentReview";

const router: IRouter = Router();

const ListQuery = z.object({
  status: z.enum(["pending", "resolved", "ignored", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/admin/stripe-webhook-dead-letter", requireRole("admin"), async (req, res) => {
  const q = ListQuery.parse(req.query);
  const status = q.status ?? "pending";
  const limit = q.limit ?? 50;

  const baseSel = db.select().from(stripeWebhookDeadLetterTable);
  const rows =
    status === "all"
      ? await baseSel.orderBy(desc(stripeWebhookDeadLetterTable.createdAt)).limit(limit)
      : await baseSel
          .where(eq(stripeWebhookDeadLetterTable.status, status))
          .orderBy(desc(stripeWebhookDeadLetterTable.createdAt))
          .limit(limit);

  const reviews = rows.length ? await db.select().from(stripePaymentReviewsTable)
    .where(inArray(stripePaymentReviewsTable.deadLetterId, rows.map(r => r.id)))
    .orderBy(desc(stripePaymentReviewsTable.reviewedAt), desc(stripePaymentReviewsTable.id)) : [];

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      eventId: r.eventId,
      eventType: r.eventType,
      handlerName: r.handlerName,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      paymentReview: stripePaymentReview(r),
      manualReviews: reviews.filter(review => review.deadLetterId === r.id).map(({ deadLetterId: _, ...review }) => ({
        ...review, reviewedAt: review.reviewedAt.toISOString(),
      })),
      lastAttemptAt: r.lastAttemptAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    })),
  });
});

router.post("/admin/stripe-webhook-dead-letter/:id/reviews", requireRole("admin"), async (req, res) => {
  // Reject client-supplied identity/time (and other unknown properties).
  const parsed = RecordAdminStripePaymentReviewBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid review outcome and keep the optional note to 500 characters." });
    return;
  }
  const id = String(req.params.id);
  const [entry] = await db.select().from(stripeWebhookDeadLetterTable)
    .where(eq(stripeWebhookDeadLetterTable.id, id));
  if (!entry) {
    res.status(404).json({ error: "Dead-letter entry not found" });
    return;
  }
  if (!stripePaymentReview(entry)) {
    res.status(400).json({ error: "Manual payment reviews are only available for duplicate-payment entries." });
    return;
  }
  const reviewerId = req.auth!.userId;
  const [reviewer] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(eq(usersTable.id, reviewerId));
  const [review] = await db.insert(stripePaymentReviewsTable).values({
    id: randomUUID(), deadLetterId: id, outcome: parsed.data.outcome,
    reviewerId, reviewerName: reviewer?.name?.trim() || reviewerId,
    note: parsed.data.note?.trim() || null,
  }).returning();
  // Deliberately no queue transition, replay claim, Stripe call, or refund.
  const { deadLetterId: _, ...record } = review;
  res.status(201).json({ ...record, reviewedAt: review.reviewedAt.toISOString() });
});

router.post("/admin/stripe-webhook-dead-letter/:id/retry", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  const [row] = await db
    .select()
    .from(stripeWebhookDeadLetterTable)
    .where(eq(stripeWebhookDeadLetterTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Dead-letter entry not found" });
    return;
  }
  // Both terminal states reject retry. The replay helper additionally holds
  // an exclusive database claim and checks status, so concurrent admin actions
  // can't slip through this pre-check.
  if (row.status !== "pending") {
    res.status(409).json({ error: `Already ${row.status}` });
    return;
  }

  const result = await replayDeadLetterRow({
    id: row.id,
    handlerName: row.handlerName,
    payload: row.payload,
  });

  if (result.ok) {
    res.json({ ok: true, status: "resolved" });
    return;
  }
  if (result.reason === "not_pending" || result.reason === "in_progress") {
    res.status(409).json({ ok: false, error: result.error });
    return;
  }
  res.status(500).json({ ok: false, error: result.error });
});

router.post("/admin/stripe-webhook-dead-letter/:id/ignore", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  // Atomic transition — only `pending` rows can be ignored. Both terminal
  // states (`resolved`, `ignored`) reject with 409.
  const claim = await withDeadLetterClaim(id, () => db.execute(sql`
    UPDATE public.stripe_webhook_dead_letter
       SET status = 'ignored', resolved_at = NOW()
     WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `));
  if (!claim.claimed) {
    res.status(409).json({ error: claim.reason === "capacity"
      ? "Recovery is busy with other entries. Please try again shortly."
      : "Recovery is already in progress for this entry" });
    return;
  }
  const result = claim.result;
  if (result.rowCount === 0) {
    const [row] = await db
      .select({ id: stripeWebhookDeadLetterTable.id, status: stripeWebhookDeadLetterTable.status })
      .from(stripeWebhookDeadLetterTable)
      .where(eq(stripeWebhookDeadLetterTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Dead-letter entry not found" });
      return;
    }
    res.status(409).json({ error: `Already ${row.status}` });
    return;
  }
  res.json({ ok: true, status: "ignored" });
});

export default router;
