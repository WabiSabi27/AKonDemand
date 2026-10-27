import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Stripe from "stripe";
import {
  db,
  businessesTable,
  usersTable,
  bizAccountsTable,
  bookingsTable,
  stripeWebhookDeadLetterTable,
} from "@workspace/db";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { logger } from "./lib/logger";
import { createNotification } from "./lib/notifications";
import { deriveStatus } from "./routes/meStripeConnect";
import { genId } from "./lib/ids";
import { finalizeBizAccountOnboarding } from "./lib/bizOnboarding";
import { sendMeetingEmail } from "./lib/meetingEmail";
import { checkoutReceipt } from "./lib/paymentReceipts";
import { withDeadLetterClaim } from "./lib/deadLetterClaim";
import { DuplicateFeePaymentError, withPaymentReview } from "./lib/stripePaymentReview";
import type { BizAccount } from "@workspace/db";
import {
  isActiveSubscriptionStatus,
  parsePlanTier,
  type PlanTier,
} from "./lib/plans";

/**
 * TD-3 — handler names persisted with each dead-letter row. Stable identifiers
 * so the retry path can re-dispatch by name without re-introspecting the
 * event type.
 */
const WEBHOOK_HANDLER_NAMES = [
  "subscription_mirror",
  "connect_mirror",
  "pi_succeeded",
  "pi_failed",
  "dispute",
  "biz_account_paid",
] as const;
type WebhookHandlerName = (typeof WEBHOOK_HANDLER_NAMES)[number];

function isWebhookHandlerName(s: string): s is WebhookHandlerName {
  return (WEBHOOK_HANDLER_NAMES as readonly string[]).includes(s);
}

/**
 * Resolve candidate Stripe webhook signing secrets, in preference order:
 * 1. STRIPE_WEBHOOK_SECRET env (when explicitly configured)
 * 2. Managed-webhook secrets persisted by stripe-replit-sync in the
 *    `stripe."_managed_webhooks"` table (newest first) — the same secrets
 *    the sync layer uses to verify signatures.
 *
 * All candidates are returned (not just the newest row) because historical
 * or recreated managed-webhook rows can coexist; the verifier tries each.
 * Results are cached; callers pass `fresh: true` to bypass the cache after
 * a verification failure (e.g. secret rotation mid-process).
 */
let cachedWebhookSecrets: string[] | null = null;
async function getWebhookSecrets(opts?: { fresh?: boolean }): Promise<string[]> {
  if (!opts?.fresh && cachedWebhookSecrets) return cachedWebhookSecrets;
  const secrets: string[] = [];
  if (process.env.STRIPE_WEBHOOK_SECRET) secrets.push(process.env.STRIPE_WEBHOOK_SECRET);
  try {
    const result = await db.execute(
      sql`SELECT secret FROM "stripe"."_managed_webhooks" WHERE secret IS NOT NULL ORDER BY created DESC`,
    );
    for (const row of result.rows as { secret?: string }[]) {
      if (row.secret && !secrets.includes(row.secret)) secrets.push(row.secret);
    }
  } catch (err) {
    logger.error({ err }, "stripe.webhook.secret_lookup_failed");
  }
  cachedWebhookSecrets = secrets;
  return secrets;
}

/**
 * Verify a webhook payload against every known candidate secret. On total
 * failure, refreshes the candidate list from the DB once and retries —
 * covering secret rotation or webhook recreation after the cache was primed.
 */
