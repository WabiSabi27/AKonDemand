import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../lib/audit";
import bcrypt from "bcryptjs";
import { db, bizAccountsTable, usersTable } from "@workspace/db";
import {
  CreateBizAccountBody,
  UpdateBizAccountParams,
  UpdateBizAccountBody,
  ListBizAccountsQueryParams,
  GetBizAccountStatusParams,
  ApproveBizAccountParams,
  ApproveBizAccountBody,
  AcceptBizAccountParams,
  CreateOnboardingCheckoutParams,
  CreateOnboardingCheckoutBody,
  RejectBizAccountParams,
  RejectBizAccountBody,
  GetApplicationFeesResponse,
} from "@workspace/api-zod";
import { requireUser, requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { sendMeetingEmail } from "../lib/meetingEmail";
import { getUncachableStripeClient } from "../stripeClient";
import { finalizeBizAccountOnboarding } from "../lib/bizOnboarding";
import { APPLICATION_FEE_CENTS, ONBOARDING_FEE_CENTS } from "../lib/plans";
import type Stripe from "stripe";
import { checkoutReceipt, paymentReceipt } from "../lib/paymentReceipts";
import {
  ONBOARDING_LOCK_WAIT_MS,
  ONBOARDING_NETWORK_BUDGET_MS,
  onboardingCheckoutBudget,
  isOnboardingCheckoutUnavailable,
} from "../lib/onboardingCheckoutLimits";

const router: IRouter = Router();

const APPLICATION_TTL_DAYS = 30;

/**
 * Build the Stripe Checkout success/cancel URLs that point back at the mobile
 * app's payment-return screen. We embed the biz_account id (`ba_…`) so the
 * applicant can poll status without any client-side bridge state.
 *
 * Host selection:
 *  - In Replit dev, the Expo dev server runs on its OWN subdomain
 *    (`REPLIT_EXPO_DEV_DOMAIN` → `…expo.spock.replit.dev`) which is different
 *    from the shared proxy host (`REPLIT_DOMAINS[0]` → `…spock.replit.dev`).
 *    Routes are served at the root path. Using the proxy host here would land
 *    Stripe's redirect on a host that doesn't serve the route → blank screen.
 *  - In production, Expo Router is mounted at the public host's root.
 *    `/mobile/` is a workspace preview prefix, not a published route.
 *  - Without the independent Expo dev host, local shared-proxy previews still
 *    use `/mobile/`.
 */
function buildReturnUrls(bizAccountId: string, phase: "application" | "onboarding" = "application"): { successUrl: string; cancelUrl: string } {
  const expoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
  const prodDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  let base: string;
  if (process.env.NODE_ENV !== "production" && expoDomain) {
    base = `https://${expoDomain}`;
  } else if (prodDomain) {
    base = `https://${prodDomain}${process.env.NODE_ENV === "production" ? "" : "/mobile"}`;
  } else {
    base = "http://localhost/mobile";
  }
  return {
    successUrl: `${base}/payment-return?success=true&id=${bizAccountId}&session={CHECKOUT_SESSION_ID}${phase === "onboarding" ? "&phase=onboarding" : ""}`,
    cancelUrl: `${base}/payment-return?cancelled=true&id=${bizAccountId}`,
  };
}

/** Strip passwordHash before returning a biz_account to the client. */
function publicBizAccount(row: typeof bizAccountsTable.$inferSelect) {
  const { passwordHash: _omit, ...rest } = row;
  return rest;
}

/**
 * Resolve the Stripe line item for a one-time fee. Prefers the seeded fee
 * product/price (looked up by `metadata.fee_type`) so checkouts reference the
 * catalog the seed script builds; falls back to inline price_data if the seeded
 * price isn't present (e.g. seeding hasn't been run yet).
 */
async function resolveFeeLineItem(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  feeType: "application" | "onboarding",
  amountCents: number,
  name: string,
  description: string,
  requestOptions?: Stripe.RequestOptions,
): Promise<Stripe.Checkout.SessionCreateParams.LineItem> {
  try {
    const prices = await stripe.prices.search({
      query: `active:'true' AND metadata['fee_type']:'${feeType}'`,
    }, requestOptions);
    const match = prices.data.find((p) =>
      p.unit_amount === amountCents && p.currency === "usd" && p.type === "one_time",
    );
    if (match) return { price: match.id, quantity: 1 };
  } catch {
    // fall through to inline price_data
  }
  return {
    price_data: {
      currency: "usd",
      product_data: { name, description },
      unit_amount: amountCents,
    },
    quantity: 1,
  };
}

/**
 * GET /biz-accounts — admin-only list of SP applications, optionally filtered
 * by status. Returns biz_accounts WITHOUT the bcrypt hash. Used by the admin
 * dashboard to show pending/approved/rejected applications.
 */
router.get("/biz-accounts", requireRole("admin"), async (req, res) => {
  const q = ListBizAccountsQueryParams.parse(req.query);
  const rows = q.status
    ? await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.status, q.status))
    : await db.select().from(bizAccountsTable);
  req.log.info({ count: rows.length, status: q.status ?? "all" }, "listBizAccounts");
  res.json(rows.map(publicBizAccount));
});

