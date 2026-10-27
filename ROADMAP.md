# AK On Demand LLC — Roadmap

Local services marketplace for Juneau, AK. Three roles (customer, service provider, admin), $29 Basic / $79 Pro / $149 Premium subscriptions, 8% platform fee on completed transactions, Stripe-backed billing.

This document tracks the high-level workstreams. For detailed task breakdowns of each open plan, see `.local/plans/`.

---

## Phase 1 — Marketplace foundations

The baseline product: real server-of-truth data, real auth, real availability, real subscriptions, real reviews/notifications. All Phase 1 items are shipped.

### ✅ #1 — AsyncStorage → API/Postgres migration
- Drizzle schema for users, businesses, services, options, bookings, blocked-slots, employees, categories
- JWT auth (`SESSION_SECRET`, 30-day TTL) with role-based middleware
- OpenAPI-first contract (`lib/api-spec/openapi.yaml`) → React Query hooks + Zod schemas via Orval
- AppContext rewired to live API; AsyncStorage retained only for token persistence

### ✅ #2 — Server-driven availability & long-duration services
- `/availability` collapses to pinned start times when every option on a service is ≥ 8h
- Mixed services fall back to the standard 30-min grid
- SP "Default start time" chip picker (06–10 AM) for long options
- Capacity math, blocked slots, employee specialties all evaluated server-side

### ✅ #3 — Notifications + Expo push
- `notifications` table drives in-app feed and Expo push delivery
- `NotificationBell` with unread badge in customer-bookings and SP-orders headers
- Booking POST notifies SP; PATCH notifies the OTHER party of real status changes (no spam on no-op transitions)
- Expo push token rotated on every login, cleared on logout

### ✅ #4 — Reviews
- 1–5 star rating + optional comment, exactly once per `completed` booking
- `booking_reviews` table (UNIQUE on `bookingId`)
- Transactional aggregate recompute of `services.rating`/`reviewCount` and `businesses.rating`/`reviewCount`
- Per-booking "Leave a review" / "Reviewed" pill on `BookingCard`

### ✅ #5 — SP subscription paywall (just shipped)
- Single-source plan limits in `artifacts/api-server/src/lib/plans.ts` (Basic 3 / Pro 10 / Premium ∞)
- `GET /me/subscription` returns plan, usage, current-period-end, live Stripe billing-portal URL
- `POST /me/subscription/checkout` returns a real Stripe Checkout URL
- `POST /services` 402 gate enforced **inside** the insert transaction with `SELECT … FOR UPDATE` row lock — race-condition verified
- Stripe webhook mirrors `customer.subscription.{created,updated,deleted}` into `businesses.subscriptionPlan` + `subscriptionActive`
- Mobile SP dashboard: plan/usage card with progress bar and contextual CTA
- Add-Service flow catches 402 → "View plans" alert routes to `/business-portal`

---

## Phase 2 — Real money movement

