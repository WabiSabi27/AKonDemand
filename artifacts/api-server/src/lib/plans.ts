/**
 * Subscription plan limits and helpers. Single source of truth for plan-tier
 * → service-count caps, commission rates, booking horizons, and the one-time
 * application/onboarding fees. Used by the POST /services gate, the
 * /me/subscription endpoint, the booking money math, the availability/booking
 * window cap, the biz-account application flow, and the Stripe webhook bridge.
 *
 * Pricing is enforced in Stripe (see scripts/seed-products.ts):
 *   Starter Gigger  $29/mo  →  5 listings, 9%   commission, 3-month window
 *   Pro Business    $79/mo  → 20 listings, 6.5% commission, 6-month window
 */

export type PlanTier = "starter_gigger" | "pro_business";

export const PLAN_TIERS: readonly PlanTier[] = ["starter_gigger", "pro_business"] as const;

/** Service-count (active listing) limit per plan. */
export const PLAN_SERVICE_LIMIT: Record<PlanTier, number> = {
  starter_gigger: 5,
  pro_business: 20,
};

/** Display name for a plan tier (matches the names seeded in Stripe). */
export const PLAN_DISPLAY_NAME: Record<PlanTier, string> = {
  starter_gigger: "Starter Gigger",
  pro_business: "Pro Business",
};

/** Monthly price in cents. */
export const PLAN_PRICE_CENTS: Record<PlanTier, number> = {
  starter_gigger: 2900,
  pro_business: 7900,
};

/**
 * Platform commission rate per plan, in basis points (1% = 100 bps). Applied
 * to the booking subtotal as `application_fee_amount` on the destination
 * charge. Replaces the former flat 8% (800 bps). Existing bookings keep their
 * snapshotted `platformFee`, so only NEW bookings use these rates.
 */
export const PLAN_COMMISSION_BPS: Record<PlanTier, number> = {
  starter_gigger: 900, // 9%
  pro_business: 650, // 6.5%
};

/**
 * How far in advance (in whole months) a customer may book an SP, per plan.
 * Enforced server-side in availability + booking creation; the customer
 * calendar is clamped to match.
 */
export const PLAN_BOOKING_HORIZON_MONTHS: Record<PlanTier, number> = {
  starter_gigger: 3,
  pro_business: 6,
};

/**
 * One-time fees in the SP onboarding funnel (cents). Both are NON-REFUNDABLE.
 *   - Application fee: paid up front to get the applicant to an interview.
 *   - Onboarding fee: paid after both parties accept (post-interview) to go live.
 * Single source of truth — the biz-accounts routes and Stripe seeding import these.
 */
export const APPLICATION_FEE_CENTS = 100; // $1.00 (beta-testing price; normally $19.00)
export const ONBOARDING_FEE_CENTS = 200; // $2.00 (beta-testing price; normally $60.00)

/** The default tier assigned to a newly-approved SP. */
export const DEFAULT_PLAN_TIER: PlanTier = "starter_gigger";

/** Returns true when `serviceCount` is at or above the plan's listing cap. */
export function isAtServiceLimit(plan: PlanTier, serviceCount: number): boolean {
  return serviceCount >= PLAN_SERVICE_LIMIT[plan];
}

/** Commission in cents for a given subtotal under the SP's plan. */
export function commissionForPlan(plan: PlanTier, subtotalCents: number): number {
  return Math.round((subtotalCents * PLAN_COMMISSION_BPS[plan]) / 10_000);
}

/**
 * Coerce arbitrary strings (e.g. Stripe product metadata `plan_tier`, the
 * `subscription_plan` column) to a known PlanTier, or return null when the
 * value is missing/invalid. Centralised so we never silently default — callers
 * decide how to handle null.
 */
export function parsePlanTier(value: unknown): PlanTier | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return (PLAN_TIERS as readonly string[]).includes(lower) ? (lower as PlanTier) : null;
}

/**
 * Stripe subscription `status` values that should be treated as an entitlement
 * to the plan's perks (i.e. allow listing creation).
 *
 * Per Stripe: a sub can be `active`, `trialing`, `past_due`, `canceled`,
 * `unpaid`, `incomplete`, `incomplete_expired`, or `paused`. We honour
 * `active` + `trialing` as on; everything else (including `past_due`) flips
 * the SP into a read-only state to avoid running services on a delinquent
 * card. SPs can resubscribe via the customer portal to come back online.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
]);

export function isActiveSubscriptionStatus(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}