/**
 * POST /biz-accounts — public SP application. Creates the `users` row
 * (role=business) AND a `biz_accounts` row in `awaiting_payment` state, then
 * creates a Stripe Checkout Session for the configured non-refundable application fee.
 *
 * Response shape: `{ bizAccount, checkoutUrl }`. The applicant should be sent to
 * `checkoutUrl`; on payment completion the Stripe webhook flips the row to
 * `pending` (paid, awaiting admin review) — see `webhookHandlers.ts`.
 *
 * The associated public `businesses` row is NOT auto-created here — that
 * happens when an admin calls `POST /biz-accounts/:id/approve`.
 */
router.get("/application-fees", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(GetApplicationFeesResponse.parse({
    applicationFeeCents: APPLICATION_FEE_CENTS,
    onboardingFeeCents: ONBOARDING_FEE_CENTS,
    currency: "usd",
  }));
});

router.post("/biz-accounts", async (req, res) => {
  const body = CreateBizAccountBody.parse(req.body);
  if (body.expectedApplicationFeeCents !== undefined &&
      body.expectedApplicationFeeCents !== APPLICATION_FEE_CENTS) {
    res.status(409).json({ error: "The application fee has changed. Please review the updated fee and try again." });
    return;
  }
  const email = body.email.trim().toLowerCase();

  // Reject duplicate emails on either users or biz_accounts.
  const [[userDup], [acctDup]] = await Promise.all([
    db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)),
    db.select({ id: bizAccountsTable.id }).from(bizAccountsTable).where(eq(bizAccountsTable.email, email)),
  ]);
  if (userDup || acctDup) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await bcrypt.hash(body.password, 10);
  const userId = genId("u");
  const acctId = genId("ba");
  const expiresAt = new Date(Date.now() + APPLICATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Wrap both inserts in a single transaction so a failure on the biz_account
  // insert rolls back the user row (avoids orphaned user accounts blocking later
  // re-applications by the same email). The Stripe Checkout Session is created
  // AFTER commit — if Stripe fails we run a compensating DELETE so the email
  // becomes free for retry (architect feedback: a stranded `awaiting_payment`
  // row would otherwise block re-application via the duplicate-email check
  // above, with no admin-less recovery path).
  const inserted = await db.transaction(async (tx) => {
    await tx.insert(usersTable).values({
      id: userId,
      name: body.ownerName,
      email,
      role: "business",
    });

    const [row] = await tx
      .insert(bizAccountsTable)
      .values({
        id: acctId,
        businessName: body.businessName,
        ownerName: body.ownerName,
        phone: body.phone ?? "",
        email,
        passwordHash,
        businessType: body.businessType,
        yearsInBusiness: body.yearsInBusiness ?? "",
        alaskaLicenseNumber: body.alaskaLicenseNumber ?? "",
        businessDescription: body.businessDescription ?? "",
        status: "awaiting_payment",
        expiresAt,
        ownerId: userId,
      })
      .returning();
    return row;
  });

  // Create the Stripe Checkout Session. We pass `bizAccountId` in BOTH the
  // session metadata AND the payment_intent metadata: the webhook fires with
  // `checkout.session.completed` (session metadata) but defense-in-depth lets
  // any later payment-intent inspection also resolve the application.
  let checkoutUrl: string;
  let sessionId: string;
  try {
    const stripe = await getUncachableStripeClient();
    const { successUrl, cancelUrl } = buildReturnUrls(acctId);
    const lineItem = await resolveFeeLineItem(
      stripe,
      "application",
      APPLICATION_FEE_CENTS,
      "AK On Demand – Service Provider Application Fee",
      "One-time, non-refundable fee to apply as a verified service provider on the AK On Demand marketplace. Valid for 30 days.",
    );
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [lineItem],
      customer_email: email,
      metadata: { bizAccountId: acctId, applicantName: body.ownerName, feeType: "application" },
      payment_intent_data: {
        metadata: { bizAccountId: acctId, applicantName: body.ownerName, feeType: "application" },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }
    checkoutUrl = session.url;
    sessionId = session.id;
  } catch (err) {
    req.log.error({ err, bizAccountId: acctId }, "bizAccount.checkout_session_failed");
    // Compensating delete: undo the user+biz_account inserts so the applicant
    // can retry with the same email. ON DELETE CASCADE on biz_accounts.ownerId
    // is NOT configured (the FK points users→bizAccounts, not the other way
    // around), so we delete both rows explicitly. Any failure here is logged
    // but doesn't change the response — the row is in `awaiting_payment` and
    // an admin can clean it up if compensation also failed.
    try {
      await db.transaction(async (tx) => {
        await tx.delete(bizAccountsTable).where(eq(bizAccountsTable.id, acctId));
        await tx.delete(usersTable).where(eq(usersTable.id, userId));
      });
    } catch (cleanupErr) {
      req.log.error(
        { err: cleanupErr, bizAccountId: acctId, userId },
        "bizAccount.checkout_session_failed.cleanup_failed",
      );
    }
    res.status(502).json({
      error: "Could not start payment. Please try again in a moment.",
    });
    return;
  }

  // Persist the Stripe session id on the row so the webhook handler and the
  // admin approve endpoint can correlate the payment back to the application.
  const [updated] = await db
    .update(bizAccountsTable)
    .set({ stripeSessionId: sessionId })
    .where(eq(bizAccountsTable.id, acctId))
    .returning();

  req.log.info(
    { bizAccountId: acctId, userId, email, sessionId },
    "bizAccount.applied",
  );
  res.status(201).json({
    bizAccount: publicBizAccount(updated),
    checkoutUrl,
  });
});

