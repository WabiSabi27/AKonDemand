/**
 * /bookings/payment-intent + /bookings/:id/refund + /bookings/:id/refund-request*
 * — the Stripe Connect money flow for Phase 2 #6 plus the customer-facing
 * refund REQUEST flow for Phase 3 #2.
 *
 * Booking flow:
 *   1. Customer picks service/option/date → mobile POSTs /bookings/payment-intent.
 *   2. We validate, compute fee in integer cents, create a `pending` booking
 *      row, and create a destination-charge PaymentIntent on the platform
 *      account with `transfer_data.destination = SP.stripeAccountId` and
 *      `application_fee_amount = 8% of subtotal`.
 *   3. Mobile presents Stripe PaymentSheet with the returned client_secret.
 *   4. On success the customer is charged, Stripe transfers (total - fee) to
 *      the SP's Connect balance, the platform keeps the fee. The booking
 *      stays `pending` until the SP confirms via PATCH /bookings/:id.
 *   5. Webhook payment_intent.payment_failed / payment_intent.canceled →
 *      delete the draft booking row (see webhookHandlers.ts).
 *
 * Refund flow (admin or business owner of the booking — proactive):
 *   - POST /bookings/:id/refund → full Stripe refund with reverse_transfer
 *     and refund_application_fee, stamps refundId/refundedAt, marks the
 *     booking cancelled, notifies the customer.
 *
 * Refund REQUEST flow (Phase 3 #2 — customer asks, admin arbitrates):
 *   - POST /bookings/:id/refund-request   (customer): asks for a refund with
 *     a reason. Notifies all admins + the SP owner.
 *   - GET  /admin/refund-requests         (admin): pending queue.
 *   - POST /bookings/:id/refund-request/decide (admin): approve or deny.
 *     Approval funnels through the same `executeRefund` helper as the
 *     proactive route so the money path is identical.
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  bookingsTable,
  servicesTable,
  serviceOptionsTable,
  usersTable,
  businessesTable,
} from "@workspace/db";
import { CreateBookingBody } from "@workspace/api-zod";
import { z } from "zod/v4";
import type { Logger } from "pino";
import { requireRole, requireUser } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { parseDurationToMinutes } from "../lib/duration";
import { stripeService } from "../stripeService";
import { createNotification } from "../lib/notifications";
import { recordAudit } from "../lib/audit";
import {
  commissionForPlan,
  parsePlanTier,
  DEFAULT_PLAN_TIER,
  PLAN_BOOKING_HORIZON_MONTHS,
} from "../lib/plans";

const router: IRouter = Router();

/**
 * Add `months` whole months to a date and return the YYYY-MM-DD string. Used to
 * cap how far ahead a customer may book under the SP's plan.
 */
function addMonthsISO(from: Date, months: number): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function centsToString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${whole}.${rem.toString().padStart(2, "0")}`;
}

function fmtMoney(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${s}`;
}

/**
 * Shared refund executor used by BOTH the proactive admin/SP route and the
 * admin "approve refund request" path. Idempotent: returns the existing
 * refund id if the booking is already refunded. Throws on Stripe failure
 * so callers can map to their own HTTP code.
 *
 * Side effects on success:
 *   - Stripe full refund with reverse_transfer + refund_application_fee
 *   - bookings row: refundId, refundedAt, status='cancelled'
 *   - one `booking_refunded` notification to the customer (best-effort)
 */
type ExecuteRefundResult =
  | { ok: true; refundId: string; refundedAt: Date; alreadyRefunded: boolean }
  | { ok: false; status: number; error: string };