function tryConstructEvent(
  stripe: Stripe,
  payload: Buffer,
  signature: string,
  secrets: string[],
): Stripe.Event | null {
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function recordDeadLetter(args: {
  event: Stripe.Event;
  handlerName: WebhookHandlerName;
  err: unknown;
}): Promise<void> {
  const message = args.err instanceof Error ? args.err.message : String(args.err);
  const stack = args.err instanceof Error && args.err.stack ? args.err.stack : null;
  try {
    // JSON-roundtrip the event so anything non-serialisable (functions,
    // BigInt, circular refs from a future Stripe SDK shape) surfaces here
    // rather than as a vague pg JSONB cast error at insert time.
    let safePayload: Record<string, unknown>;
    try {
      safePayload = withPaymentReview(JSON.parse(JSON.stringify(args.event)) as Record<string, unknown>, args.err);
    } catch (jsonErr) {
      logger.error(
        { jsonErr, eventId: args.event.id, eventType: args.event.type },
        "stripe.webhook.dead_letter.payload_unserialisable",
      );
      // Preserve at least the identifying fields so the row is still useful.
      safePayload = { id: args.event.id, type: args.event.type, _serialisationFailed: true };
    }
    await db.transaction(async (tx) => {
      // Lock the logical key even when no row exists yet. A row lock alone
      // cannot prevent concurrent first deliveries from both inserting.
      // This works across API replicas without adding a unique index that
      // would fail to deploy against historical duplicate rows.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${"stripe_dead_letter:" + args.event.id}),
          hashtext(${args.handlerName})
        )
      `);
      const [existing] = await tx.select().from(stripeWebhookDeadLetterTable)
        .where(and(
          eq(stripeWebhookDeadLetterTable.eventId, args.event.id),
          eq(stripeWebhookDeadLetterTable.handlerName, args.handlerName),
        ))
        .orderBy(asc(stripeWebhookDeadLetterTable.createdAt), asc(stripeWebhookDeadLetterTable.id))
        .limit(1)
        .for("update");
      if (existing) {
        await tx.update(stripeWebhookDeadLetterTable).set({
          attempts: sql`${stripeWebhookDeadLetterTable.attempts} + 1`,
          lastError: stack ?? message,
          ...(args.err instanceof DuplicateFeePaymentError ? { payload: safePayload } : {}),
          lastAttemptAt: new Date(),
          // Respect an explicit admin dismissal; a new failure after recovery
          // reopens the same item rather than creating a second alert.
          status: existing.status === "ignored" ? "ignored" : "pending",
          resolvedAt: existing.status === "ignored" ? existing.resolvedAt : null,
        }).where(eq(stripeWebhookDeadLetterTable.id, existing.id));
      } else {
        await tx.insert(stripeWebhookDeadLetterTable).values({
          id: genId("sdl"),
          eventId: args.event.id,
          eventType: args.event.type,
          handlerName: args.handlerName,
          payload: safePayload,
          status: "pending",
          attempts: 1,
          lastError: stack ?? message,
          lastAttemptAt: new Date(),
        });
      }
    });
    logger.warn(
      { eventId: args.event.id, eventType: args.event.type, handlerName: args.handlerName },
      "stripe.webhook.dead_letter.recorded",
    );
  } catch (insertErr) {
    // Last-resort: if even the dead-letter insert fails, all we can do is log
    // loudly so the operator notices via log alerts.
    logger.error(
      { insertErr, originalErr: args.err, eventId: args.event.id },
      "stripe.webhook.dead_letter.insert_failed",
    );
  }
}

/**
 * Map a Stripe subscription event to a `PlanTier` by walking the first
 * subscription item's price → product → `metadata.plan_tier`. We accept
 * either the raw API object (when handed off from a verified webhook) or a
 * row from the sync'd `stripe.subscriptions` table.
 */
async function derivePlanTierFromSubscription(
  sub: Stripe.Subscription,
): Promise<PlanTier | null> {
  const item = sub.items?.data?.[0];
  if (!item) return null;
  const price = item.price;
  if (!price) return null;

  // Cheapest path: read the product's metadata. The price object may already
  // expand `product`, but defensively re-fetch the product if not.
  let productMeta: Stripe.Metadata | undefined;
  if (typeof price.product === "string") {
    const stripe = await getUncachableStripeClient();
    const product = await stripe.products.retrieve(price.product);
    productMeta = product.metadata;
  } else if (price.product && !("deleted" in price.product)) {
    productMeta = price.product.metadata;
  }

  return parsePlanTier(productMeta?.plan_tier ?? sub.metadata?.plan ?? null);
}

/**
 * Reflect a subscription's current state into the `businesses` row:
 *   - `subscriptionPlan` ← plan derived from the price's product metadata
 *   - `subscriptionActive` ← Stripe status ∈ {active, trialing}
 *
 * Resolves the target business by:
 *   1. `subscription.metadata.businessId` if present (set by our checkout flow), then
 *   2. `users.stripe_customer_id` → `businesses.ownerId`.
 *
 * Also persists `users.stripe_subscription_id` so `/me/subscription` can find
 * the current period end.
 */
async function mirrorSubscriptionToBusiness(
  sub: Stripe.Subscription,
  opts: { isDeletion: boolean },
): Promise<void> {
  // 1) find owning user
  let ownerUserId: string | null = (sub.metadata?.userId as string | undefined) ?? null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;

  if (!ownerUserId && customerId) {
    const [u] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.stripeCustomerId, customerId));
    ownerUserId = u?.id ?? null;
  }
  if (!ownerUserId) {
    logger.warn({ subscriptionId: sub.id, customerId }, "stripe.webhook.unknown_owner");
    return;
  }

  // 2) find owning business (prefer explicit metadata.businessId)
  const explicitBizId = (sub.metadata?.businessId as string | undefined) ?? null;
  let businessId: string | null = explicitBizId;
  if (!businessId) {
    const [b] = await db
      .select({ id: businessesTable.id })
      .from(businessesTable)
      .where(eq(businessesTable.ownerId, ownerUserId));
    businessId = b?.id ?? null;
  }

  // 3) keep users.stripe_subscription_id current regardless (clears on deletion)
  await db
    .update(usersTable)
    .set({ stripeSubscriptionId: opts.isDeletion ? null : sub.id })
    .where(eq(usersTable.id, ownerUserId));

  if (!businessId) {
    logger.warn(
      { subscriptionId: sub.id, ownerUserId },
      "stripe.webhook.no_business_for_owner",
    );
    return;
  }

  // 4) update businesses row
  if (opts.isDeletion) {
    await db
      .update(businessesTable)
      .set({ subscriptionActive: false })
      .where(eq(businessesTable.id, businessId));
    logger.info(
      { subscriptionId: sub.id, businessId },
      "stripe.webhook.subscription.deleted.mirrored",
    );
    return;
  }

  const plan = await derivePlanTierFromSubscription(sub);
  const active = isActiveSubscriptionStatus(sub.status);
  const patch: { subscriptionActive: boolean; subscriptionPlan?: PlanTier } = {
    subscriptionActive: active,
  };
  if (plan) patch.subscriptionPlan = plan;

  await db.update(businessesTable).set(patch).where(eq(businessesTable.id, businessId));
  logger.info(
    {
      subscriptionId: sub.id,
      businessId,
      plan: plan ?? "(unchanged)",
      status: sub.status,
      active,
    },
    "stripe.webhook.subscription.mirrored",
  );
}

/**
 * A paid timestamp, not a checkout-offer ID alone, establishes a receipt.
 * Throwing keeps a separate charge visible in the existing admin recovery
 * queue (including on replay) until an admin investigates it in Stripe.
 */
function assertNoExtraFeePayment(acct: BizAccount, session: Stripe.Checkout.Session, onboarding: boolean): void {
  const paidAt = onboarding ? acct.onboardingPaidAt : acct.paidAt;
  const originalSessionId = onboarding ? acct.onboardingSessionId : acct.stripeSessionId;
  if (!paidAt || !originalSessionId || originalSessionId === session.id) return;

  const receipt = checkoutReceipt(session);
  const amount = receipt ? `${receipt.amountCents} ${receipt.currency} (minor units)` : "amount/currency unknown";
  throw new DuplicateFeePaymentError(
    `Duplicate ${onboarding ? "onboarding" : "application"} payment for biz account ${acct.id}: ` +
    `original paid session ${originalSessionId}; extra paid session ${session.id}; ${amount}. ` +
    "Original receipt retained. Admin investigation/refund review required in Stripe; no automatic refund. " +
    "Retry will not resolve this extra charge; dismiss the alert only after manual review.",
    originalSessionId, session.id,
  );
}

/**
 * When an applicant completes a one-time Stripe Checkout Session for an SP
 * application, advance their biz_account row. Two fees flow through here,
 * distinguished by `session.metadata.feeType`:
 *
 *   - "application": `awaiting_payment` → `pending` (paid, awaiting the
 *     offline interview + admin accept). Stamps `paidAt`.
 *   - "onboarding": `accepted` → `approved` AND creates the public
 *     `businesses` row (via `finalizeBizAccountOnboarding`). Stamps
 *     `onboardingPaidAt` + `onboardingSessionId`.
 *
 * Legacy/missing `feeType` is treated as "application" for backward compat.
 *
 * Idempotency: each branch only acts on its expected source status. Onboarding
 * retries keep the first receipt and retry activation until approved; subsequent
 * redeliveries then become no-ops.
 *
 * Subscription Checkout Sessions (the plan products) also fire this event — we
 * filter those out by requiring `mode === 'payment'` and the `bizAccountId`
 * metadata key our checkout routes set.
 */
async function markBizAccountPaid(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== "payment") return;
  if (session.payment_status !== "paid") {
    logger.info(
      { sessionId: session.id, paymentStatus: session.payment_status },
      "stripe.webhook.checkout.completed.not_paid",
    );
    return;
  }
  const bizAccountId = (session.metadata?.bizAccountId as string | undefined) ?? null;
  if (!bizAccountId) {
    // Other one-time payments (e.g. future booking flow) will land here too —
    // ignore quietly.
    return;
  }
  const feeType = (session.metadata?.feeType as string | undefined) ?? "application";
  const receipt = checkoutReceipt(session);

  const [acct] = await db
    .select()
    .from(bizAccountsTable)
    .where(eq(bizAccountsTable.id, bizAccountId));
  if (!acct) {
    logger.warn(
      { sessionId: session.id, bizAccountId },
      "stripe.webhook.checkout.completed.unknown_biz_account",
    );
    return;
  }

  assertNoExtraFeePayment(acct, session, feeType === "onboarding");

  // A competing webhook or status reconciliation can win the conditional
  // receipt write below. Compare against that winner, not our earlier SELECT.
  const checkWinningReceipt = async () => {
    const [winner] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, bizAccountId));
    if (winner) assertNoExtraFeePayment(winner, session, feeType === "onboarding");
  };

  if (feeType === "onboarding") {
    if (acct.status !== "accepted") {
      logger.info(
        { sessionId: session.id, bizAccountId, status: acct.status },
        "stripe.webhook.checkout.completed.onboarding_idempotent_noop",
      );
      return;
    }
    const [captured] = await db
      .update(bizAccountsTable)
      .set({
        onboardingPaidAt: new Date(), onboardingSessionId: session.id,
        onboardingPaidAmountCents: receipt?.amountCents ?? null,
        onboardingPaidCurrency: receipt?.currency ?? null,
      })
      // Capture the first confirmed payment only. If finalization fails, a
      // replay must retry approval without replacing its historical receipt.
      .where(and(
        eq(bizAccountsTable.id, bizAccountId),
        eq(bizAccountsTable.status, "accepted"),
        isNull(bizAccountsTable.onboardingPaidAt),
      ))
      .returning({ id: bizAccountsTable.id });
    if (!captured) await checkWinningReceipt();
    const result = await finalizeBizAccountOnboarding(bizAccountId);
    if (!result.ok) {
      logger.warn(
        { sessionId: session.id, bizAccountId, reason: result.reason },
        "stripe.webhook.checkout.completed.onboarding_finalize_failed",
      );
      // Payment is durable, but activation still needs recovery. Let the live
      // webhook persist a dead letter and request redelivery, and let admin
      // replay keep the entry pending until activation actually succeeds.
      throw new Error(
        `Paid onboarding activation failed for biz account ${bizAccountId} ` +
        `(session ${session.id}): ${result.reason}`,
      );
    }
    logger.info(
      { sessionId: session.id, bizAccountId, businessId: result.business.id },
      "stripe.webhook.checkout.completed.onboarding_approved",
    );
    // Notify the provider that their application is now approved (this
    // webhook path is the primary approval flow: accept → pay onboarding fee
    // → auto-approve). Fire-and-forget; the outbox retries on failure.
    void sendMeetingEmail(
      {
        toEmail: result.bizAccount.email,
        ownerName: result.bizAccount.ownerName,
        businessName: result.bizAccount.businessName,
        kind: "approved",
        meetingAt: null,
      },
      logger,
    );
    return;
  }

  // Application fee branch.
  if (acct.status !== "awaiting_payment") {
    logger.info(
      { sessionId: session.id, bizAccountId, status: acct.status },
      "stripe.webhook.checkout.completed.idempotent_noop",
    );
    return;
  }

  const [updated] = await db
    .update(bizAccountsTable)
    .set({
      status: "pending",
      paidAt: new Date(),
      applicationPaidAmountCents: receipt?.amountCents ?? null,
      applicationPaidCurrency: receipt?.currency ?? null,
      // Re-stamp stripeSessionId in case the row predates session creation.
      stripeSessionId: session.id,
    })
    // Match the state in the UPDATE too: another webhook or status
    // reconciliation may have recorded the receipt since the SELECT above.
    .where(and(
      eq(bizAccountsTable.id, bizAccountId),
      eq(bizAccountsTable.status, "awaiting_payment"),
      isNull(bizAccountsTable.paidAt),
    ))
    .returning({ id: bizAccountsTable.id });
  if (!updated) {
    await checkWinningReceipt();
    return;
  }
  logger.info(
    { sessionId: session.id, bizAccountId },
    "stripe.webhook.checkout.completed.marked_paid",
  );
  // Confirm receipt of the application fee. Fire-and-forget; the outbox
  // retries on failure.
  void sendMeetingEmail(
    {
      toEmail: acct.email,
      ownerName: acct.ownerName,
      businessName: acct.businessName,
      kind: "application_received",
      meetingAt: null,
    },
    logger,
  );
}

/**
 * Phase 2 #6 — Mirror an updated Connect Account onto the business row.
 * Resolves the target row by `stripeAccountId` (which is set on first
 * `accounts.create` call from /me/stripe/connect/account). If the account
 * doesn't belong to a known business yet (rare race: webhook arrived before
 * our DB write), we no-op.
 */
async function mirrorConnectAccountToBusiness(acct: Stripe.Account): Promise<void> {
  const [biz] = await db
    .select({ id: businessesTable.id })
    .from(businessesTable)
    .where(eq(businessesTable.stripeAccountId, acct.id));
  if (!biz) {
    logger.info({ accountId: acct.id }, "stripe.webhook.account.no_business_yet");
    return;
  }
  await db
    .update(businessesTable)
    .set({
      stripeAccountStatus: deriveStatus(acct),
      stripeChargesEnabled: !!acct.charges_enabled,
      stripePayoutsEnabled: !!acct.payouts_enabled,
    })
    .where(eq(businessesTable.id, biz.id));
  logger.info(
    {
      accountId: acct.id,
      businessId: biz.id,
      chargesEnabled: !!acct.charges_enabled,
      payoutsEnabled: !!acct.payouts_enabled,
    },
    "stripe.webhook.account.mirrored",
  );
}

/**
 * Phase 2 #6 — Payment succeeded for a booking. The booking row already
 * exists in `pending` (created up-front by /bookings/payment-intent). We
 * notify the SP that a paid booking is waiting for them to confirm.
 *
 * Idempotent: a SELECT-then-NOOP keeps redelivered events from double-pinging.
 */
async function onBookingPaymentSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  const bookingId = (pi.metadata?.bookingId as string | undefined) ?? null;
  if (!bookingId) return;

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    logger.warn({ paymentIntentId: pi.id, bookingId }, "stripe.webhook.pi.unknown_booking");
    return;
  }
  if (booking.status === "cancelled") {
    // Refunded / cancelled in the meantime — don't ping the SP.
    return;
  }

  const [biz] = await db
    .select({ ownerId: businessesTable.ownerId })
    .from(businessesTable)
    .where(eq(businessesTable.id, booking.businessId));
  if (!biz?.ownerId) return;

  const whenLabel = `${booking.scheduledDate}${booking.scheduledTime ? ` at ${booking.scheduledTime}` : ""}`;
  await createNotification(
    {
      userId: biz.ownerId,
      kind: "booking_created",
      title: "Paid booking ready",
      body: `${booking.customerName || "A customer"} paid for ${booking.serviceTitle} (${booking.optionName}) — ${whenLabel}.`,
      bookingId,
    },
    logger,
  );
  logger.info({ bookingId, paymentIntentId: pi.id }, "stripe.webhook.pi.succeeded.notified");
}

/**
 * Phase 2 #6 — Payment failed/canceled. Drop the draft booking row so the
 * SP doesn't see a ghost pending row that will never get paid. The customer
 * gets a soft notification so they know to retry from their end.
 */
async function onBookingPaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
  const bookingId = (pi.metadata?.bookingId as string | undefined) ?? null;
  if (!bookingId) return;

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) return; // already cleaned up

  // Only delete if still pending and unpaid (no other PI ever succeeded for it).
  if (booking.status !== "pending") {
    logger.info({ bookingId, status: booking.status }, "stripe.webhook.pi.failed.skip_non_pending");
    return;
  }

  await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
  logger.info({ bookingId, paymentIntentId: pi.id }, "stripe.webhook.pi.failed.booking_dropped");

  try {
    await createNotification(
      {
        userId: booking.customerId,
        kind: "booking_payment_failed",
        title: "Booking payment failed",
        body: `Your payment for ${booking.serviceTitle} with ${booking.businessName} didn't go through. The booking has been removed — please try again.`,
      },
      logger,
    );
  } catch (err) {
    logger.warn({ err, bookingId }, "stripe.webhook.pi.failed.notify_failed");
  }
}