// Per-application throttle for the self-heal Stripe lookup below (60s).
const reconcileAttempts = new Map<string, number>();
function canAttemptReconcile(id: string): boolean {
  const now = Date.now();
  const last = reconcileAttempts.get(id);
  if (last !== undefined && now - last < 60_000) return false;
  // Opportunistic cleanup to keep the map bounded.
  if (reconcileAttempts.size > 1000) {
    for (const [k, t] of reconcileAttempts) {
      if (now - t > 60_000) reconcileAttempts.delete(k);
    }
  }
  reconcileAttempts.set(id, now);
  return true;
}

/**
 * GET /biz-accounts/:id/status — public, no-auth status check used by the
 * payment-return screen to poll for the webhook flip from `awaiting_payment`
 * → `pending`. The biz_account `id` (`ba_…`) is a sufficiently-random
 * capability token; we deliberately do NOT expose any other PII here.
 */
router.get("/biz-accounts/:id/status", async (req, res) => {
  const { id } = GetBizAccountStatusParams.parse(req.params);
  let [row] = await db
    .select({
      id: bizAccountsTable.id,
      status: bizAccountsTable.status,
      paidAt: bizAccountsTable.paidAt,
      meetingAt: bizAccountsTable.meetingAt,
      meetingLocation: bizAccountsTable.meetingLocation,
      meetingDurationMinutes: bizAccountsTable.meetingDurationMinutes,
      stripeSessionId: bizAccountsTable.stripeSessionId,
      applicationPaidAmountCents: bizAccountsTable.applicationPaidAmountCents,
      applicationPaidCurrency: bizAccountsTable.applicationPaidCurrency,
      onboardingPaidAmountCents: bizAccountsTable.onboardingPaidAmountCents,
      onboardingPaidCurrency: bizAccountsTable.onboardingPaidCurrency,
    })
    .from(bizAccountsTable)
    .where(eq(bizAccountsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  // Self-heal: if the payment webhook was missed (e.g. the Stripe webhook
  // endpoint was temporarily pointed at another environment), verify the
  // checkout session directly with Stripe and mark the application paid.
  // Throttled per-application so this public endpoint can't be abused to
  // amplify requests against the Stripe API.
  if (
    row.status === "awaiting_payment" &&
    row.stripeSessionId &&
    canAttemptReconcile(id)
  ) {
    try {
      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(row.stripeSessionId);
      // Integrity check: the session must actually belong to this application.
      const sessionBizId = session.metadata?.["bizAccountId"];
      if (session.payment_status === "paid" && sessionBizId === id) {
        const receipt = checkoutReceipt(session);
        const [updated] = await db
          .update(bizAccountsTable)
          .set({
            status: "pending", paidAt: new Date(),
            applicationPaidAmountCents: receipt?.amountCents ?? null,
            applicationPaidCurrency: receipt?.currency ?? null,
          })
          .where(
            and(eq(bizAccountsTable.id, id), eq(bizAccountsTable.status, "awaiting_payment")),
          )
          .returning({
            id: bizAccountsTable.id,
            status: bizAccountsTable.status,
            paidAt: bizAccountsTable.paidAt,
            meetingAt: bizAccountsTable.meetingAt,
            meetingLocation: bizAccountsTable.meetingLocation,
            meetingDurationMinutes: bizAccountsTable.meetingDurationMinutes,
            stripeSessionId: bizAccountsTable.stripeSessionId,
            applicationPaidAmountCents: bizAccountsTable.applicationPaidAmountCents,
            applicationPaidCurrency: bizAccountsTable.applicationPaidCurrency,
            onboardingPaidAmountCents: bizAccountsTable.onboardingPaidAmountCents,
            onboardingPaidCurrency: bizAccountsTable.onboardingPaidCurrency,
            email: bizAccountsTable.email,
            ownerName: bizAccountsTable.ownerName,
            businessName: bizAccountsTable.businessName,
          });
        if (updated) {
          req.log.info({ bizAccountId: id, sessionId: row.stripeSessionId }, "bizAccount.paid.reconciled");
          row = updated;
          // The webhook was missed, so its confirmation email never went out
          // — send it from here instead. Fire-and-forget; the outbox retries.
          void sendMeetingEmail(
            {
              toEmail: updated.email,
              ownerName: updated.ownerName,
              businessName: updated.businessName,
              kind: "application_received",
              meetingAt: null,
            },
            req.log,
          );
        }
      }
    } catch (err) {
      req.log.warn({ err, bizAccountId: id }, "bizAccount.status.reconcile_failed");
    }
  }

  res.json({
    id: row.id,
    status: row.status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    applicationPayment: paymentReceipt(row.applicationPaidAmountCents, row.applicationPaidCurrency),
    onboardingPayment: paymentReceipt(row.onboardingPaidAmountCents, row.onboardingPaidCurrency),
    meetingAt: row.meetingAt ? row.meetingAt.toISOString() : null,
    // Only expose location/duration when a meeting is actually scheduled —
    // this endpoint is public (capability-token id) and shouldn't leak
    // leftover details after a meeting is cleared.
    meetingLocation: row.meetingAt && row.meetingLocation ? row.meetingLocation : null,
    meetingDurationMinutes: row.meetingAt ? row.meetingDurationMinutes : null,
  });
});

/**
 * GET /me/biz-account — authenticated SP reads their OWN biz_account snapshot.
 * Mirrors the public /biz-accounts/:id/status response shape but resolves the
 * account from the auth token's businessId instead of a URL capability token,
 * so the logged-in provider dashboard can surface an upcoming meeting.
 */
router.get("/me/biz-account", requireRole("business"), async (req, res) => {
  const bizAccountId = req.auth?.businessId;
  if (!bizAccountId) {
    res.status(404).json({ error: "Biz account not found" });
    return;
  }
  const [row] = await db
    .select({
      id: bizAccountsTable.id,
      status: bizAccountsTable.status,
      paidAt: bizAccountsTable.paidAt,
      meetingAt: bizAccountsTable.meetingAt,
      meetingLocation: bizAccountsTable.meetingLocation,
      meetingDurationMinutes: bizAccountsTable.meetingDurationMinutes,
    })
    .from(bizAccountsTable)
    .where(eq(bizAccountsTable.id, bizAccountId));
  if (!row) {
    res.status(404).json({ error: "Biz account not found" });
    return;
  }
  res.json({
    id: row.id,
    status: row.status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    meetingAt: row.meetingAt ? row.meetingAt.toISOString() : null,
    // Match the public status endpoint: never leak stale location/duration
    // after a meeting has been cleared.
    meetingLocation: row.meetingAt && row.meetingLocation ? row.meetingLocation : null,
    meetingDurationMinutes: row.meetingAt ? row.meetingDurationMinutes : null,
  });
});

/**
 * PATCH /biz-accounts/:id — two distinct flows on the same endpoint:
 *  - Admin: can set `status` (pending|approved|rejected|awaiting_payment).
 *           Note: transitioning to "approved" does NOT auto-create the public
 *           `businesses` row — that's a follow-up task.
 *  - SP owner (auth.businessId === id): can edit own profile fields
 *           (phone, businessDescription, alaskaLicenseNumber, yearsInBusiness, ownerName).
 *           Status changes by SP are silently dropped.
 */
router.patch("/biz-accounts/:id", requireUser, async (req, res) => {
  const { id } = UpdateBizAccountParams.parse(req.params);
  const body = UpdateBizAccountBody.parse(req.body);
  const auth = req.auth!;

  const [existing] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Biz account not found" });
    return;
  }

  const isAdmin = auth.role === "admin";
  const isOwner = auth.role === "business" && auth.businessId === id;
  if (!isAdmin && !isOwner) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const patch: Record<string, unknown> = {};

  // Admin status mutations are deliberately limited here. Approving an
  // application MUST go through `POST /biz-accounts/:id/approve` so the
  // public `businesses` row gets created and the Stripe payment is
  // re-verified. Allowing `status: "approved"` via PATCH would let an admin
  // mark someone "approved" without ever inserting the business row,
  // leaving the SP unable to log in (login gates on a real businesses
  // row). Rejection should also flow through `POST /biz-accounts/:id/reject`
  // so the audit fields (`rejectedAt`, `rejectedReason`) get populated.
  if (isAdmin && body.status !== undefined && body.status !== null) {
    if (body.status === "approved" || body.status === "rejected") {
      res.status(400).json({
        error: `Use POST /biz-accounts/:id/${body.status === "approved" ? "approve" : "reject"} to transition to "${body.status}".`,
      });
      return;
    }
    patch.status = body.status;
  }

  // Admin-only: meeting location (address/notes) and duration. These feed the
  // .ics LOCATION and DTEND. Only meaningful alongside a meeting; changing
  // them on an existing meeting counts as a revision (sequence bump + email).
  if (isAdmin && body.meetingLocation !== undefined && body.meetingLocation !== null) {
    patch.meetingLocation = body.meetingLocation.trim();
  }
  if (isAdmin && body.meetingDurationMinutes !== undefined && body.meetingDurationMinutes !== null) {
    patch.meetingDurationMinutes = body.meetingDurationMinutes;
  }

  // Admin-only: schedule / reschedule / clear the in-person meeting.
  // Zod coerces the ISO string to a Date; an explicit null clears the meeting.
  if (isAdmin && body.meetingAt !== undefined) {
    patch.meetingAt = body.meetingAt; // Date | null (validated by UpdateBizAccountBody)
    // Clearing the meeting also resets its location/duration so the next
    // schedule starts fresh (the CANCEL email below still uses the OLD values
    // captured in `existing`).
    if (body.meetingAt === null) {
      patch.meetingLocation = "";
      patch.meetingDurationMinutes = 60;
    }
    // Bump the iCal SEQUENCE whenever the meeting actually changes so the
    // .ics invite we email updates the SAME calendar event (stable UID)
    // instead of creating a duplicate. First schedule keeps sequence 0.
    const willChange =
      (body.meetingAt === null) !== (existing.meetingAt === null) ||
      (body.meetingAt !== null &&
        existing.meetingAt !== null &&
        body.meetingAt.getTime() !== existing.meetingAt.getTime());
    // Bump on EVERY revision after the very first schedule — including
    // re-scheduling after a cancel (null → non-null with sequence > 0).
    // Reusing the CANCEL's sequence for a new REQUEST would leave clients
    // thinking the event is still cancelled.
    // The increment is done SQL-side (col + 1) rather than from the value we
    // read above, so two concurrent admin PATCHes can never both write the
    // same sequence number. The email below uses the sequence RETURNING'd by
    // the atomic UPDATE.
    const isFirstEverSchedule = existing.meetingAt === null && existing.meetingIcalSequence === 0;
    if (willChange && !isFirstEverSchedule) {
      patch.meetingIcalSequence = sql`${bizAccountsTable.meetingIcalSequence} + 1`;
    }
  }

  // Location/duration edits on an EXISTING meeting whose time isn't changing
  // in this PATCH still revise the invite: bump the SEQUENCE and email an
  // updated .ics below. (When the meeting is being set/cleared in this PATCH,
  // the block above already handles the bump.)
  const meetingDetailsRevised =
    isAdmin &&
    body.meetingAt === undefined &&
    existing.meetingAt !== null &&
    ((patch.meetingLocation !== undefined && patch.meetingLocation !== existing.meetingLocation) ||
      (patch.meetingDurationMinutes !== undefined &&
        patch.meetingDurationMinutes !== existing.meetingDurationMinutes));
  if (meetingDetailsRevised) {
    patch.meetingIcalSequence = sql`${bizAccountsTable.meetingIcalSequence} + 1`;
  }

  // Owner-editable fields. Admins can also edit these.
  if (body.phone !== undefined && body.phone !== null) patch.phone = body.phone;
  if (body.businessDescription !== undefined && body.businessDescription !== null) {
    patch.businessDescription = body.businessDescription;
  }
  if (body.alaskaLicenseNumber !== undefined && body.alaskaLicenseNumber !== null) {
    patch.alaskaLicenseNumber = body.alaskaLicenseNumber;
  }
  if (body.yearsInBusiness !== undefined && body.yearsInBusiness !== null) {
    patch.yearsInBusiness = body.yearsInBusiness;
  }
  if (body.ownerName !== undefined && body.ownerName !== null) patch.ownerName = body.ownerName;

  if (Object.keys(patch).length === 0) {
    res.json(publicBizAccount(existing));
    return;
  }

  const [updated] = await db
    .update(bizAccountsTable)
    .set(patch)
    .where(eq(bizAccountsTable.id, id))
    .returning();

  req.log.info(
    { bizAccountId: id, role: auth.role, fields: Object.keys(patch) },
    "bizAccount.updated",
  );

  // Send the provider an email whenever the admin sets, changes, or clears
  // the meeting time. We detect the change by checking whether `meetingAt`
  // was part of the patch and whether the new value differs from the old one.
  if (isAdmin && ("meetingAt" in patch || meetingDetailsRevised)) {
    const newMeetingAt = updated.meetingAt ?? null;
    const oldMeetingAt = existing.meetingAt ?? null;
    const changed =
      meetingDetailsRevised ||
      (newMeetingAt === null) !== (oldMeetingAt === null) ||
      (newMeetingAt !== null &&
        oldMeetingAt !== null &&
        newMeetingAt.getTime() !== oldMeetingAt.getTime());

    if (changed) {
      let kind: "scheduled" | "rescheduled" | "cancelled";
      if (newMeetingAt === null) {
        kind = "cancelled";
      } else if (oldMeetingAt === null) {
        kind = "scheduled";
      } else {
        kind = "rescheduled";
      }

      // For cancellations, `meetingAt` carries the OLD meeting time so the
      // METHOD:CANCEL .ics can reference the event being removed.
      void sendMeetingEmail(
        {
          toEmail: updated.email,
          ownerName: updated.ownerName,
          businessName: updated.businessName,
          kind,
          meetingAt: kind === "cancelled" ? oldMeetingAt : newMeetingAt,
          bizAccountId: updated.id,
          icalSequence: updated.meetingIcalSequence,
          // CANCEL invites reference the OLD meeting's details.
          meetingLocation:
            kind === "cancelled" ? existing.meetingLocation : updated.meetingLocation,
          meetingDurationMinutes:
            kind === "cancelled"
              ? existing.meetingDurationMinutes
              : updated.meetingDurationMinutes,
        },
        req.log,
      );
    }
  }

  res.json(publicBizAccount(updated));
});

/**
 * POST /biz-accounts/:id/approve — admin approves a paid application.
 *
 * Guards (in order):
 *  1. Application exists.
 *  2. Application status is `pending` (paid, awaiting review). Approving an
 *     `awaiting_payment` row would let an admin bypass the fee; approving an
 *     already-approved or rejected row is meaningless.
 *  3. Defense-in-depth: re-fetch the Stripe Checkout Session and verify
 *     `payment_status === 'paid'`. The webhook is already gated on this but
 *     we don't trust the DB blindly — a webhook could be replayed/spoofed
 *     before signature verification was hardened, etc.
 *
 * On success, in a single transaction:
 *   - Insert the public `businesses` row (default category = "handyman" unless
 *     the admin overrides). The biz_account already has `ownerId` linking to
 *     the right `users` row from POST /biz-accounts.
 *   - Flip `biz_accounts.status` → `approved`.
 *
 * Returns `{ bizAccount, business }`.
 */
router.post("/biz-accounts/:id/approve", requireRole("admin"), async (req, res) => {
  const { id } = ApproveBizAccountParams.parse(req.params);
  const body = ApproveBizAccountBody.parse(req.body ?? {});

  const result = await finalizeBizAccountOnboarding(id, { categoryId: body.categoryId ?? undefined });
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: "Application not found" });
    } else if (result.reason === "missing_owner") {
      res.status(500).json({ error: "Application is missing owner; contact support" });
    } else if (result.reason === "wrong_status") {
      res.status(409).json({
        error: "Cannot approve — only accepted applications (post-interview) can be approved.",
      });
    } else {
      res.status(409).json({
        error:
          "Application is no longer accepted — it may have just been approved by another admin or by the onboarding payment.",
      });
    }
    return;
  }

  req.log.info(
    { bizAccountId: id, businessId: result.business.id, ownerId: result.bizAccount.ownerId },
    "bizAccount.approved",
  );
  recordAudit(req, {
    entityType: "biz_account",
    entityId: id,
    action: "approve",
    summary: `Approved application "${result.bizAccount.businessName}" (admin override)`,
    metadata: { businessId: result.business.id, ownerId: result.bizAccount.ownerId },
  });
  // Notify the provider that their application was approved. Fire-and-forget:
  // a failed email must not break the approve response; the outbox retries.
  void sendMeetingEmail(
    {
      toEmail: result.bizAccount.email,
      ownerName: result.bizAccount.ownerName,
      businessName: result.bizAccount.businessName,
      kind: "approved",
      meetingAt: null,
    },
    req.log,
  );
  res.json({
    bizAccount: publicBizAccount(result.bizAccount),
    business: result.business,
  });
});