export async function executeRefund(
  bookingId: string,
  log: Logger,
  opts?: { amountCents?: number },
): Promise<ExecuteRefundResult> {
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) return { ok: false, status: 404, error: "Booking not found" };

  if (!booking.paymentIntentId) {
    return { ok: false, status: 400, error: "This booking has no payment to refund." };
  }
  if (booking.refundId) {
    return {
      ok: true,
      refundId: booking.refundId,
      refundedAt: booking.refundedAt ?? new Date(),
      alreadyRefunded: true,
    };
  }

  // Partial refund (Phase 3 #7 cancellation policy) — caller passes the
  // exact cents to refund. Default (undefined) is a full refund.
  const amountCents = opts?.amountCents;
  if (typeof amountCents === "number") {
    const totalCents = Math.round(Number(booking.total) * 100);
    if (amountCents <= 0 || amountCents > totalCents) {
      return { ok: false, status: 400, error: "Refund amount out of range." };
    }
  }

  // ── Race-safe refund (Phase 3 #7) ──────────────────────────────────────
  // Two layers protect against double-refund when two cancel requests for
  // the same booking land concurrently:
  //
  //   (a) Stripe idempotency key keyed on bookingId + amount-or-FULL: even
  //       if both requests reach Stripe, both receive the SAME refund
  //       object. No duplicate Stripe charge-back.
  //   (b) Conditional UPDATE with `WHERE refund_id IS NULL`: only one of
  //       the two requests successfully writes refundId/refundedAt; the
  //       other gets 0 rows updated and treats the booking as already
  //       refunded (returning the persisted refund_id).
  //
  // The idempotency key includes the amount so a partial cancellation
  // followed by a different-amount manual refund (different code path)
  // wouldn't collide. Cancellation refunds for the same booking always
  // resolve to the same key.
  const idempotencyKey = `refund:${bookingId}:${typeof amountCents === "number" ? amountCents : "full"}`;
  let refund;
  try {
    refund = await stripeService.refundBookingPayment(booking.paymentIntentId, amountCents, idempotencyKey);
  } catch (err) {
    log.error({ err, bookingId, paymentIntentId: booking.paymentIntentId }, "booking.refund.failed");
    return { ok: false, status: 502, error: "Stripe refund failed. Please try again." };
  }

  const refundedAt = new Date();
  // Conditional update — only the FIRST concurrent caller stamps the row.
  const claimed = await db
    .update(bookingsTable)
    .set({ refundId: refund.id, refundedAt, status: "cancelled" })
    .where(and(eq(bookingsTable.id, bookingId), isNull(bookingsTable.refundId)))
    .returning({ id: bookingsTable.id });
  if (claimed.length === 0) {
    // A racing request beat us to it. Re-read to return the canonical refund id
    // (Stripe idempotency means it's the same refund, but persisted state wins).
    const [latest] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    return {
      ok: true,
      refundId: latest?.refundId ?? refund.id,
      refundedAt: latest?.refundedAt ?? refundedAt,
      alreadyRefunded: true,
    };
  }

  log.info(
    { bookingId, refundId: refund.id, paymentIntentId: booking.paymentIntentId, amountCents: amountCents ?? "full" },
    "booking.refunded",
  );
  // Audit hook: caller has no `req` here (helper is also invoked by the
  // cancellation path), so the audit row is recorded with no actor and the
  // action context lives in the metadata. The PATCH /bookings/:id audit row
  // (when this is a customer-cancellation refund) carries the actor.
  recordAudit(null, {
    entityType: "booking",
    entityId: bookingId,
    action: "refund_executed",
    summary: `Refund issued for "${booking.serviceTitle}"`,
    metadata: {
      businessId: booking.businessId,
      customerId: booking.customerId,
      refundId: refund.id,
      amountCents: amountCents ?? null,
    },
  });

  try {
    const refundedLabel = typeof amountCents === "number"
      ? fmtMoney(centsToString(amountCents))
      : fmtMoney(booking.total);
    await createNotification(
      {
        userId: booking.customerId,
        kind: "booking_refunded",
        title: "Booking refunded",
        body: `Your ${booking.serviceTitle} booking with ${booking.businessName} was refunded ${refundedLabel}.`,
        bookingId,
      },
      log,
    );
  } catch (err) {
    log.warn({ err, bookingId }, "booking.refund_notify_failed");
  }

  return { ok: true, refundId: refund.id, refundedAt, alreadyRefunded: false };
}