Subscriptions now charge real cards (Phase 1 #5). Phase 2 makes per-booking payments real and finishes the SP onboarding loop.

### ✅ #6 — Stripe Connect payouts + 8% fee split
**Plan doc:** `.local/plans/01-stripe-connect-payouts.md`
**Status:** Shipped. End-to-end smoke verified against real Stripe (test mode): account creation mints a real `acct_…`, onboarding-link returns a real Stripe-hosted URL, the provider-payable gate returns 409 for un-onboarded SPs. Full PaymentSheet → capture loop requires a real onboarded Connect sub-account (manual UAT step in Stripe).

- SP onboarding endpoints under `/me/stripe/connect/{account, onboarding-link}` — auth-gated, idempotent. `GET /me/stripe/connect/account` always re-queries Stripe live so UI doesn't depend on webhook timing.
- `account.updated` webhook mirrors `chargesEnabled`/`payoutsEnabled` into `businesses.stripeAccountStatus` + `stripePayoutsEnabled`.
- `POST /bookings/payment-intent` (customer-only) creates a `pending` booking + a destination-charge PaymentIntent with `transfer_data.destination = SP.stripeAccountId` and `application_fee_amount = Math.round(priceCents * 800 / 10_000)` — server-authoritative, never trusts the client.
- 409 `provider_not_payable` gate on the booking endpoint when SP has no `stripeAccountId` or `stripePayoutsEnabled=false`.
- `@stripe/stripe-react-native` PaymentSheet in `app/checkout.tsx` (StripeProvider wrapper, publishable key fetched from existing `/api/stripe/config`).
- Webhooks: `payment_intent.succeeded` notifies; `payment_intent.payment_failed` / `canceled` delete the draft booking row + send a failure notification.
- `POST /bookings/:id/refund` (admin or owning SP) — full refund with `refund_application_fee: true` + `reverse_transfer: true`, idempotent on re-calls, stamps `refundId`/`refundedAt`, marks booking `cancelled`, notifies customer.
- SP "Payouts" card in `(business-tabs)/account.tsx` with four states (none / pending / active / restricted) and an "Open in Stripe" CTA via `WebBrowser`.
- Mobile `calculateFees` aligned with server's integer-cent math so the displayed total matches Stripe's charge to the penny.
- Two new notification kinds: `booking_payment_failed`, `booking_refunded`.

### ✅ #7 — Admin approval + $79 application fee
**Plan doc:** `.local/plans/02-admin-approval-app-fee.md`
**Status:** Shipped — server is the single source of truth for the application flow end-to-end.

- `POST /biz-accounts` now creates an `awaiting_payment` row + Stripe Checkout Session ($79, mode=payment, `metadata.bizAccountId` injected on both session and `payment_intent_data` for redundancy) and returns `{bizAccount, checkoutUrl}` in one call.
- Webhook `checkout.session.completed` (filtered on `mode='payment'` + `metadata.bizAccountId`) idempotently flips `awaiting_payment → pending` and stamps `paidAt`.
- Public `GET /biz-accounts/:id/status` (no auth — the `ba_…` id is a sufficiently random capability token) lets `payment-return.tsx` poll every 2s up to 30s.
- Admin-gated `POST /biz-accounts/:id/approve` re-verifies Stripe `payment_status='paid'` (defense-in-depth against webhook replay) and, in a single transaction, inserts the public `businesses` row (`ownerId` from biz_account, default category `handyman`, default plan `basic`/active) and flips status → `approved`.
- Admin-gated `POST /biz-accounts/:id/reject` stamps `rejectedAt` + optional `reason`. The $79 fee is non-refundable per project policy.
- `/auth/business/login` already gates `status !== 'approved'`, so the rest of the auth surface required no changes.
- Mobile `login.tsx` calls the modernized `POST /biz-accounts`, persists ONLY the server-issued application id (`akodd_application_id`), and opens the Checkout URL via `WebBrowser.openAuthSessionAsync` for a deterministic dismiss signal. The legacy `akodd_temp_application` AsyncStorage payload is gone.
- Legacy `POST /stripe/application-fee` and `GET /stripe/session-status/:sessionId` carry `@deprecated` JSDoc — kept for one release in case any older mobile build still calls them; will be removed in Phase 3.

**Deferred to Phase 3 onboarding-polish:** first-login profile-setup wizard and `Business.profileComplete` flag. The Account tab already lets newly-approved SPs edit hours/services/employees, so this is a UX nicety rather than a money-flow blocker.

---

## Phase 3 — Hardening & polish

Speculative slate to revisit after Phase 2 ships. Order is suggestion only.

- ✅ **#1 Real admin auth.** Shipped. The `1717` PIN is gone; admins log in with email + bcrypt password (≥ 8 chars), with optional but recommended TOTP 2FA, account lockout (5 fails → 15-min lock with `retryAfterSeconds`), env-driven first-password bootstrap (`ADMIN_BOOTSTRAP_PASSWORD`), self-serve change-password, and full TOTP enroll/confirm/disable flow. See `.local/plans/04-real-admin-auth.md`.
- ✅ **#2 Refunds & disputes UX.** Shipped. Customers request refund with reason via `POST /bookings/:id/refund-request` (gated on payment, no existing dispute, no prior refund/request, valid status); admin queue at `/(admin-tabs)/refunds` with approve/deny + reason. Approval reuses the existing `executeRefund` helper (Stripe refund + reverse_transfer + refund_application_fee). `charge.dispute.{created,updated,closed}` webhook mirrors dispute state to the booking. 5 new notification kinds. See `.local/plans/05-refunds-disputes.md`.
- ✅ **#3 SP availability & vacation mode.** Shipped. SP calendar persists hours/blocks/vacation via real APIs; vacation window short-circuits `/availability` to `slots:[]` + a `vacation` block, and `POST /bookings` returns 409 with the SP's custom message inside the window. Customer screens show OOO banners and disable booking. See `.local/plans/06-availability-vacation.md`.
- ✅ **#4 Search & discovery.** Shipped. Customer search drives off `useListServices(params)` server-side with debounced text query (ILIKE on title/business/tags), price/rating filters, and sort (relevance/rating/price ↑↓). Distance sorting deferred — Juneau is small, no business GPS yet. See `.local/plans/07-search-filters.md`.
- ✅ **#5 SP earnings dashboard.** Shipped. `/me/earnings` returns lifetime + 30-day buckets (gross/fees/refunded/net), live Stripe Connect balance (pending + available), and the 25 most-recent paid bookings. CSV export at `/me/earnings/export.csv` with OWASP injection guard. Refund fee handling: refunded bookings' fees excluded from the `fees` bucket since `refund_application_fee:true` returns the platform's 8% as well.
- ✅ **#6 In-app messaging.** Shipped. Per-booking chat thread between customer and SP, polling every 4s while focused, optimistic send, auto mark-read, push notifications on every send. Server enforces cancelled-booking read-only rule (409 on POST, 200 on GET). Architect-reviewed; three findings fixed before merge.
- ✅ **#7 Cancellation policy enforcement.** Per-business policy (`cancellationFullRefundHours` / `cancellationPartialRefundHours` / `cancellationPartialRefundPercent`) added to `businesses` and snapshotted onto each `bookings` row at creation, with `cancellationRefundCents` capturing the applied refund. Defaults are 24h full / 2h partial / 50%. SP edits the policy in **Account → Cancellation Policy** (validation enforces 0–720h, 0–100%, partial ≤ full); customer sees the policy summary on the service detail and checkout screens. Customer PATCH `status=cancelled` now consults the snapshot policy via `resolvePolicy` (falling back to the live business policy for legacy bookings without snapshot), computes the refund tier with `computeCancellationQuote`, and — when amount > 0 — issues a `Stripe.refunds.create({ payment_intent, amount, reverse_transfer: true, refund_application_fee: true })` partial refund via `stripeService.refundBookingPayment(opts.amountCents)` before flipping status. New `GET /bookings/:id/cancellation-quote` endpoint returns the live `{ tier, refundCents, totalCents, paid, hoursUntilScheduled, policy, eligible, reason }` shape, used by the dedicated `/cancel-booking/[bookingId]` confirmation screen so the customer always sees the live refund amount and policy bullets (with a "NOW" badge on the active tier) before committing. `BookingCard` shows the issued refund dollar amount on the green pill, and a slate "no refund (inside policy window)" pill when `cancellationRefundCents === 0`. Admin/SP cancels are unchanged — they continue to flow through the existing refund-request workflow.
- ✅ **#8 Calendar sync.** Two-way iCal sync. **Outbound:** every SP gets a private feed at `GET /api/ical/sp/:token.ics` (192-bit base64url token in `businesses.icalToken`, regenerable from Account → Calendar Sync to invalidate the old URL). The feed exports the SP's confirmed/completed bookings + manual blocked slots + active vacation window as VEVENTs (RFC 5545, Juneau wall-clock interpreted as AKST = UTC-9; DST drift accepted for v1, no VTIMEZONE block). SPs paste this URL into Google/Apple Calendar's "Add by URL" flow. **Inbound:** SP saves a personal iCal URL via `PUT /me/calendar/external` (https/webcal only) and triggers `POST /me/calendar/external/sync` on demand — fetcher uses node-ical with 5MB cap + 10s timeout, RRULE expansion, TRANSPARENT skip, and replaces all `imported_ical` rows in `blocked_slots` (new `source` enum + `externalUid` columns). Multi-day timed events collapse to all-day blocks. Last-sync timestamp + last-error surfaced in the UI. No background poller — sync is on-demand only. See `.local/plans/09-calendar-sync.md`.
- ✅ **#9 Operational metrics.** Admin home tab is server-driven via `GET /admin/metrics` (`requireRole("admin")`). Single payload returns GMV (lifetime + 30-day, integer cents) and platform-fee earnings, MRR + counts split across the basic/pro/premium tiers, a 4-stage conversion funnel (applications → paid the $79 fee → admin-approved → approved applicants whose owner now runs an active business that has received ≥1 booking — joined via `biz_accounts.ownerId → businesses.ownerId` so the bottom stage stays bounded by the top), an active/inactive subscription split, and the top 5 categories by 30-day GMV with booking counts. Money math handles cancellation refunds correctly: `cancellationRefundCents` is checked before `refundedAt` (customer cancellations stamp both), prorating the platform fee by the kept ratio; admin/SP-initiated full refunds (`refundedAt` only) zero both buckets; cancelled rows with no recorded refund retain full GMV. Mobile dashboard rewritten to drive off `useGetAdminMetrics()` with loading/error/empty states. Architect-reviewed; 5 fixes applied across two passes. See `.local/plans/10-operational-metrics.md`.
- ✅ **#10 Soft-delete & audit trail.** Services/options/businesses now stamp `deleted_at` instead of hard-deleting; every read path filters deleted rows. New `audit_log` table records who changed what (service create/update/delete, option create/update/delete, biz-account approve/reject, booking status changes incl. customer-cancel-with-refund, refund request/approve/deny, refund executed). Admin endpoint `GET /admin/audit-log?entityType=&entityId=&limit=` + new "Audit Log" screen on the admin overview tab.

---

## Cross-cutting tech debt

- ✅ `scripts/src/stripeClient.ts` TS18046 — resolved. The connector response is now narrowed via a `ConnectorResponse` interface + `as ConnectorResponse` cast at the JSON boundary; `pnpm --filter @workspace/scripts run typecheck` passes clean.
- ✅ AsyncStorage cleanup (T009) — verified. The legacy keys map (`akodd_user`, `akodd_bookings`, `akodd_services`, `akodd_businesses`, `akodd_categories`, `akodd_biz_accounts`, `akodd_blocked_slots`) was already removed from `AppContext.tsx` during T008. Only two AsyncStorage keys remain, both legitimate: `akodd_token` (`utils/authStorage.ts`, JWT for session resume) and `akodd_application_id` (`app/login.tsx` + `app/payment-return.tsx`, lets cold-start after the Stripe redirect resolve the original application id when the deep-link query param is missing). Stale "previously cached as AsyncStorage" comments in `AppContext.tsx` cleaned up.
- ✅ E2E test harness (TD-4) — vitest + supertest suite at `artifacts/api-server/tests/` covers healthz, auth, the paywall regression, and the TD-3 dead-letter state machine. 19 tests, in-process (no port binding), prefix-isolated against the shared dev DB. `pnpm test` at root or `pnpm --filter @workspace/api-server run test`. Playwright deferred — `runTest()` skill covers on-demand UI verification.
- Webhook retry + dead-letter logging — Stripe events that fail mirror-to-DB should be visible in an admin queue.

---

## How this doc stays current

- **When a plan ships:** move it from "🔜" to "✅", drop a line in `replit.md` under the relevant section, and (if the plan doc in `.local/plans/` is now fully obsolete) delete it.
- **When a new workstream is approved:** add a numbered entry in the appropriate phase, link a plan doc in `.local/plans/` for the task breakdown.
- **Phase numbering is sequential, not date-bound** — Phase 2 starts whenever the team picks up #6 or #7.