/**
 * POST /biz-accounts/:id/accept — admin accepts a paid (pending) application
 * after the offline interview. Moves it to `accepted` so the applicant can pay
 * the $60 onboarding fee, which (via webhook) finalizes approval + creates the
 * public business row.
 */
router.post("/biz-accounts/:id/accept", requireRole("admin"), async (req, res) => {
  const { id } = AcceptBizAccountParams.parse(req.params);
  const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  if (!acct) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  if (acct.status !== "pending") {
    res.status(409).json({
      error: `Cannot accept application in status "${acct.status}" — only paid (pending) applications can be accepted.`,
    });
    return;
  }
  const [updated] = await db
    .update(bizAccountsTable)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(and(eq(bizAccountsTable.id, id), eq(bizAccountsTable.status, "pending")))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "Application is no longer pending." });
    return;
  }
  req.log.info({ bizAccountId: id }, "bizAccount.accepted");
  recordAudit(req, {
    entityType: "biz_account",
    entityId: id,
    action: "accept",
    summary: `Accepted application "${acct.businessName}" — awaiting onboarding payment`,
  });
  // Notify the provider that they were accepted (login + onboarding-fee next
  // steps). Fire-and-forget: a failed email must not break the accept.
  void sendMeetingEmail(
    {
      toEmail: updated.email,
      ownerName: updated.ownerName,
      businessName: updated.businessName,
      kind: "accepted",
      meetingAt: null,
    },
    req.log,
  );
  res.json(publicBizAccount(updated));
});

