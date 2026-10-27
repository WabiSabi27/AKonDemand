/**
 * /me/subscription endpoints — authenticated SP self-service for plan
 * status, usage, and Stripe Checkout / customer-portal access.
 *
 * The legacy `/stripe/{subscribe,subscription/:userId}` routes remain wired
 * for backwards compatibility with old mobile builds, but they are unauthed
 * and do not enforce plan tiers. Anything new should target these routes.
 */

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, businessesTable, usersTable } from "@workspace/db";
import {
  CreateMySubscriptionCheckoutBody,
  CreateMySubscriptionCheckoutResponse,
  GetMySubscriptionResponse,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { storage } from "../storage";
import { stripeService } from "../stripeService";
import { getUncachableStripeClient } from "../stripeClient";
import {
  PLAN_DISPLAY_NAME,
  PLAN_PRICE_CENTS,
  PLAN_SERVICE_LIMIT,
  PLAN_TIERS,
  DEFAULT_PLAN_TIER,
  parsePlanTier,
  type PlanTier,
} from "../lib/plans";

const router: IRouter = Router();

/**
 * Returns the first REPLIT_DOMAINS entry as a fully-qualified base URL, used
 * to build Stripe success/cancel URLs and the billing-portal `return_url`
 * when the caller doesn't override them. Falls back to localhost so dev still
 * works without that env var.
 */
function publicBaseUrl(): string {
  const first = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return first ? `https://${first}` : "http://localhost:80";
}

/**
 * Look up the active monthly Stripe price for a given plan tier. We resolve
 * the price live from the synced `stripe.products`/`stripe.prices` tables so
 * a future re-seed (different price_ids) doesn't require a code change.
 *
 * Strategy: find the product whose `metadata.plan_tier` matches, then return
 * its cheapest active recurring price. Returns null if no match (e.g. plan
 * isn't seeded yet).
 */
async function findPriceIdForPlan(plan: PlanTier): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT pr.id AS price_id
    FROM stripe.products p
    JOIN stripe.prices pr ON pr.product = p.id
    WHERE p.active = true
      AND pr.active = true
      AND pr.recurring IS NOT NULL
      AND lower(p.metadata->>'plan_tier') = ${plan}
    ORDER BY pr.unit_amount ASC NULLS LAST
    LIMIT 1
  `);
  const row = result.rows[0] as { price_id?: string } | undefined;
  return row?.price_id ?? null;
}

/**
 * GET /me/subscription — snapshot used by the mobile SP dashboard.
 *
 * Joins three sources of truth:
 *   1. `businesses` row    — plan + active flag (mirrored from Stripe by webhook).
 *   2. `users.stripe_*`    — to find the live Stripe subscription, if any.
 *   3. `stripe.subscriptions` (sync'd) — for `current_period_end`.
 * Then optionally builds a one-shot billing-portal URL.
 *
 * The `businesses` row is authoritative for gating (it's what POST /services
 * checks); Stripe data is used purely for display / nice-to-have manage URL.
 */
router.get("/me/subscription", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const [biz] = await db
    .select()
    .from(businessesTable)
    .where(eq(businessesTable.id, auth.businessId));
  if (!biz) {
    res.status(403).json({ error: "Your business no longer exists" });
    return;
  }

  // `businesses.subscriptionPlan` has a NOT NULL default of 'basic', so
  // parsing it should always succeed. If somehow it doesn't (bad data), fall
  // back to 'basic' — the user can still upgrade and the gate will treat
  // them as Basic-tier in the meantime.
  const plan: PlanTier = parsePlanTier(biz.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
  const servicesLimit = PLAN_SERVICE_LIMIT[plan];

  let currentPeriodEnd: string | null = null;
  let stripeManageUrl: string | null = null;

  const user = await storage.getUser(auth.userId);
  const stripeCustomerId = (user?.stripe_customer_id as string | null) ?? null;
  const stripeSubscriptionId = (user?.stripe_subscription_id as string | null) ?? null;

  if (stripeSubscriptionId) {
    const sub = (await storage.getSubscription(stripeSubscriptionId)) as
      | { current_period_end?: number | null; status?: string | null }
      | null;
    if (sub?.current_period_end) {
      currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
    }
  }

  if (stripeCustomerId) {
    try {
      const portal = await stripeService.createCustomerPortalSession(
        stripeCustomerId,
        publicBaseUrl(),
      );
      stripeManageUrl = portal.url;
    } catch (err) {
      // Don't fail the whole request just because the portal URL couldn't be
      // minted — common in test mode when the portal isn't configured.
      req.log.warn(
        { err, customerId: stripeCustomerId },
        "stripe.billing_portal.unavailable",
      );
    }
  }

  const payload = {
    plan,
    active: biz.subscriptionActive,
    servicesUsed: biz.serviceCount,
    servicesLimit,
    currentPeriodEnd,
    stripeManageUrl,
    priceCents: PLAN_PRICE_CENTS[plan],
  };

  res.json(GetMySubscriptionResponse.parse(payload));
});

/**
 * POST /me/subscription/checkout — start a Stripe Checkout session for the
 * requested plan. Authenticated SP only.
 *
 * Reuses the SP user's Stripe customer if one exists; creates one (and
 * persists `users.stripe_customer_id`) on first run. Returns a hosted URL
 * the mobile app opens via WebBrowser; the actual subscription state lands
 * in `businesses` via the Stripe webhook (`webhookHandlers.ts`) on
 * `customer.subscription.{created,updated}` events.
 */
router.post("/me/subscription/checkout", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const body = CreateMySubscriptionCheckoutBody.parse(req.body);
  const plan = parsePlanTier(body.plan);
  if (!plan) {
    res.status(400).json({ error: `Unknown plan: ${body.plan}. Expected one of ${PLAN_TIERS.join(", ")}.` });
    return;
  }

  const priceId = await findPriceIdForPlan(plan);
  if (!priceId) {
    req.log.error({ plan }, "subscription.checkout.no_price_found");
    res.status(400).json({
      error: `${PLAN_DISPLAY_NAME[plan]} plan is not configured in Stripe yet. Re-run scripts/seed-products.ts.`,
    });
    return;
  }

  // Need email + an existing/new Stripe customer. We look up the user row
  // (created at signup) for their email and any existing customer_id.
  const [user] = await db
    .select({ email: usersTable.email, stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, auth.userId));
  if (!user?.email) {
    res.status(400).json({ error: "Your account has no email on file; cannot start checkout." });
    return;
  }

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripeService.createCustomer(user.email, auth.userId);
    customerId = customer.id;
    await db
      .update(usersTable)
      .set({ stripeCustomerId: customerId })
      .where(eq(usersTable.id, auth.userId));
  }

  const base = publicBaseUrl();
  const successUrl = body.successUrl?.trim() || `${base}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl?.trim() || `${base}/subscription/cancel`;

  // We don't use stripeService.createCheckoutSession() because we want to
  // tag metadata so the webhook handler can correlate the resulting
  // subscription back to *this* business immediately, before relying on
  // customer-id lookup.
  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      userId: auth.userId,
      businessId: auth.businessId,
      plan,
    },
    subscription_data: {
      metadata: {
        userId: auth.userId,
        businessId: auth.businessId,
        plan,
      },
    },
  });

  if (!session.url) {
    req.log.error({ sessionId: session.id }, "subscription.checkout.no_url");
    res.status(500).json({ error: "Stripe did not return a checkout URL" });
    return;
  }

  req.log.info(
    { businessId: auth.businessId, plan, sessionId: session.id },
    "subscription.checkout.created",
  );
  res.json(CreateMySubscriptionCheckoutResponse.parse({ url: session.url, sessionId: session.id }));
});

export default router;