// ============================================================================
// POST /bookings/payment-intent — customer creates a booking + PaymentIntent
// ============================================================================
router.post("/bookings/payment-intent", requireRole("customer"), async (req, res) => {
  const body = CreateBookingBody.parse(req.body);
  const auth = req.auth!;

  const [svc] = await db.select().from(servicesTable).where(and(
    eq(servicesTable.id, body.serviceId),
    isNull(servicesTable.deletedAt),
  ));
  if (!svc) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  const [opt] = await db
    .select()
    .from(serviceOptionsTable)
    .where(and(
      eq(serviceOptionsTable.id, body.optionId),
      eq(serviceOptionsTable.serviceId, body.serviceId),
      isNull(serviceOptionsTable.deletedAt),
    ));
  if (!opt) {
    res.status(404).json({ error: "Service option not found" });
    return;
  }
  const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, svc.businessId));
  if (!biz) {
    res.status(404).json({ error: "Business not found" });
    return;
  }

  if (
    !biz.stripeAccountId ||
    biz.stripeAccountStatus !== "active" ||
    !biz.stripeChargesEnabled ||
    !biz.stripePayoutsEnabled
  ) {
    res.status(409).json({ error: "Provider hasn't finished payment setup yet — please try again later.", reason: "provider_not_payable" });
    return;
  }

  // Per-plan booking horizon: cap how far ahead the customer may book.
  const bookingPlan = parsePlanTier(biz.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
  const horizonMonths = PLAN_BOOKING_HORIZON_MONTHS[bookingPlan];
  const maxBookingDate = addMonthsISO(new Date(), horizonMonths);
  if (body.scheduledDate > maxBookingDate) {
    res.status(409).json({
      error: `This provider accepts bookings up to ${horizonMonths} months in advance (through ${maxBookingDate}).`,
    });
    return;
  }

  const subtotalCents = Math.round(Number(opt.price) * 100);
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) {
    res.status(400).json({ error: "Invalid option price" });
    return;
  }
  const feeCents = commissionForPlan(bookingPlan, subtotalCents);
  const totalCents = subtotalCents; // customer pays sticker; fee comes out of SP's cut

  // Look up the customer (name + email + any existing Stripe customer id)
  // BEFORE creating the booking row so a missing email fails fast without a
  // draft-cleanup step. Mirrors the inline upsert pattern used in
  // routes/meSubscription.ts (the storage layer has no shared helper).
  const [customerRow] = await db
    .select({
      name: usersTable.name,
      email: usersTable.email,
      stripeCustomerId: usersTable.stripeCustomerId,
    })
    .from(usersTable)
    .where(eq(usersTable.id, auth.userId));
  if (!customerRow?.email) {
    res.status(400).json({ error: "Your account has no email on file; cannot start payment." });
    return;
  }

  let stripeCustomerId = customerRow.stripeCustomerId;
  if (!stripeCustomerId) {
    try {
      const customer = await stripeService.createCustomer(customerRow.email, auth.userId);
      stripeCustomerId = customer.id;
      await db
        .update(usersTable)
        .set({ stripeCustomerId })
        .where(eq(usersTable.id, auth.userId));
    } catch (err) {
      req.log.error({ err, userId: auth.userId }, "stripe.customer_create_failed");
      res.status(502).json({ error: "Could not start payment. Please try again." });
      return;
    }
  }

  const bookingId = genId("bk");
  await db.insert(bookingsTable).values({
    id: bookingId,
    customerId: auth.userId,
    customerName: customerRow.name ?? "Customer",
    serviceId: svc.id,
    businessId: biz.id,
    businessName: biz.name,
    serviceTitle: svc.title,
    optionName: opt.name,
    price: centsToString(subtotalCents),
    platformFee: centsToString(feeCents),
    total: centsToString(totalCents),
    status: "pending",
    scheduledDate: body.scheduledDate,
    scheduledTime: body.scheduledTime ?? null,
    durationMinutes: parseDurationToMinutes(opt.duration),
    // Phase 3 #7 — snapshot the cancellation policy so SP edits don't
    // change the refund math for this in-flight booking later.
    cancellationFullRefundHours: biz.cancellationFullRefundHours,
    cancellationPartialRefundHours: biz.cancellationPartialRefundHours,
    cancellationPartialRefundPercent: biz.cancellationPartialRefundPercent,
  });

  let paymentIntent;
  try {
    paymentIntent = await stripeService.createBookingPaymentIntent({
      totalCents,
      applicationFeeCents: feeCents,
      destinationAccountId: biz.stripeAccountId,
      customerId: stripeCustomerId,
      metadata: { bookingId },
    });
  } catch (err) {
    req.log.error({ err, bookingId }, "stripe.pi_create_failed");
    await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
    res.status(502).json({ error: "Could not start payment. Please try again." });
    return;
  }

  await db
    .update(bookingsTable)
    .set({ paymentIntentId: paymentIntent.id })
    .where(eq(bookingsTable.id, bookingId));

  res.status(201).json({
    bookingId,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret!,
    customerId: stripeCustomerId,
    stripeAccountId: biz.stripeAccountId,
  });
});

