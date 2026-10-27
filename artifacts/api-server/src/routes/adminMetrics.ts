/**
 * /admin/metrics — Operational dashboard for the platform owner (Phase 3 #9).
 *
 * Returns one denormalised payload covering everything the admin home tab
 * shows: GMV, MRR by tier, conversion funnel, churn, and top categories.
 *
 * Implementation notes:
 *  - All money values are returned as INTEGER CENTS so the UI never has to
 *    handle floats.
 *  - Aggregation is done in JS over a few small SELECTs rather than via SQL
 *    GROUP BY. Juneau's dataset is tiny (hundreds of rows, not millions); the
 *    JS path is more readable and avoids the numeric-as-string conversion
 *    landmines that drizzle's `sum()` introduces.
 *  - "Last 30 days" is a calendar-day rolling window keyed off `created_at`
 *    for bookings (when the SP got the order, not when it's scheduled).
 *  - Churn metric is intentionally limited: without a subscription history
 *    table we can only report the current active/inactive split. A "true"
 *    churn rate (cancellations / active at period start) needs auditing
 *    that's slated for Phase 3 #10.
 */

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  businessesTable,
  bizAccountsTable,
  categoriesTable,
  emailOutboxTable,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { PLAN_PRICE_CENTS, PLAN_TIERS, parsePlanTier, type PlanTier } from "../lib/plans";

const router: IRouter = Router();

