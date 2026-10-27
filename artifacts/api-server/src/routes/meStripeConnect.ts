/**
 * /me/stripe/connect/* — authenticated SP self-service for Stripe Connect
 * Express onboarding. Bookings cannot be paid until the SP's business has
 * `stripePayoutsEnabled = true` here.
 *
 * Flow:
 *   1. POST /me/stripe/connect/account            → ensures `acct_…` exists.
 *   2. POST /me/stripe/connect/onboarding-link    → hosted Express onboarding URL.
 *   3. (SP completes form on Stripe-hosted page; on done → redirected to return_url.)
 *   4. account.updated webhook fires → mirrors charges/payouts flags to DB.
 *   5. GET  /me/stripe/connect/account            → mobile polls to render Payouts card.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db, businessesTable, usersTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { stripeService } from "../stripeService";

const router: IRouter = Router();

type ConnectStatus = "none" | "pending" | "active" | "restricted";

/**
 * Sniff a Stripe SDK error for the "Connect not enabled on platform" case.
 * This happens when the platform Stripe account has not signed up for Connect
 * at https://dashboard.stripe.com/connect — a one-time admin step. We surface
 * it as a typed 503 so the mobile UI can show a "platform not ready" message
 * instead of a generic failure.
 */
function isConnectNotEnabledError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: string; message?: string; statusCode?: number };
  return (
    e.type === "StripeInvalidRequestError" &&
    typeof e.message === "string" &&
    e.message.includes("signed up for Connect")
  );
}

function publicBaseUrl(): string {
  const first = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return first ? `https://${first}` : "http://localhost:80";
}

/**
 * Derive the high-level status enum the mobile UI uses from a live Stripe
 * Account object. We collapse Stripe's many flags into 4 buckets:
 *   - active:     charges + payouts enabled and no blocking requirements
 *   - restricted: Stripe has explicitly disabled the account
 *   - pending:    onboarding in progress (link minted, form not yet finished
 *                 or still under review)
 *   - none:       caller never had an account (handled at the route level)
 */
export function deriveStatus(acct: Stripe.Account): ConnectStatus {
  const reqs = acct.requirements;
  if (reqs?.disabled_reason) return "restricted";
  if (acct.charges_enabled && acct.payouts_enabled) return "active";
  return "pending";
}

function requirementsDue(acct: Stripe.Account): string[] {
  return acct.requirements?.currently_due ?? [];
}

/**
 * Persist the live Stripe state onto the business row. Called from both the
 * account-create / onboarding-link path and (in T006) the account.updated
 * webhook.
 */
async function mirrorAccountToBusiness(
  businessId: string,
  acct: Stripe.Account,
): Promise<void> {
  await db
    .update(businessesTable)
    .set({
      stripeAccountId: acct.id,
      stripeAccountStatus: deriveStatus(acct),
      stripeChargesEnabled: !!acct.charges_enabled,
      stripePayoutsEnabled: !!acct.payouts_enabled,
    })
    .where(eq(businessesTable.id, businessId));
}

/**
 * POST /me/stripe/connect/account — ensure a Connect Express account exists
 * for the calling SP's business. Idempotent: if `stripeAccountId` is already
 * set, we just refresh status from Stripe and return it.
 */
router.post("/me/stripe/connect/account", requireRole("business"), async (req, res) => {
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

  let acct: Stripe.Account;
  if (biz.stripeAccountId) {
    // Already created — just refresh from Stripe so the response is honest
    // about charges/payouts state.
    acct = await stripeService.retrieveAccount(biz.stripeAccountId);
  } else {
    const [user] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, auth.userId));
    if (!user?.email) {
      res.status(400).json({ error: "Your account has no email on file; cannot start Connect onboarding." });
      return;
    }
    try {
      acct = await stripeService.createConnectAccount(user.email, auth.businessId, auth.userId);
    } catch (err) {
      if (isConnectNotEnabledError(err)) {
        req.log.error({ businessId: auth.businessId }, "stripe.connect.platform_not_enabled");
        res.status(503).json({
          error: "Stripe Connect has not been enabled on the platform account. Visit https://dashboard.stripe.com/connect to sign up.",
          reason: "connect_not_enabled",
        });
        return;
      }
      req.log.error({ err, businessId: auth.businessId }, "stripe.connect.account.create_failed");
      res.status(500).json({ error: "Could not create Stripe Connect account" });
      return;
    }
    req.log.info(
      { businessId: auth.businessId, accountId: acct.id },
      "stripe.connect.account.created",
    );
  }

  await mirrorAccountToBusiness(auth.businessId, acct);

  res.json({
    accountId: acct.id,
    status: deriveStatus(acct),
    chargesEnabled: !!acct.charges_enabled,
    payoutsEnabled: !!acct.payouts_enabled,
    requirementsDue: requirementsDue(acct),
  });
});