/**
 * Phase 3 #2 — Stripe disputes (chargebacks). When the cardholder files a
 * chargeback with their bank, Stripe holds the funds (plus a fee) and
 * notifies us via `charge.dispute.created`. We resolve the booking by the
 * dispute's payment_intent, persist `disputeId/disputeStatus/disputeCreatedAt`,
 * and notify every admin + the SP owner so somebody actually responds before
 * the deadline. We deliberately do NOT auto-refund — Stripe moves the funds
 * itself via the dispute mechanism, and an admin may want to contest.
 *
 * Idempotent: re-firing `created` for a row that already has the same
 * `disputeId` only refreshes the status; new disputes (rare — would require a
 * second PI) overwrite. Closures just update `disputeStatus`.
 */
async function onChargeDispute(
  dispute: Stripe.Dispute,
  eventType: "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed",
): Promise<void> {
  const piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id ?? null;
  if (!piId) {
    logger.warn({ disputeId: dispute.id }, "stripe.webhook.dispute.no_payment_intent");
    return;
  }
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.paymentIntentId, piId));
  if (!booking) {
    logger.warn({ disputeId: dispute.id, paymentIntentId: piId }, "stripe.webhook.dispute.unknown_booking");
    return;
  }

  await db
    .update(bookingsTable)
    .set({
      disputeId: dispute.id,
      disputeStatus: dispute.status,
      disputeCreatedAt: booking.disputeCreatedAt ?? new Date(dispute.created * 1000),
    })
    .where(eq(bookingsTable.id, booking.id));

  const isClose = eventType === "charge.dispute.closed";
  const kind = isClose ? "dispute_closed" : "dispute_opened";
  // Notify only on create + close (skip mid-life "updated" events to avoid spam).
  if (eventType === "charge.dispute.updated") {
    logger.info({ disputeId: dispute.id, bookingId: booking.id, status: dispute.status }, "stripe.webhook.dispute.updated");
    return;
  }

  const recipients = new Set<string>();
  const [biz] = await db.select({ ownerId: businessesTable.ownerId }).from(businessesTable).where(eq(businessesTable.id, booking.businessId));
  if (biz?.ownerId) recipients.add(biz.ownerId);
  const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
  for (const a of admins) recipients.add(a.id);

  const title = isClose ? `Dispute ${dispute.status}` : "New dispute opened";
  const body = isClose
    ? `Stripe closed the dispute for ${booking.serviceTitle} (booking ${booking.id}) as "${dispute.status}".`
    : `A cardholder disputed the charge for ${booking.serviceTitle} (booking ${booking.id}). Respond in Stripe before the deadline.`;
  for (const userId of recipients) {
    try {
      await createNotification({ userId, kind, title, body, bookingId: booking.id }, logger);
    } catch (err) {
      logger.warn({ err, userId, disputeId: dispute.id }, "stripe.webhook.dispute.notify_failed");
    }
  }
  logger.info({ disputeId: dispute.id, bookingId: booking.id, status: dispute.status, kind }, "stripe.webhook.dispute.persisted");
}

