import { Router, type IRouter } from "express";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingReviewsTable,
  servicesTable,
  serviceOptionsTable,
  usersTable,
} from "@workspace/db";
import {
  ListBookingsQueryParams,
  ListBookingsResponse,
  CreateBookingBody,
  UpdateBookingStatusParams,
  UpdateBookingStatusBody,
} from "@workspace/api-zod";
import { requireUser, requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { parseDurationToMinutes } from "../lib/duration";
import { createNotification } from "../lib/notifications";
import { businessesTable } from "@workspace/db";
import { computeCancellationQuote, resolvePolicy } from "../lib/cancellation";
import { executeRefund } from "./bookingsPayments";
import { recordAudit } from "../lib/audit";
import {
  commissionForPlan,
  parsePlanTier,
  DEFAULT_PLAN_TIER,
  PLAN_BOOKING_HORIZON_MONTHS,
} from "../lib/plans";

/**
 * Pretty-print a numeric(10,2) string price ("123.40") as "$123.40" for use
 * in notification copy. Defensive: falls back to the raw string on parse fail.
 */
function fmtMoney(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${s}`;
}

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

/** Format integer cents as a "12.34" string for numeric(10,2) DB columns. */
function centsToString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${whole}.${rem.toString().padStart(2, "0")}`;
}

/**
 * GET /bookings — list bookings for one customer or one business.
 * Authz: caller must own the resource being queried.
 *  - customer can only list bookings where customerId === their userId
 *  - SP can only list bookings where businessId === their token's businessId
 *  - admin can list any
 */
router.get("/bookings", requireUser, async (req, res) => {
  const q = ListBookingsQueryParams.parse(req.query);
  if (!q.customerId && !q.businessId) {
    res.status(400).json({ error: "Provide customerId or businessId" });
    return;
  }
  const auth = req.auth!;
  if (auth.role !== "admin") {
    if (q.customerId && (auth.role !== "customer" || auth.userId !== q.customerId)) {
      res.status(403).json({ error: "Forbidden: cannot list bookings for another customer" });
      return;
    }
    if (q.businessId && (auth.role !== "business" || auth.businessId !== q.businessId)) {
      res.status(403).json({ error: "Forbidden: cannot list bookings for another business" });
      return;
    }
  }

  const filters: SQL[] = [];
  if (q.customerId) filters.push(eq(bookingsTable.customerId, q.customerId));
  if (q.businessId) filters.push(eq(bookingsTable.businessId, q.businessId));

  // LEFT JOIN booking_reviews so the response includes a per-booking
  // `reviewed: boolean`. The mobile bookings list uses this to swap the
  // "Leave a review" CTA for a "Reviewed" badge without an extra round-trip.
  const rows = await db
    .select({
      booking: bookingsTable,
      reviewId: bookingReviewsTable.id,
    })
    .from(bookingsTable)
    .leftJoin(bookingReviewsTable, eq(bookingReviewsTable.bookingId, bookingsTable.id))
    .where(and(...filters));
  const shaped = rows.map((r) => ({ ...r.booking, reviewed: !!r.reviewId }));
  req.log.info({ count: shaped.length, ...q, role: auth.role }, "listBookings");
  res.json(ListBookingsResponse.parse(shaped));
});

/**
 * POST /bookings — customer creates a booking. The server reads serviceId+optionId
 * from the body and computes ALL denormalised fields itself (price, fee, total,
 * businessId, businessName, serviceTitle, optionName, durationMinutes). The body's
 * customerId is ignored — we always use auth.userId.
 */
router.post("/bookings", requireRole("customer"), async (req, res) => {
  const body = CreateBookingBody.parse(req.body);
  const auth = req.auth!;

  // Resolve service + option in parallel; both must exist and option must belong
  // to the named service.
  const [[svc], [opt], [user]] = await Promise.all([
    db.select().from(servicesTable).where(and(
      eq(servicesTable.id, body.serviceId),
      isNull(servicesTable.deletedAt),
    )),
    db.select().from(serviceOptionsTable).where(and(
      eq(serviceOptionsTable.id, body.optionId),
      isNull(serviceOptionsTable.deletedAt),
    )),
    db.select().from(usersTable).where(eq(usersTable.id, auth.userId)),
  ]);

  if (!svc) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  if (!opt || opt.serviceId !== svc.id) {
    res.status(404).json({ error: "Service option not found for this service" });
    return;
  }
  if (!user) {
    res.status(401).json({ error: "User no longer exists" });
    return;
  }

  // Phase 3 #3 — block bookings whose scheduledDate falls inside the SP's
  // vacation window. Customer-facing UI should already gate this, but the
  // server is the source of truth (and the SP could enable vacation mode
  // between page-load and submit).
  // Phase 3 #7 — also pull the cancellation policy fields so we can snapshot
  // them onto the booking row (so future SP edits don't change the rules
  // for already-placed bookings).
  const [bizForVacation] = await db
    .select({
      vacationFrom: businessesTable.vacationFrom,
      vacationUntil: businessesTable.vacationUntil,
      vacationMessage: businessesTable.vacationMessage,
      cancellationFullRefundHours: businessesTable.cancellationFullRefundHours,
      cancellationPartialRefundHours: businessesTable.cancellationPartialRefundHours,
      cancellationPartialRefundPercent: businessesTable.cancellationPartialRefundPercent,
      subscriptionPlan: businessesTable.subscriptionPlan,
    })
    .from(businessesTable)
    .where(eq(businessesTable.id, svc.businessId));
  if (
    bizForVacation?.vacationFrom &&
    bizForVacation.vacationUntil &&
    body.scheduledDate >= bizForVacation.vacationFrom &&
    body.scheduledDate <= bizForVacation.vacationUntil
  ) {
    res.status(409).json({
      error:
        bizForVacation.vacationMessage?.trim() ||
        `Provider is on vacation until ${bizForVacation.vacationUntil}.`,
    });
    return;
  }

  // Per-plan booking horizon: the SP's plan caps how far ahead a customer may
  // book. Server is the source of truth even though the customer calendar
  // already clamps to this window.
  const bookingPlan = parsePlanTier(bizForVacation?.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
  const horizonMonths = PLAN_BOOKING_HORIZON_MONTHS[bookingPlan];
  const maxBookingDate = addMonthsISO(new Date(), horizonMonths);
  if (body.scheduledDate > maxBookingDate) {
    res.status(409).json({
      error: `This provider accepts bookings up to ${horizonMonths} months in advance (through ${maxBookingDate}).`,
    });
    return;
  }

  // True integer-cents math — never operate on the floats directly. The DB column
  // is numeric(10,2) so opt.price is always at most 2 decimal places; we parse it,
  // round to the nearest cent (defends against unexpected extra decimals), and do
  // all subsequent arithmetic in integer cents.
  const priceFloat = Number(opt.price);
  if (!Number.isFinite(priceFloat) || priceFloat < 0) {
    res.status(400).json({ error: "Service option has an invalid price" });
    return;
  }
  const priceCents = Math.round(priceFloat * 100);
  const platformFeeCents = commissionForPlan(bookingPlan, priceCents);
  const totalCents = priceCents + platformFeeCents;
  const durationMinutes = parseDurationToMinutes(opt.duration) ?? 60;

  const id = genId("bk");
  const [inserted] = await db
    .insert(bookingsTable)
    .values({
      id,
      customerId: user.id,
      customerName: user.name ?? "",
      serviceId: svc.id,
      businessId: svc.businessId,
      businessName: svc.businessName,
      serviceTitle: svc.title,
      optionName: opt.name,
      price: centsToString(priceCents),
      platformFee: centsToString(platformFeeCents),
      total: centsToString(totalCents),
      status: "pending",
      scheduledDate: body.scheduledDate,
      scheduledTime: body.scheduledTime ?? null,
      durationMinutes,
      // Phase 3 #7 — snapshot the policy as it stood when the booking was
      // placed; cancellation refund math reads these (with fallback to the
      // live business policy for legacy bookings without a snapshot).
      cancellationFullRefundHours: bizForVacation?.cancellationFullRefundHours ?? null,
      cancellationPartialRefundHours: bizForVacation?.cancellationPartialRefundHours ?? null,
      cancellationPartialRefundPercent: bizForVacation?.cancellationPartialRefundPercent ?? null,
    })
    .returning();

  // Brand-new booking can't possibly have a review yet — surface the field so
  // the response shape matches the list endpoint.
  const insertedWithReview = { ...inserted, reviewed: false };

  req.log.info(
    { bookingId: id, customerId: user.id, businessId: svc.businessId, priceCents, platformFeeCents },
    "booking.created",
  );

  // Notify the SP that owns this business that a new booking came in. Lookup
  // ownerId off businessesTable rather than trusting the booking row. Failures
  // are swallowed inside `createNotification` so they can't 500 the request.
  try {
    const [biz] = await db
      .select({ ownerId: businessesTable.ownerId })
      .from(businessesTable)
      .where(eq(businessesTable.id, svc.businessId));
    if (biz?.ownerId) {
      const whenLabel = `${body.scheduledDate}${body.scheduledTime ? ` at ${body.scheduledTime}` : ""}`;
      await createNotification(
        {
          userId: biz.ownerId,
          kind: "booking_created",
          title: "New booking request",
          body: `${user.name ?? "A customer"} booked ${svc.title} (${opt.name}) for ${whenLabel}. Total ${fmtMoney(centsToString(totalCents))}.`,
          bookingId: id,
        },
        req.log,
      );
    }
  } catch (err) {
    req.log.warn({ err, bookingId: id }, "booking.created_notify_failed");
  }

  res.status(201).json(insertedWithReview);
});

/**
 * Allowed status transitions per role.
 * Admins can transition to any status.
 */
const CUSTOMER_ALLOWED_STATUSES = new Set(["cancelled"]);
const BUSINESS_ALLOWED_STATUSES = new Set(["confirmed", "completed", "cancelled"]);

/** PATCH /bookings/:id — change status. Authz matrix described above. */
router.patch("/bookings/:id", requireUser, async (req, res) => {
  const { id } = UpdateBookingStatusParams.parse(req.params);
  const body = UpdateBookingStatusBody.parse(req.body);
  const auth = req.auth!;

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  // Disallow re-opening a terminal booking (completed/cancelled cannot leave their state).
  if ((existing.status === "completed" || existing.status === "cancelled") && body.status !== existing.status) {
    res.status(400).json({ error: `Cannot change status from ${existing.status}` });
    return;
  }

  if (auth.role === "customer") {
    if (existing.customerId !== auth.userId) {
      res.status(403).json({ error: "Forbidden: not your booking" });
      return;
    }
    if (!CUSTOMER_ALLOWED_STATUSES.has(body.status)) {
      res.status(403).json({ error: "Customers can only cancel a booking" });
      return;
    }
  } else if (auth.role === "business") {
    if (existing.businessId !== auth.businessId) {
      res.status(403).json({ error: "Forbidden: not your business's booking" });
      return;
    }
    if (!BUSINESS_ALLOWED_STATUSES.has(body.status)) {
      res.status(400).json({ error: "Business cannot set that status" });
      return;
    }
  }
  // admin: no further restrictions.

  // Phase 3 #7 — Customer cancelling a paid booking triggers the
  // cancellation-policy refund flow BEFORE we mark the row cancelled, so
  // the Stripe refund and the status flip stay coherent. Admins/SPs hitting
  // PATCH bypass this — they have separate refund tooling.
  let cancellationRefundCents: number | null = null;
  if (
    auth.role === "customer" &&
    body.status === "cancelled" &&
    existing.status !== "cancelled" &&
    existing.paymentIntentId &&
    !existing.refundId
  ) {
    const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, existing.businessId));
    const policy = resolvePolicy({
      bookingFullRefundHours: existing.cancellationFullRefundHours,
      bookingPartialRefundHours: existing.cancellationPartialRefundHours,
      bookingPartialRefundPercent: existing.cancellationPartialRefundPercent,
      businessFullRefundHours: biz?.cancellationFullRefundHours ?? 24,
      businessPartialRefundHours: biz?.cancellationPartialRefundHours ?? 2,
      businessPartialRefundPercent: biz?.cancellationPartialRefundPercent ?? 50,
    });
    const totalCents = Math.round(Number(existing.total) * 100);
    const quote = computeCancellationQuote({
      scheduledDate: existing.scheduledDate,
      scheduledTime: existing.scheduledTime,
      totalCents,
      policy,
    });
    if (quote.refundCents > 0) {
      const result = await executeRefund(id, req.log, { amountCents: quote.refundCents });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      // executeRefund already flipped status to 'cancelled' and stamped
      // refundId/refundedAt. Stamp the cancellation amount separately and
      // skip the CAS UPDATE below.
      await db
        .update(bookingsTable)
        .set({ cancellationRefundCents: quote.refundCents })
        .where(eq(bookingsTable.id, id));
      cancellationRefundCents = quote.refundCents;
      const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      const [reviewRow] = await db
        .select({ id: bookingReviewsTable.id })
        .from(bookingReviewsTable)
        .where(eq(bookingReviewsTable.bookingId, id));
      req.log.info(
        { bookingId: id, role: auth.role, from: existing.status, to: "cancelled", refundCents: quote.refundCents, tier: quote.tier },
        "booking.customer_cancelled_with_refund",
      );
      recordAudit(req, {
        entityType: "booking",
        entityId: id,
        action: "cancel_with_refund",
        summary: `Customer cancelled "${existing.serviceTitle}" — refunded ${(quote.refundCents / 100).toFixed(2)}`,
        metadata: {
          businessId: existing.businessId,
          customerId: existing.customerId,
          from: existing.status,
          to: "cancelled",
          refundCents: quote.refundCents,
          tier: quote.tier,
        },
      });
      res.json({ ...refreshed, reviewed: !!reviewRow, cancellationRefundCents });
      return;
    }
    // tier === "none": fall through to the regular cancel path; stamp 0
    // so the UI knows the policy was evaluated and no refund was earned.
    cancellationRefundCents = 0;
  }

  // Race-safe status update: the UPDATE itself includes `status = existing.status`
  // as a guard so two concurrent requests against the same booking can't both
  // succeed. If another writer has already changed the status between our SELECT
  // and our UPDATE, `returning()` is empty and we 409.
  const updatedRows = await db
    .update(bookingsTable)
    .set({
      status: body.status,
      ...(cancellationRefundCents !== null ? { cancellationRefundCents } : {}),
    })
    .where(and(eq(bookingsTable.id, id), eq(bookingsTable.status, existing.status)))
    .returning();
  if (updatedRows.length === 0) {
    req.log.warn({ bookingId: id, expected: existing.status, attempted: body.status }, "booking.status_update_race");
    res.status(409).json({ error: "Booking status changed concurrently — please retry" });
    return;
  }

  req.log.info(
    { bookingId: id, role: auth.role, from: existing.status, to: body.status },
    "booking.status_updated",
  );
  if (existing.status !== body.status) {
    recordAudit(req, {
      entityType: "booking",
      entityId: id,
      action: `status_${body.status}`,
      summary: `Booking "${existing.serviceTitle}" — ${existing.status} → ${body.status}`,
      metadata: {
        businessId: existing.businessId,
        customerId: existing.customerId,
        from: existing.status,
        to: body.status,
      },
    });
  }

  // The PATCH response shape mirrors GET — include `reviewed` so clients
  // don't have to re-fetch the list to know whether the row was reviewed.
  const [reviewRow] = await db
    .select({ id: bookingReviewsTable.id })
    .from(bookingReviewsTable)
    .where(eq(bookingReviewsTable.bookingId, id));
  const updatedWithReview = { ...updatedRows[0], reviewed: !!reviewRow };

  // Short-circuit no-op transitions so callers can't spam notifications by
  // re-asserting the same status. We still ran the CAS update above (returns
  // the row); just skip the notification side-effect here.
  if (existing.status === body.status) {
    res.json(updatedWithReview);
    return;
  }

  // Notify the OTHER party of the status change. SP confirms/completes/cancels
  // → notify the customer. Customer cancels → notify the SP owner. Admin acting
  // on either side → notify both customer and SP for transparency.
  try {
    const updated = updatedRows[0];
    const kind: "booking_confirmed" | "booking_completed" | "booking_cancelled" | null =
      body.status === "confirmed" ? "booking_confirmed" :
      body.status === "completed" ? "booking_completed" :
      body.status === "cancelled" ? "booking_cancelled" : null;
    if (kind) {
      const whenLabel = `${updated.scheduledDate}${updated.scheduledTime ? ` at ${updated.scheduledTime}` : ""}`;
      const customerCopy = {
        booking_confirmed: {
          title: "Booking confirmed",
          body: `${updated.businessName} confirmed your ${updated.serviceTitle} booking for ${whenLabel}.`,
        },
        booking_completed: {
          title: "Booking complete",
          body: `${updated.businessName} marked your ${updated.serviceTitle} booking as complete.`,
        },
        booking_cancelled: {
          title: "Booking cancelled",
          body: `Your ${updated.serviceTitle} booking with ${updated.businessName} was cancelled.`,
        },
      }[kind];
      const spCopy = {
        booking_confirmed: null, // SP just made this transition, no need to ping themselves
        booking_completed: null,
        booking_cancelled: {
          title: "Booking cancelled",
          body: `${updated.customerName || "A customer"} cancelled their ${updated.serviceTitle} booking for ${whenLabel}.`,
        },
      }[kind];

      // Decide who hears about it based on who acted.
      const notifyCustomer = auth.role !== "customer";
      const notifySpOwner = auth.role !== "business" && !!spCopy;

      const spOwnerPromise = notifySpOwner
        ? db.select({ ownerId: businessesTable.ownerId })
            .from(businessesTable)
            .where(eq(businessesTable.id, updated.businessId))
            .then(([b]) => b?.ownerId ?? null)
        : Promise.resolve(null);
      const spOwnerId = await spOwnerPromise;

      const tasks: Promise<void>[] = [];
      if (notifyCustomer) {
        tasks.push(
          createNotification(
            {
              userId: updated.customerId,
              kind,
              title: customerCopy.title,
              body: customerCopy.body,
              bookingId: id,
            },
            req.log,
          ),
        );
      }
      if (spOwnerId && spCopy) {
        tasks.push(
          createNotification(
            {
              userId: spOwnerId,
              kind,
              title: spCopy.title,
              body: spCopy.body,
              bookingId: id,
            },
            req.log,
          ),
        );
      }
      await Promise.all(tasks);
    }
  } catch (err) {
    req.log.warn({ err, bookingId: id }, "booking.status_notify_failed");
  }

  res.json({ ...updatedWithReview, cancellationRefundCents });
});