// ============================================================================
// POST /bookings/:id/refund — admin/SP proactive refund
// ============================================================================
router.post("/bookings/:id/refund", requireUser, async (req, res) => {
  const auth = req.auth!;
  const bookingId = String(req.params.id);

  if (auth.role === "customer") {
    res.status(403).json({ error: "Customers cannot issue refunds — please request one via the booking." });
    return;
  }

  if (auth.role === "business") {
    const [booking] = await db.select({ businessId: bookingsTable.businessId }).from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.businessId !== auth.businessId) {
      res.status(403).json({ error: "Forbidden: not your business's booking" });
      return;
    }
  }

  const result = await executeRefund(bookingId, req.log);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({
    bookingId,
    refundId: result.refundId,
    refundedAt: result.refundedAt.toISOString(),
    alreadyRefunded: result.alreadyRefunded,
  });
});

// ============================================================================
// Phase 3 #2 — Customer-initiated refund REQUEST + admin arbitration
// ============================================================================

const RefundRequestBody = z.object({
  reason: z.string().min(10, "Please describe the issue (at least 10 characters).").max(1000),
});

const RefundDecideBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), reason: z.string().max(1000).optional() }),
  z.object({ decision: z.literal("denied"), reason: z.string().min(5, "A short explanation is required when denying.").max(1000) }),
]);

/**
 * POST /bookings/:id/refund-request — customer asks for a refund.
 * Eligibility:
 *  - caller is the booking's customer
 *  - paymentIntentId is set (i.e. it was actually paid)
 *  - status is `confirmed` or `completed` (not pending — payment isn't
 *    locked-in yet; not cancelled — already done)
 *  - not already refunded
 *  - no pending refund request (one outstanding at a time; re-requesting
 *    after a denial is allowed by clearing decision fields, but for v1 we
 *    block re-requests entirely so admins aren't spammed)
 */
router.post("/bookings/:id/refund-request", requireRole("customer"), async (req, res) => {
  const { reason } = RefundRequestBody.parse(req.body);
  const auth = req.auth!;
  const bookingId = String(req.params.id);

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (booking.customerId !== auth.userId) {
    res.status(403).json({ error: "Forbidden: not your booking" });
    return;
  }
  if (!booking.paymentIntentId) {
    res.status(400).json({ error: "This booking has no payment to refund." });
    return;
  }
  if (booking.refundId) {
    res.status(400).json({ error: "This booking has already been refunded." });
    return;
  }
  if (booking.disputeId) {
    // A Stripe chargeback is in flight or already closed against this charge.
    // Refund-request is meaningless here — Stripe owns the resolution path.
    res.status(409).json({ error: "A card dispute is open on this booking; refund requests are not allowed." });
    return;
  }
  if (booking.refundRequestedAt) {
    // Terminal: also covers the post-denial case (we deliberately don't allow
    // re-requests after a denial in v1; admins shouldn't get spammed).
    res.status(409).json({ error: "A refund request is already on file for this booking." });
    return;
  }
  if (booking.status !== "confirmed" && booking.status !== "completed") {
    res.status(400).json({ error: "Only confirmed or completed bookings can be refunded." });
    return;
  }

  const requestedAt = new Date();
  await db
    .update(bookingsTable)
    .set({ refundRequestedAt: requestedAt, refundReason: reason })
    .where(eq(bookingsTable.id, bookingId));

  req.log.info({ bookingId, customerId: auth.userId }, "booking.refund_requested");
  recordAudit(req, {
    entityType: "booking",
    entityId: bookingId,
    action: "refund_requested",
    summary: `Customer requested refund for "${booking.serviceTitle}"`,
    metadata: { businessId: booking.businessId, customerId: booking.customerId, reason },
  });

  // Notify SP owner + every admin so somebody picks it up.
  try {
    const [biz] = await db.select({ ownerId: businessesTable.ownerId }).from(businessesTable).where(eq(businessesTable.id, booking.businessId));
    const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
    const recipients = new Set<string>([...admins.map((a) => a.id)]);
    if (biz?.ownerId) recipients.add(biz.ownerId);
    for (const userId of recipients) {
      await createNotification(
        {
          userId,
          kind: "refund_requested",
          title: "Refund requested",
          body: `${booking.customerName} requested a refund for ${booking.serviceTitle} (${fmtMoney(booking.total)}).`,
          bookingId,
        },
        req.log,
      );
    }
  } catch (err) {
    req.log.warn({ err, bookingId }, "booking.refund_request_notify_failed");
  }

  res.status(201).json({
    bookingId,
    refundRequestedAt: requestedAt.toISOString(),
    refundReason: reason,
  });
});