/**
 * TD-3 — single dispatch table for both the live webhook path and the
 * admin replay path. Returns `null` if the event type has no handler we
 * care about, so the live path can short-circuit silently.
 */
async function runHandler(
  handlerName: WebhookHandlerName,
  event: Stripe.Event,
): Promise<void> {
  switch (handlerName) {
    case "subscription_mirror":
      await mirrorSubscriptionToBusiness(event.data.object as Stripe.Subscription, {
        isDeletion: event.type === "customer.subscription.deleted",
      });
      return;
    case "connect_mirror":
      await mirrorConnectAccountToBusiness(event.data.object as Stripe.Account);
      return;
    case "pi_succeeded":
      await onBookingPaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      return;
    case "pi_failed":
      await onBookingPaymentFailed(event.data.object as Stripe.PaymentIntent);
      return;
    case "dispute":
      await onChargeDispute(
        event.data.object as Stripe.Dispute,
        event.type as "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed",
      );
      return;
    case "biz_account_paid":
      await markBizAccountPaid(event.data.object as Stripe.Checkout.Session);
      return;
    default: {
      // Exhaustiveness guard — the union is closed, but a corrupted DB row
      // could still slip through `isWebhookHandlerName` by way of a future
      // schema change. Throwing here means `replayDeadLetterRow` records the
      // failure rather than silently marking the row resolved.
      const _exhaustive: never = handlerName;
      void _exhaustive;
      throw new Error(`Unknown webhook handler name: ${handlerName as string}`);
    }
  }
}