/**
 * POST /me/stripe/connect/onboarding-link — mint a one-shot Account Link the
 * mobile client opens via WebBrowser. Auto-creates the account if missing
 * (so the mobile flow can be a single button). The link expires in ~5min;
 * the refresh_url loops back here to re-mint.
 */
router.post("/me/stripe/connect/onboarding-link", requireRole("business"), async (req, res) => {
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

  // Auto-create the account if the SP hits this endpoint without going
  // through POST /account first.
  let accountId = biz.stripeAccountId;
  if (!accountId) {
    const [user] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, auth.userId));
    if (!user?.email) {
      res.status(400).json({ error: "Your account has no email on file; cannot start Connect onboarding." });
      return;
    }
    let created: Stripe.Account;
    try {
      created = await stripeService.createConnectAccount(user.email, auth.businessId, auth.userId);
    } catch (err) {
      if (isConnectNotEnabledError(err)) {
        req.log.error({ businessId: auth.businessId }, "stripe.connect.platform_not_enabled");
        res.status(503).json({
          error: "Stripe Connect has not been enabled on the platform account. Visit https://dashboard.stripe.com/connect to sign up.",
          reason: "connect_not_enabled",
        });
        return;
      }
      req.log.error({ err, businessId: auth.businessId }, "stripe.connect.account.create_failed");
      res.status(500).json({ error: "Could not create Stripe Connect account" });
      return;
    }
    accountId = created.id;
    await mirrorAccountToBusiness(auth.businessId, created);
  }

  const base = publicBaseUrl();
  // refresh_url: Stripe loads this when the link itself expired (rare in
  // practice for a 5-min flow). return_url: where Stripe sends the SP after
  // they finish (success or cancelled). Both are simple HTML on the API
  // server; mobile re-fetches account state when the WebBrowser closes.
  const refreshUrl = `${base}/api/stripe/connect/return?status=refresh`;
  const returnUrl = `${base}/api/stripe/connect/return?status=done`;

  try {
    const link = await stripeService.createAccountLink(accountId, refreshUrl, returnUrl);
    res.json({
      url: link.url,
      expiresAt: new Date(link.expires_at * 1000).toISOString(),
    });
  } catch (err) {
    req.log.error({ err, accountId }, "stripe.connect.onboarding_link.failed");
    res.status(500).json({ error: "Could not create Stripe onboarding link" });
  }
});

/**
 * GET /me/stripe/connect/account — current Connect state for the calling SP's
 * business. Returns null accountId if onboarding has never been started.
 *
 * Always re-fetches from Stripe when an account exists, so the UI doesn't
 * rely on the webhook having landed first.
 */
router.get("/me/stripe/connect/account", requireRole("business"), async (req, res) => {
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

  if (!biz.stripeAccountId) {
    res.json({
      accountId: null,
      status: "none" as const,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
    });
    return;
  }

  let acct: Stripe.Account;
  try {
    acct = await stripeService.retrieveAccount(biz.stripeAccountId);
  } catch (err) {
    // Don't fail the UI if Stripe is briefly unreachable — return the last
    // mirrored DB state.
    req.log.warn({ err, accountId: biz.stripeAccountId }, "stripe.connect.account.retrieve_failed");
    res.json({
      accountId: biz.stripeAccountId,
      status: biz.stripeAccountStatus as ConnectStatus,
      chargesEnabled: biz.stripeChargesEnabled,
      payoutsEnabled: biz.stripePayoutsEnabled,
      requirementsDue: [],
    });
    return;
  }

  await mirrorAccountToBusiness(auth.businessId, acct);

  res.json({
    accountId: acct.id,
    status: deriveStatus(acct),
    chargesEnabled: !!acct.charges_enabled,
    payoutsEnabled: !!acct.payouts_enabled,
    requirementsDue: requirementsDue(acct),
  });
});

/**
 * Static return/refresh endpoint Stripe redirects to after Express onboarding.
 * Just renders a tiny page so the WebBrowser closes cleanly; the mobile app
 * re-fetches `GET /me/stripe/connect/account` on focus and reflects state.
 */
router.get("/stripe/connect/return", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><title>Stripe onboarding</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:48px 24px;text-align:center;color:#111}</style>
</head><body>
<h2>You can close this window.</h2>
<p>Return to the AK On Demand app to see your payout status.</p>
</body></html>`);
});

export default router;