/**
 * GET /admin/refund-requests — pending queue. Returns booking rows that have
 * an open refund request (requested but not yet decided).
 */
router.get("/admin/refund-requests", requireRole("admin"), async (req, res) => {
  const rows = await db
    .select()
    .from(bookingsTable)
    .where(and(isNotNull(bookingsTable.refundRequestedAt), isNull(bookingsTable.refundDecision)))
    .orderBy(desc(bookingsTable.refundRequestedAt));
  req.log.info({ count: rows.length }, "admin.refund_requests.listed");
  res.json(rows);
});

/**
 * POST /bookings/:id/refund-request/decide — admin approves or denies.
 * Approve → runs `executeRefund` (full Stripe refund + status=cancelled +
 *           customer notification), THEN stamps decision fields.
 * Deny    → stamps decision fields and notifies customer with the reason.
 */
router.post("/bookings/:id/refund-request/decide", requireRole("admin"), async (req, res) => {
  const body = RefundDecideBody.parse(req.body);
  const bookingId = String(req.params.id);

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (!booking.refundRequestedAt) {
    res.status(400).json({ error: "No refund request on file for this booking." });
    return;
  }
  if (booking.refundDecision) {
    res.status(409).json({ error: `This request has already been ${booking.refundDecision}.` });
    return;
  }

  const decidedAt = new Date();

  if (body.decision === "approved") {
    const refundResult = await executeRefund(bookingId, req.log);
    if (!refundResult.ok) {
      res.status(refundResult.status).json({ error: refundResult.error });
      return;
    }
    await db
      .update(bookingsTable)
      .set({
        refundDecision: "approved",
        refundDecidedAt: decidedAt,
        refundDecisionReason: body.reason ?? null,
      })
      .where(eq(bookingsTable.id, bookingId));
    try {
      await createNotification(
        {
          userId: booking.customerId,
          kind: "refund_approved",
          title: "Refund approved",
          body: `Your refund request for ${booking.serviceTitle} was approved. ${fmtMoney(booking.total)} is on its way back.`,
          bookingId,
        },
        req.log,
      );
    } catch (err) {
      req.log.warn({ err, bookingId }, "booking.refund_approved_notify_failed");
    }
    recordAudit(req, {
      entityType: "booking",
      entityId: bookingId,
      action: "refund_request_approved",
      summary: `Admin approved refund for "${booking.serviceTitle}"`,
      metadata: { businessId: booking.businessId, customerId: booking.customerId, reason: body.reason ?? null },
    });
    res.json({
      bookingId,
      decision: "approved",
      refundId: refundResult.refundId,
      refundedAt: refundResult.refundedAt.toISOString(),
      decidedAt: decidedAt.toISOString(),
    });
    return;
  }

  // Denied
  await db
    .update(bookingsTable)
    .set({
      refundDecision: "denied",
      refundDecidedAt: decidedAt,
      refundDecisionReason: body.reason,
    })
    .where(eq(bookingsTable.id, bookingId));
  try {
    await createNotification(
      {
        userId: booking.customerId,
        kind: "refund_denied",
        title: "Refund request denied",
        body: `Your refund request for ${booking.serviceTitle} was denied. Reason: ${body.reason}`,
        bookingId,
      },
      req.log,
    );
  } catch (err) {
    req.log.warn({ err, bookingId }, "booking.refund_denied_notify_failed");
  }
  req.log.info({ bookingId, decision: "denied" }, "booking.refund_decision");
  recordAudit(req, {
    entityType: "booking",
    entityId: bookingId,
    action: "refund_request_denied",
    summary: `Admin denied refund for "${booking.serviceTitle}"`,
    metadata: { businessId: booking.businessId, customerId: booking.customerId, reason: body.reason },
  });
  res.json({
    bookingId,
    decision: "denied",
    decidedAt: decidedAt.toISOString(),
    reason: body.reason,
  });
});

export default router;
