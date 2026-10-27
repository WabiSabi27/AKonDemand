/**
 * /me/earnings — SP earnings dashboard (Phase 3 #5).
 *
 * Source of truth is the `bookings` table, scoped to the caller's businessId.
 * Only bookings with a non-null `paymentIntentId` count toward earnings —
 * legacy/free bookings predate Stripe Connect and would skew the rollup.
 *
 * Money math (all returned as INTEGER CENTS so the mobile UI never has to
 * multiply floats):
 *   gross    = SUM(price)            — what the SP earned before the platform cut
 *   fees     = SUM(platform_fee)     — 8 % we kept
 *   refunded = SUM(price)  WHERE refundedAt NOT NULL
 *              (only the SP-portion is reversed via reverse_transfer; the
 *              platform fee is also reversed but it never hit the SP, so we
 *              report just the price the SP lost back)
 *   net      = gross - fees - refunded
 *
 * Stripe pending balance comes from `stripe.balance.retrieve` against the
 * SP's connected account. Returned as `null` when the account hasn't been
 * onboarded yet OR the Stripe call fails (the dashboard degrades gracefully
 * instead of erroring).
 *
 * CSV export at /me/earnings/export.csv returns text/csv of every paid
 * booking newest-first. No date-range filter v1 — Juneau dataset is small
 * and SPs can post-filter in Excel.
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, bookingsTable, businessesTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { stripeService } from "../stripeService";

const router: IRouter = Router();

// numeric cols come back as strings; helper turns "12.34" → 1234 cents.
function toCents(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // CSV injection guard: a cell that opens with =, +, -, or @ is interpreted
  // as a formula by Excel/Sheets. Customer-facing fields (name, service
  // title) are user-controlled, so prefix with a single quote — the
  // OWASP-recommended neutralisation.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  // Quote when needed; double any embedded quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

type Bucket = { gross: number; fees: number; refunded: number; net: number; count: number };

function emptyBucket(): Bucket {
  return { gross: 0, fees: 0, refunded: 0, net: 0, count: 0 };
}

function addRow(b: Bucket, price: number, fee: number, refunded: boolean): void {
  // Refunds use Stripe `reverse_transfer:true` + `refund_application_fee:true`,
  // so the platform also gives its fee back. We therefore exclude refunded
  // bookings' fees from the `fees` bucket — otherwise net would understate
  // the SP's earnings on a refunded $100/$8 booking by -$8.
  b.count += 1;
  b.gross += price;
  if (!refunded) b.fees += fee;
  if (refunded) b.refunded += price;
  b.net = b.gross - b.fees - b.refunded;
}

/** GET /me/earnings — full dashboard payload. */
router.get("/me/earnings", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  // Pull every paid booking once; aggregating in-memory is fine at our scale
  // and lets us compute lifetime + 30d + recent[] from a single query without
  // window functions.
  const rows = await db
    .select({
      id: bookingsTable.id,
      customerName: bookingsTable.customerName,
      serviceTitle: bookingsTable.serviceTitle,
      scheduledDate: bookingsTable.scheduledDate,
      price: bookingsTable.price,
      platformFee: bookingsTable.platformFee,
      paymentIntentId: bookingsTable.paymentIntentId,
      refundedAt: bookingsTable.refundedAt,
      createdAt: bookingsTable.createdAt,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.businessId, auth.businessId),
        isNotNull(bookingsTable.paymentIntentId),
      ),
    )
    .orderBy(desc(bookingsTable.createdAt));

  const lifetime = emptyBucket();
  const last30Days = emptyBucket();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const recentPayments = rows.slice(0, 25).map((r) => {
    const price = toCents(r.price);
    const fee = toCents(r.platformFee);
    const refunded = !!r.refundedAt;
    return {
      bookingId: r.id,
      customerName: r.customerName,
      serviceTitle: r.serviceTitle,
      scheduledDate: r.scheduledDate,
      grossCents: price,
      feeCents: fee,
      netCents: refunded ? 0 : price - fee,
      refunded,
      paidAt: r.createdAt.toISOString(),
    };
  });

  for (const r of rows) {
    const price = toCents(r.price);
    const fee = toCents(r.platformFee);
    const refunded = !!r.refundedAt;
    addRow(lifetime, price, fee, refunded);
    if (r.createdAt.getTime() >= cutoff) {
      addRow(last30Days, price, fee, refunded);
    }
  }

  // Stripe pending balance — best-effort. We don't fail the whole dashboard
  // if Stripe is unreachable or the SP hasn't onboarded yet.
  let balance: { pendingCents: number; availableCents: number; currency: string } | null = null;
  try {
    const [biz] = await db
      .select({ stripeAccountId: businessesTable.stripeAccountId })
      .from(businessesTable)
      .where(eq(businessesTable.id, auth.businessId));
    if (biz?.stripeAccountId) {
      const bal = await stripeService.retrieveConnectBalance(biz.stripeAccountId);
      const pending = bal.pending.reduce((sum, b) => sum + b.amount, 0);
      const available = bal.available.reduce((sum, b) => sum + b.amount, 0);
      const currency = bal.pending[0]?.currency ?? bal.available[0]?.currency ?? "usd";
      balance = { pendingCents: pending, availableCents: available, currency };
    }
  } catch (err) {
    req.log.warn({ err, businessId: auth.businessId }, "earnings.balance.fetch_failed");
  }

  res.json({
    currency: "usd",
    lifetime,
    last30Days,
    balance,
    recentPayments,
  });
});

/** GET /me/earnings/export.csv — every paid booking, newest first. */
router.get("/me/earnings/export.csv", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const rows = await db
    .select({
      id: bookingsTable.id,
      customerName: bookingsTable.customerName,
      serviceTitle: bookingsTable.serviceTitle,
      scheduledDate: bookingsTable.scheduledDate,
      scheduledTime: bookingsTable.scheduledTime,
      price: bookingsTable.price,
      platformFee: bookingsTable.platformFee,
      paymentIntentId: bookingsTable.paymentIntentId,
      refundedAt: bookingsTable.refundedAt,
      createdAt: bookingsTable.createdAt,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.businessId, auth.businessId),
        isNotNull(bookingsTable.paymentIntentId),
      ),
    )
    .orderBy(desc(bookingsTable.createdAt));

  const header = [
    "booking_id",
    "paid_at",
    "scheduled_date",
    "scheduled_time",
    "customer",
    "service",
    "gross_usd",
    "platform_fee_usd",
    "net_usd",
    "refunded",
    "payment_intent_id",
  ].join(",");

  const lines = rows.map((r) => {
    const grossC = toCents(r.price);
    const feeC = toCents(r.platformFee);
    const refunded = !!r.refundedAt;
    const netC = refunded ? 0 : grossC - feeC;
    return [
      csvCell(r.id),
      csvCell(r.createdAt.toISOString()),
      csvCell(r.scheduledDate),
      csvCell(r.scheduledTime),
      csvCell(r.customerName),
      csvCell(r.serviceTitle),
      csvCell((grossC / 100).toFixed(2)),
      csvCell((feeC / 100).toFixed(2)),
      csvCell((netC / 100).toFixed(2)),
      csvCell(refunded ? "yes" : "no"),
      csvCell(r.paymentIntentId),
    ].join(",");
  });

  const csv = [header, ...lines].join("\r\n") + "\r\n";

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="earnings-${today}.csv"`);
  res.send(csv);
});

export default router;