/**
 * POST /biz-accounts/:id/onboarding-checkout — public (the `ba_…` id is a
 * capability token; applicants can't log in until approved). Creates a Stripe
 * Checkout Session for the configured onboarding fee. On completion the webhook
 * finalizes approval and creates the public business row.
 */
router.post("/biz-accounts/:id/onboarding-checkout", async (req, res) => {
  const { id } = CreateOnboardingCheckoutParams.parse(req.params);
  const body = CreateOnboardingCheckoutBody.refine(
    value => value?.expectedOnboardingFeeCents === undefined ||
      Number.isSafeInteger(value.expectedOnboardingFeeCents),
    { message: "Expected onboarding fee must be an integer number of cents." },
  ).parse(req.body ?? {}) ?? {};
  // Check the reviewed offer before any Stripe call or application update.
  // The field stays optional for clients released before price confirmation.
  if (body.expectedOnboardingFeeCents !== undefined &&
      body.expectedOnboardingFeeCents !== ONBOARDING_FEE_CENTS) {
    res.status(409).json({ error: "The onboarding fee has changed. Review the updated fee before trying again." });
    return;
  }
  try {
    // Serialize checkout requests across processes until the session id commits.
    // Use a dedicated lock, not a row lock: webhooks/admins must still be able
    // to record a payment or revoke acceptance while Stripe is responding.
    const result = await db.transaction(async tx => {
      // Transaction-local: no leaked settings on pooled connections, and
      // simultaneous requests cannot wait indefinitely behind a slow provider.
      await tx.execute(sql`SELECT set_config('lock_timeout', ${`${ONBOARDING_LOCK_WAIT_MS}ms`}, true)`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding-checkout:${id}`}, 0))`);
      const [acct] = await tx.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
      if (!acct) {
        return { status: 404, body: { error: "Application not found" } };
      }
      if (acct.status !== "accepted") {
        return {
          status: 409,
          body: { error: `Onboarding payment is only available once your application is accepted (current status: "${acct.status}").` },
        };
      }
      if (acct.onboardingPaidAt) {
        return { status: 409, body: { error: "Onboarding payment has already been received. Please contact support for activation; do not pay again." } };
      }

      const budget = onboardingCheckoutBudget(ONBOARDING_NETWORK_BUDGET_MS);
      const stripe = await budget.read(() =>
        getUncachableStripeClient({ disableConnectionRetries: true }),
      );
      if (acct.onboardingSessionId) {
        const previous = await stripe.checkout.sessions.retrieve(
          acct.onboardingSessionId, {}, budget.requestOptions(),
        );
        // Never reuse another application's session or create a second payable
        // session while a completed/paid one is waiting for its webhook.
        if (previous.metadata?.bizAccountId !== id || previous.metadata?.feeType !== "onboarding") {
          throw new Error("Stored onboarding checkout does not belong to this application");
        }
        if (previous.status === "complete" || previous.payment_status !== "unpaid") {
          return { status: 409, body: { error: "Onboarding payment is already being processed. Refresh your application status; do not pay again." } };
        }
        if (previous.status === "open") {
          if (previous.amount_total === ONBOARDING_FEE_CENTS && previous.currency === "usd" && previous.url) {
            const [current] = await tx.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
            if (current.status !== "accepted" || current.onboardingPaidAt) {
              return { status: 409, body: { error: "Onboarding payment is no longer available. Refresh your application status before continuing." } };
            }
            return { status: 200, body: { checkoutUrl: previous.url } };
          }
          // A changed offer must not leave the old checkout payable as well.
          await stripe.checkout.sessions.expire(previous.id, {}, budget.requestOptions());
        } else if (previous.status !== "expired") {
          throw new Error("Stored onboarding checkout has an unknown status");
        }
      }
      const { successUrl, cancelUrl } = buildReturnUrls(id, "onboarding");
      const lineItem = await resolveFeeLineItem(
        stripe,
        "onboarding",
        ONBOARDING_FEE_CENTS,
        "AK On Demand – Service Provider Onboarding Fee",
        "One-time onboarding fee to activate your verified service provider account on the AK On Demand marketplace.",
        budget.requestOptions(),
      );
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [lineItem],
        customer_email: acct.email,
        metadata: { bizAccountId: id, applicantName: acct.ownerName, feeType: "onboarding" },
        payment_intent_data: {
          metadata: { bizAccountId: id, applicantName: acct.ownerName, feeType: "onboarding" },
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      }, {
        ...budget.requestOptions(),
        // Recover the same attempt if Stripe succeeds but saving the id fails.
        // An expired predecessor advances the key without a time-based race.
        idempotencyKey: `onboarding:${id}:${acct.onboardingSessionId ?? "initial"}:${ONBOARDING_FEE_CENTS}`,
      });
      if (!session.url) throw new Error("Stripe did not return a checkout URL");
      const [saved] = await tx.update(bizAccountsTable)
        .set({ onboardingSessionId: session.id })
        .where(and(
          eq(bizAccountsTable.id, id),
          eq(bizAccountsTable.status, "accepted"),
          isNull(bizAccountsTable.onboardingPaidAt),
        ))
        .returning({ id: bizAccountsTable.id });
      if (!saved) {
        return { status: 409, body: { error: "Onboarding payment is no longer available. Refresh your application status before continuing." } };
      }
      return { status: 200, body: { checkoutUrl: session.url } };
    });
    // Do not expose the checkout until the transaction has committed.
    res.status(result.status).json(result.body);
  } catch (err) {
    if (isOnboardingCheckoutUnavailable(err)) {
      req.log.warn({ bizAccountId: id }, "bizAccount.onboarding_checkout_temporarily_unavailable");
      res.set("Retry-After", "2").status(503).json({
        error: "Payment is taking longer than expected. Wait a moment, then try again; the same checkout attempt will be reused.",
      });
      return;
    }
    req.log.error({ err, bizAccountId: id }, "bizAccount.onboarding_checkout_failed");
    res.status(502).json({ error: "Could not start onboarding payment. Please try again in a moment." });
    return;
  }
});