/** Numeric column → integer cents. Drizzle returns numerics as strings. */
function toCents(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

router.get("/admin/metrics", requireRole("admin"), async (_req, res) => {
  // Pull the four small datasets in parallel. Each query is a plain SELECT —
  // we trade one extra trip vs SQL aggregations for code that's trivial to
  // audit and that returns typed objects we can pass straight to JS reducers.
  const [bookings, businesses, applications, categories, failedEmailRows] = await Promise.all([
    db
      .select({
        total: bookingsTable.total,
        platformFee: bookingsTable.platformFee,
        refundedAt: bookingsTable.refundedAt,
        cancellationRefundCents: bookingsTable.cancellationRefundCents,
        businessId: bookingsTable.businessId,
        createdAt: bookingsTable.createdAt,
      })
      .from(bookingsTable),
    db
      .select({
        id: businessesTable.id,
        ownerId: businessesTable.ownerId,
        subscriptionActive: businessesTable.subscriptionActive,
        subscriptionPlan: businessesTable.subscriptionPlan,
        categoryId: businessesTable.categoryId,
      })
      .from(businessesTable),
    db
      .select({
        status: bizAccountsTable.status,
        paidAt: bizAccountsTable.paidAt,
        ownerId: bizAccountsTable.ownerId,
      })
      .from(bizAccountsTable),
    db.select({ id: categoriesTable.id, name: categoriesTable.name }).from(categoriesTable),
    // Task #13 — count of permanently-failed provider emails. Drives a badge
    // on the admin dashboard's Email Outbox card; clears automatically when
    // rows are retried successfully (→ sent) or dismissed.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.status, "failed")),
  ]);
  const failedEmailCount = failedEmailRows[0]?.count ?? 0;

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - THIRTY_DAYS_MS;

  // ── GMV ──────────────────────────────────────────────────────────────
  // GMV (Gross Merchandise Value) = money the customer paid that the
  // platform/SP got to keep (i.e. not refunded back).
  //
  // Refund states (note: customer cancellations stamp BOTH `refundedAt`
  // and `cancellationRefundCents`, so the order of checks below matters):
  //   1. cancellationRefundCents != null → customer cancellation flow.
  //      The recorded amount is authoritative — could be 0 (policy "none"
  //      tier, customer kept nothing back), partial, or full. Subtract it.
  //   2. refundedAt set (and no cancellation amount) → admin/SP-initiated
  //      full refund via /bookings/:id/refund. Zero everything out.
  //   3. Otherwise → keep full total. This includes legacy cancelled rows
  //      created before Phase 3 #7 introduced cancellationRefundCents,
  //      where we have no record of what was refunded.
  //
  // Platform fee mirrors GMV: refunds use `refund_application_fee:true`
  // so the fee is reversed in the same proportion as the price.
  let gmvCents = 0;
  let gmvCents30 = 0;
  let platformFeeCents = 0;
  let platformFeeCents30 = 0;
  // businessId → { gmvCents, count } (last-30d window only) — used to
  // roll up per-category stats further down.
  const byBusiness = new Map<string, { gmvCents: number; count: number }>();

  for (const bk of bookings) {
    const totalCents = toCents(bk.total);
    const feeCents = toCents(bk.platformFee);
    let netGmv = totalCents;
    let netFee = feeCents;
    if (bk.cancellationRefundCents !== null && bk.cancellationRefundCents !== undefined) {
      // Customer cancellation — subtract the (possibly zero) refund.
      const refunded = bk.cancellationRefundCents;
      netGmv = Math.max(0, totalCents - refunded);
      if (totalCents > 0) {
        const keepRatio = netGmv / totalCents;
        netFee = Math.max(0, Math.round(feeCents * keepRatio));
      } else {
        netFee = 0;
      }
    } else if (bk.refundedAt) {
      // Admin/SP-initiated full refund — money flowed but came back.
      netGmv = 0;
      netFee = 0;
    }
    gmvCents += netGmv;
    platformFeeCents += netFee;
    const createdMs = bk.createdAt instanceof Date ? bk.createdAt.getTime() : new Date(bk.createdAt).getTime();
    if (createdMs >= thirtyDaysAgo) {
      gmvCents30 += netGmv;
      platformFeeCents30 += netFee;
      const slot = byBusiness.get(bk.businessId) ?? { gmvCents: 0, count: 0 };
      slot.gmvCents += netGmv;
      slot.count += 1;
      byBusiness.set(bk.businessId, slot);
    }
  }

  // ── Subscriptions / MRR ──────────────────────────────────────────────
  const tierBuckets = Object.fromEntries(
    PLAN_TIERS.map((t) => [t, { count: 0, mrrCents: 0 }]),
  ) as Record<PlanTier, { count: number; mrrCents: number }>;
  let totalActive = 0;
  let totalInactive = 0;
  for (const b of businesses) {
    if (b.subscriptionActive) {
      totalActive += 1;
      const plan = parsePlanTier(b.subscriptionPlan);
      if (plan) {
        tierBuckets[plan].count += 1;
        tierBuckets[plan].mrrCents += PLAN_PRICE_CENTS[plan];
      }
    } else {
      totalInactive += 1;
    }
  }
  const mrrCents = PLAN_TIERS.reduce((sum, t) => sum + tierBuckets[t].mrrCents, 0);

  // ── Conversion funnel (biz_accounts → businesses → bookings) ─────────
  // Each stage is a SUPERSET filter on the same applicant cohort, traced
  // through the ownerId join so the bottom of the funnel can never exceed
  // a stage above it:
  //   applications      — every biz_accounts row (started the flow)
  //   paid              — paid the $79 application fee (paidAt is set)
  //   approved          — admin-approved (status='approved')
  //   activeWithBooking — approved applicants whose owner now owns an active
  //                       business that has received ≥1 booking.
  // The mobile UI computes inter-stage conversion rates from these counts.
  const businessIdsWithBooking = new Set(bookings.map((bk) => bk.businessId));
  // ownerId → at least one active business with at least one booking.
  const ownerIdsActiveAndBooked = new Set<string>();
  for (const b of businesses) {
    if (b.subscriptionActive && businessIdsWithBooking.has(b.id)) {
      ownerIdsActiveAndBooked.add(b.ownerId);
    }
  }

  const approvedApps = applications.filter((a) => a.status === "approved");
  const funnel = {
    applications: applications.length,
    paid: applications.filter((a) => a.paidAt !== null).length,
    approved: approvedApps.length,
    activeWithBooking: approvedApps.filter(
      (a) => a.ownerId !== null && ownerIdsActiveAndBooked.has(a.ownerId),
    ).length,
  };

  // ── Churn (best-effort with current schema) ──────────────────────────
  const churn = {
    activeNow: totalActive,
    inactiveNow: totalInactive,
    // Without a subscription_events table we can't compute true period churn.
    // Surface the static split and let the UI label it as "lifetime inactive".
  };

  // ── Top categories (last 30 days) ────────────────────────────────────
  // Aggregate per business → roll up to category. We only count last-30d
  // bookings so a single historic blowout doesn't dominate forever.
  const categoryStats = new Map<string, { gmvCents: number; bookings: number }>();
  for (const b of businesses) {
    const slot = byBusiness.get(b.id);
    if (!slot) continue;
    const cat = categoryStats.get(b.categoryId) ?? { gmvCents: 0, bookings: 0 };
    cat.gmvCents += slot.gmvCents;
    cat.bookings += slot.count;
    categoryStats.set(b.categoryId, cat);
  }
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const topCategories = [...categoryStats.entries()]
    .map(([id, s]) => ({
      id,
      name: categoryNameById.get(id) ?? id,
      bookings: s.bookings,
      gmvCents: s.gmvCents,
    }))
    .sort((a, b) => b.gmvCents - a.gmvCents)
    .slice(0, 5);

  res.json({
    gmv: {
      lifetimeCents: gmvCents,
      last30Cents: gmvCents30,
      lifetimePlatformFeeCents: platformFeeCents,
      last30PlatformFeeCents: platformFeeCents30,
    },
    subscriptions: {
      totalActive,
      totalInactive,
      mrrCents,
      byTier: tierBuckets,
    },
    funnel,
    churn,
    topCategories,
    emailOutbox: { failedCount: failedEmailCount },
  });
});

export default router;