/**
 * Admin replay entry point. Holds a recoverable database claim across dispatch.
 * Attempts commit separately so interrupted work stays pending with its attempt
 * recorded. Failed work also stays pending; terminal rows cannot be replayed.
 *
 *   - Returns `in_progress` while another admin is retrying/ignoring the row
 *     or this process has reached its recovery concurrency limit.
 *   - Returns `not_pending` if a concurrent admin already resolved/ignored
 *     the row before our claim landed (admin route maps to 409).
 *   - Returns `invalid_handler` if the persisted handlerName isn't a known
 *     dispatch target — we mark the row's lastError so the operator sees
 *     it, but never silently mark it resolved.
 */
export async function replayDeadLetterRow(row: {
  id: string;
  handlerName: string;
  payload: unknown;
}): Promise<
  | { ok: true }
  | { ok: false; error: string; reason: "handler_threw" | "not_pending" | "invalid_handler" | "in_progress" }
> {
  const claim = await withDeadLetterClaim(row.id, async () => {
    // Check status only after acquiring the exclusive claim. Keep this write
    // outside the lock transaction so process loss does not erase the attempt.
    const attempt = await db.execute(sql`
      UPDATE public.stripe_webhook_dead_letter
         SET attempts = attempts + 1,
             last_attempt_at = NOW()
       WHERE id = ${row.id} AND status = 'pending'
       RETURNING id
    `);
    if (attempt.rowCount === 0) {
      return { ok: false, error: "Row is no longer pending", reason: "not_pending" } as const;
    }

    if (!isWebhookHandlerName(row.handlerName)) {
      const message = `Invalid handlerName "${row.handlerName}" — cannot replay.`;
      await db
        .update(stripeWebhookDeadLetterTable)
        .set({ lastError: message })
        .where(eq(stripeWebhookDeadLetterTable.id, row.id));
      logger.error({ deadLetterId: row.id, handlerName: row.handlerName }, "stripe.webhook.dead_letter.invalid_handler");
      return { ok: false, error: message, reason: "invalid_handler" } as const;
    }

    const handlerName: WebhookHandlerName = row.handlerName;
    const event = row.payload as Stripe.Event;

    try {
      await runHandler(handlerName, event);
      await db
        .update(stripeWebhookDeadLetterTable)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(stripeWebhookDeadLetterTable.id, row.id));
      logger.info({ deadLetterId: row.id, handlerName, eventId: event.id }, "stripe.webhook.dead_letter.resolved");
      return { ok: true } as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack : null;
      await db
        .update(stripeWebhookDeadLetterTable)
        .set({ lastError: stack ?? message, payload: withPaymentReview(event as unknown as Record<string, unknown>, err) })
        .where(eq(stripeWebhookDeadLetterTable.id, row.id));
      logger.warn({ deadLetterId: row.id, handlerName, err }, "stripe.webhook.dead_letter.replay_failed");
      return { ok: false, error: message, reason: "handler_threw" } as const;
    }
  });
  return claim.claimed
    ? claim.result
    : { ok: false, error: claim.reason === "capacity"
      ? "Recovery is busy with other entries. Please try again shortly."
      : "Recovery is already in progress for this entry", reason: "in_progress" };
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Received type: " +
          typeof payload +
          ". " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    // 1) Let stripe-replit-sync verify the signature and update the
    //    sync'd `stripe.*` schema. This is what backs storage.getSubscription
    //    and our /plans listing.
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // 2) Re-verify the signature ourselves (cheap — the secret is in env)
    //    so we can safely inspect the event and mirror subscription state
    //    into the `businesses` row. We can't re-use the sync's parsed event
    //    because it doesn't surface it to callers.
    const stripe = await getUncachableStripeClient();
    let secrets = await getWebhookSecrets();
    if (secrets.length === 0) {
      // Retry fresh in case the managed webhook row was created after the
      // cache was primed (e.g. boot ordering).
      secrets = await getWebhookSecrets({ fresh: true });
    }
    if (secrets.length === 0) {
      logger.warn("stripe.webhook.no_secret — skipping subscription mirror");
      return;
    }

    let event = tryConstructEvent(stripe, payload, signature, secrets);
    if (!event) {
      // Cache may be stale after a secret rotation / webhook recreation —
      // refresh from the DB once and retry before giving up.
      const freshSecrets = await getWebhookSecrets({ fresh: true });
      event = tryConstructEvent(stripe, payload, signature, freshSecrets);
    }
    if (!event) {
      // The sync layer already verified this signature, so failing here is
      // genuinely unexpected. Throw so the HTTP layer returns non-2xx and
      // Stripe redelivers — silently dropping could miss business-critical
      // events like checkout.session.completed.
      logger.error("stripe.webhook.signature_reverify_failed — no candidate secret verified");
      throw new Error("Stripe webhook signature re-verification failed");
    }

    // TD-3 — every handler now persists a dead-letter row on failure so an
    // admin can inspect/retry from the dashboard. Subscription/Connect/PI/
    // dispute errors are still swallowed (don't trigger Stripe redelivery —
    // the canonical state lives elsewhere). The biz-account-paid path STILL
    // rethrows so Stripe redelivers automatically; we record the dead-letter
    // first so even if Stripe eventually gives up, the admin has a queue
    // entry to act on.
    let handlerName: WebhookHandlerName | null = null;
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      handlerName = "subscription_mirror";
    } else if (event.type === "account.updated") {
      handlerName = "connect_mirror";
    } else if (event.type === "payment_intent.succeeded") {
      handlerName = "pi_succeeded";
    } else if (
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled"
    ) {
      handlerName = "pi_failed";
    } else if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.updated" ||
      event.type === "charge.dispute.closed"
    ) {
      handlerName = "dispute";
    } else if (event.type === "checkout.session.completed") {
      handlerName = "biz_account_paid";
    }

    if (!handlerName) {
      // Other event types: ignore — sync handles persistence for them.
      return;
    }

    try {
      await runHandler(handlerName, event);
      // A successful Stripe redelivery is recovery just like an admin replay.
      // Resolve every matching pending row, including duplicates recorded by
      // older versions, without touching another event/handler or ignored rows.
      await db.update(stripeWebhookDeadLetterTable).set({
        status: "resolved",
        resolvedAt: new Date(),
        attempts: sql`${stripeWebhookDeadLetterTable.attempts} + 1`,
        lastAttemptAt: new Date(),
      }).where(and(
        eq(stripeWebhookDeadLetterTable.eventId, event.id),
        eq(stripeWebhookDeadLetterTable.handlerName, handlerName),
        eq(stripeWebhookDeadLetterTable.status, "pending"),
      ));
    } catch (err) {
      logger.error(
        { err, eventId: event.id, eventType: event.type, handlerName },
        "stripe.webhook.handler_failed",
      );
      await recordDeadLetter({ event, handlerName, err });
      // Only the biz-account-paid path asks Stripe to redeliver. The other
      // handlers' canonical state lives in the sync schema / Stripe itself,
      // so a redelivery loop adds noise without fixing anything — admins
      // replay manually from the dead-letter queue.
      if (handlerName === "biz_account_paid") {
        throw err;
      }
    }
  }
}