/**
 * POST /biz-accounts/:id/reject — admin rejects an application.
 *
 * Per project policy the $19 application fee is non-refundable, so this is a
 * pure status transition with optional reason text. Allowed from `pending`
 * (post-payment, pre-interview) or `accepted` (post-interview, pre-onboarding).
 */
router.post("/biz-accounts/:id/reject", requireRole("admin"), async (req, res) => {
  const { id } = RejectBizAccountParams.parse(req.params);
  const body = RejectBizAccountBody.parse(req.body ?? {});

  const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
  if (!acct) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  // Architect feedback: only allow reject from `pending` (paid, awaiting
  // review). Rejecting an `awaiting_payment` row would mean rejecting a
  // never-paid applicant, which the spec frames as out-of-scope (the row
  // will TTL-expire on its own, or admin can clean up via PATCH). Rejecting
  // an already-rejected row is a no-op and approving-then-rejecting is
  // explicitly disallowed.
  if (acct.status !== "pending" && acct.status !== "accepted") {
    res.status(409).json({
      error: `Cannot reject application in status "${acct.status}" — only pending or accepted applications can be rejected.`,
    });
    return;
  }

  const [updated] = await db
    .update(bizAccountsTable)
    .set({
      status: "rejected",
      rejectedAt: new Date(),
      rejectedReason: body.reason ?? null,
    })
    .where(eq(bizAccountsTable.id, id))
    .returning();

  req.log.info({ bizAccountId: id, reason: body.reason ?? null }, "bizAccount.rejected");
  recordAudit(req, {
    entityType: "biz_account",
    entityId: id,
    action: "reject",
    summary: `Rejected application "${acct.businessName}"`,
    metadata: { reason: body.reason ?? null },
  });
  // Notify the provider that their application was rejected (with the
  // optional reason). Fire-and-forget: a failed email must not break the
  // reject response; the outbox retries.
  void sendMeetingEmail(
    {
      toEmail: updated.email,
      ownerName: updated.ownerName,
      businessName: updated.businessName,
      kind: "rejected",
      meetingAt: null,
      rejectedReason: body.reason ?? null,
    },
    req.log,
  );
  res.json(publicBizAccount(updated));
});

export default router;
