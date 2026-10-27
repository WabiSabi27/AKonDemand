import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  bookingReviewsTable,
  bookingsTable,
  servicesTable,
  serviceReviewsTable,
  businessesTable,
  usersTable,
} from "@workspace/db";
import { CreateReviewBody, GetBookingReviewParams } from "@workspace/api-zod";
import { requireUser, requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";

const router: IRouter = Router();

/**
 * Extract a Postgres error code from an arbitrary thrown value. Drizzle
 * wraps driver errors in `_DrizzleQueryError`, exposing the original `pg`
 * error via `.cause`, so the unique-violation code (23505) lives one level
 * down. We walk a couple of cause links defensively.
 */
function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Recompute denormalised aggregates on `services.rating`/`services.reviewCount`
 * AND `businesses.rating`/`businesses.reviewCount` after a review change.
 *
 * We aggregate across BOTH the legacy seeded `service_reviews` rows and the
 * verified-purchase `booking_reviews` rows so existing demo content keeps
 * showing in star totals.
 *
 * Caller passes a Drizzle transaction so the writes are atomic with the
 * review insert.
 */
async function recomputeAggregates(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  serviceId: string,
  businessId: string,
): Promise<void> {
  // Service-level: average + count across legacy + booking reviews for THIS service.
  const svcResult = await tx.execute<{ avg: string | null; cnt: string }>(sql`
    SELECT
      AVG(rating)::numeric(10,4) AS avg,
      COUNT(*) AS cnt
    FROM (
      SELECT rating FROM service_reviews WHERE service_id = ${serviceId}
      UNION ALL
      SELECT rating FROM booking_reviews WHERE service_id = ${serviceId}
    ) r
  `);
  const svcAgg = svcResult.rows[0];
  const svcAvg = svcAgg?.avg ? Number(svcAgg.avg).toFixed(2) : "0";
  const svcCount = Number(svcAgg?.cnt ?? "0");
  await tx
    .update(servicesTable)
    .set({ rating: svcAvg, reviewCount: svcCount })
    .where(eq(servicesTable.id, serviceId));

  // Business-level: aggregate over every service belonging to this business.
  const bizResult = await tx.execute<{ avg: string | null; cnt: string }>(sql`
    SELECT
      AVG(rating)::numeric(10,4) AS avg,
      COUNT(*) AS cnt
    FROM (
      SELECT sr.rating FROM service_reviews sr
      INNER JOIN services s ON s.id = sr.service_id
      WHERE s.business_id = ${businessId}
      UNION ALL
      SELECT br.rating FROM booking_reviews br WHERE br.business_id = ${businessId}
    ) r
  `);
  const bizAgg = bizResult.rows[0];
  const bizAvg = bizAgg?.avg ? Number(bizAgg.avg).toFixed(2) : "0";
  const bizCount = Number(bizAgg?.cnt ?? "0");
  await tx
    .update(businessesTable)
    .set({ rating: bizAvg, reviewCount: bizCount })
    .where(eq(businessesTable.id, businessId));
}

/**
 * POST /reviews — customer leaves a 1–5 star review on a completed booking.
 * Idempotent at the unique-key level: a duplicate submission for the same
 * `bookingId` returns 409 (the row already exists).
 */
router.post("/reviews", requireRole("customer"), async (req, res) => {
  const body = CreateReviewBody.parse(req.body);
  const auth = req.auth!;

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, body.bookingId));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (booking.customerId !== auth.userId) {
    res.status(403).json({ error: "Forbidden: not your booking" });
    return;
  }
  if (booking.status !== "completed") {
    res.status(400).json({ error: "You can only review a completed booking" });
    return;
  }

  // Look up the customer's display name for the review byline. The booking
  // row has `customerName`, but the live user record is the source of truth.
  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, auth.userId));
  const customerName = (user?.name ?? booking.customerName ?? "").trim() || "Customer";

  const id = genId("rev");
  const comment = (body.comment ?? "").trim();

  let inserted;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bookingReviewsTable)
        .values({
          id,
          bookingId: booking.id,
          customerId: booking.customerId,
          customerName,
          serviceId: booking.serviceId,
          businessId: booking.businessId,
          rating: body.rating,
          comment,
        })
        .returning();
      await recomputeAggregates(tx, booking.serviceId, booking.businessId);
      return row;
    });
  } catch (err) {
    // Postgres unique_violation = 23505 → already reviewed. Drizzle wraps the
    // raw pg error in `_DrizzleQueryError` whose `.cause` carries the original
    // error and its `.code`, so we have to peek through the cause chain.
    const code = pgErrorCode(err);
    if (code === "23505") {
      res.status(409).json({ error: "You have already reviewed this booking" });
      return;
    }
    throw err;
  }

  req.log.info(
    {
      reviewId: id,
      bookingId: booking.id,
      serviceId: booking.serviceId,
      businessId: booking.businessId,
      rating: body.rating,
    },
    "review.created",
  );
  res.status(201).json(inserted);
});

/**
 * GET /bookings/:id/review — fetch the review for one booking.
 *  - customer must own the booking
 *  - SP can read reviews against their business
 *  - admin always
 * Returns 404 when the booking exists but has no review yet.
 */
router.get("/bookings/:id/review", requireUser, async (req, res) => {
  const { id } = GetBookingReviewParams.parse(req.params);
  const auth = req.auth!;

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (auth.role === "customer" && booking.customerId !== auth.userId) {
    res.status(403).json({ error: "Forbidden: not your booking" });
    return;
  }
  if (auth.role === "business" && booking.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your business's booking" });
    return;
  }

  const [review] = await db
    .select()
    .from(bookingReviewsTable)
    .where(eq(bookingReviewsTable.bookingId, id));
  if (!review) {
    res.status(404).json({ error: "No review for this booking yet" });
    return;
  }
  res.json(review);
});

export default router;