/**
 * GET /bookings/:id/cancellation-quote — preview the refund a customer
 * would receive if they cancelled right now. Read-only, customer-only,
 * scoped to the caller's own booking. The mobile cancel-confirmation
 * screen calls this to show "You'll receive $X refund" before the
 * customer confirms.
 *
 * Always 200 even for unrefundable cases — the response shape carries
 * `eligible:false` + a reason so the screen can render an explanation
 * instead of a refund amount. Hard 404/403 are reserved for
 * doesn't-exist / not-yours.
 */
router.get("/bookings/:id/cancellation-quote", requireRole("customer"), async (req, res) => {
  const id = String(req.params.id);
  const auth = req.auth!;

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (booking.customerId !== auth.userId) {
    res.status(403).json({ error: "Forbidden: not your booking" });
    return;
  }

  const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, booking.businessId));
  const policy = resolvePolicy({
    bookingFullRefundHours: booking.cancellationFullRefundHours,
    bookingPartialRefundHours: booking.cancellationPartialRefundHours,
    bookingPartialRefundPercent: booking.cancellationPartialRefundPercent,
    businessFullRefundHours: biz?.cancellationFullRefundHours ?? 24,
    businessPartialRefundHours: biz?.cancellationPartialRefundHours ?? 2,
    businessPartialRefundPercent: biz?.cancellationPartialRefundPercent ?? 50,
  });
  const totalCents = Math.round(Number(booking.total) * 100);

  // Pre-quote eligibility checks. We still return the policy so the UI can
  // show "What's the cancellation policy?" even on terminal states.
  if (booking.status === "cancelled") {
    res.json({
      eligible: false, reason: "already_cancelled",
      refundCents: 0, tier: "none", hoursUntilScheduled: 0, totalCents,
      policy,
    });
    return;
  }
  if (booking.status === "completed") {
    res.json({
      eligible: false, reason: "already_completed",
      refundCents: 0, tier: "none", hoursUntilScheduled: 0, totalCents,
      policy,
    });
    return;
  }

  const quote = computeCancellationQuote({
    scheduledDate: booking.scheduledDate,
    scheduledTime: booking.scheduledTime,
    totalCents,
    policy,
  });

  res.json({
    eligible: true,
    refundCents: booking.paymentIntentId ? quote.refundCents : 0,
    tier: quote.tier,
    hoursUntilScheduled: quote.hoursUntilScheduled,
    totalCents,
    paid: !!booking.paymentIntentId,
    policy,
  });
});

export default router;
