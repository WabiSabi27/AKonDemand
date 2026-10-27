import { runMigrations } from 'stripe-replit-sync';
import { getStripeSync, configureCurrentStripeWebhook } from "./stripeClient";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import app from "./app";
import { logger } from "./lib/logger";
import { cleanupOldOutboxEmails, processDueOutboxEmails } from "./lib/emailOutbox";
import { runStartup, runStartupStep, startOrExit } from "./lib/startup";

async function ensureUsersTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.users (
      id TEXT PRIMARY KEY,
      email TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  logger.info('Users table ready');
}

async function ensureCancellationPolicyColumns() {
  // Phase 3 #7 — additive schema for cancellation policy. Defined in
  // lib/db/src/schema/{businesses,bookings}.ts; mirrored here as
  // ADD-COLUMN-IF-NOT-EXISTS since this repo doesn't run drizzle-kit
  // migrations on boot.
  await db.execute(sql`
    ALTER TABLE public.businesses
      ADD COLUMN IF NOT EXISTS cancellation_full_refund_hours    INTEGER NOT NULL DEFAULT 24,
      ADD COLUMN IF NOT EXISTS cancellation_partial_refund_hours INTEGER NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS cancellation_partial_refund_percent INTEGER NOT NULL DEFAULT 50
  `);
  await db.execute(sql`
    ALTER TABLE public.bookings
      ADD COLUMN IF NOT EXISTS cancellation_full_refund_hours    INTEGER,
      ADD COLUMN IF NOT EXISTS cancellation_partial_refund_hours INTEGER,
      ADD COLUMN IF NOT EXISTS cancellation_partial_refund_percent INTEGER,
      ADD COLUMN IF NOT EXISTS cancellation_refund_cents         INTEGER
  `);
  logger.info('Cancellation policy columns ready');
}

async function ensureSoftDeleteColumns() {
  // Phase 3 #10 — soft-delete columns. Defined in lib/db/src/schema/{services,businesses}.ts.
  await db.execute(sql`
    ALTER TABLE public.services        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.service_options ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.businesses      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  `);
  logger.info('Soft-delete columns ready');
}

async function ensureBizAccountOnboardingColumns() {
  // Two-stage SP funnel — additive schema for the $60 onboarding step. Defined
  // in lib/db/src/schema/bizAccounts.ts; mirrored here as ADD-COLUMN-IF-NOT-EXISTS
  // since this repo doesn't run drizzle-kit migrations on boot. The `status`
  // column is plain TEXT (drizzle-level enum only), so the new lifecycle states
  // need no DDL change.
  await db.execute(sql`
    ALTER TABLE public.biz_accounts
      ADD COLUMN IF NOT EXISTS accepted_at           TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS onboarding_session_id TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_paid_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS application_paid_amount_cents INTEGER,
      ADD COLUMN IF NOT EXISTS application_paid_currency TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_paid_amount_cents INTEGER,
      ADD COLUMN IF NOT EXISTS onboarding_paid_currency TEXT,
      ADD COLUMN IF NOT EXISTS meeting_at            TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS meeting_ical_sequence INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS meeting_location      TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS meeting_duration_minutes INTEGER NOT NULL DEFAULT 60,
      ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT,
      ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ
  `);
  logger.info('Biz-account onboarding columns ready');
}

async function ensureBizAccountTimestamptz() {
  // Task: timezone-proof meeting/lifecycle timestamps. Converts legacy
  // TIMESTAMP (no tz) columns to TIMESTAMPTZ, interpreting existing values as
  // UTC (the server has always run in UTC). Idempotent: only converts columns
  // still typed `timestamp without time zone`. Mirrors { withTimezone: true }
  // in lib/db/src/schema/bizAccounts.ts.
  await db.execute(sql`
    DO $$
    DECLARE col TEXT;
    BEGIN
      FOR col IN
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'biz_accounts'
          AND data_type = 'timestamp without time zone'
          AND column_name IN ('applied_at','expires_at','paid_at','accepted_at',
                              'onboarding_paid_at','rejected_at','meeting_at')
      LOOP
        EXECUTE format(
          'ALTER TABLE public.biz_accounts ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
          col, col
        );
      END LOOP;
    END $$;
  `);
  logger.info('Biz-account timestamptz columns ready');
}

async function ensureAllTimestamptz() {
  // Task: timezone-proof the remaining timestamps app-wide. Same pattern as
  // ensureBizAccountTimestamptz: convert legacy TIMESTAMP (no tz) columns to
  // TIMESTAMPTZ, interpreting existing values as UTC (the server has always
  // run in UTC). Idempotent via the information_schema data_type check.
  // Mirrors { withTimezone: true } in lib/db/src/schema/*.ts.
  await db.execute(sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type = 'timestamp without time zone'
          AND table_name IN ('users','bookings','booking_reviews','messages',
                             'notifications','audit_log','stripe_webhook_dead_letter',
                             'businesses','services','service_options','email_outbox')
      LOOP
        EXECUTE format(
          'ALTER TABLE public.%I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
          r.table_name, r.column_name, r.column_name
        );
      END LOOP;
    END $$;
  `);
  logger.info('App-wide timestamptz columns ready');
}

async function ensureAuditLogTable() {
  // Phase 3 #10 — Cross-entity audit log. Defined in lib/db/src/schema/auditLog.ts;
  // mirrored here as CREATE-IF-NOT-EXISTS since this repo doesn't run drizzle-kit
  // migrations on boot.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.audit_log (
      id            TEXT PRIMARY KEY,
      actor_id      TEXT,
      actor_role    TEXT,
      actor_label   TEXT,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      action        TEXT NOT NULL,
      summary       TEXT NOT NULL DEFAULT '',
      metadata      JSONB,
      at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON public.audit_log (entity_type, entity_id, at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_log_at_idx     ON public.audit_log (at)`);
  logger.info('Audit log table ready');
}

async function ensureMessagesTable() {
  // Phase 3 #6 — Per-booking customer/SP chat thread. Defined in
  // lib/db/src/schema/messages.ts; mirrored here as a CREATE-IF-NOT-EXISTS
  // since this repo doesn't run drizzle-kit migrations on boot.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.messages (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
      sender_user_id TEXT NOT NULL,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'business')),
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS messages_booking_created_idx
    ON public.messages (booking_id, created_at)
  `);
  logger.info('Messages table ready');
}

async function ensureStripeWebhookDeadLetterTable() {
  // TD-3 — Failed Stripe webhook handler runs are persisted here so admins
  // can inspect/retry. Defined in lib/db/src/schema/stripeWebhookDeadLetter.ts;
  // mirrored as CREATE-IF-NOT-EXISTS since this repo doesn't run drizzle-kit.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.stripe_webhook_dead_letter (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      handler_name    TEXT NOT NULL,
      payload         JSONB NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','ignored')),
      attempts        INTEGER NOT NULL DEFAULT 1,
      last_error      TEXT NOT NULL,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stripe_dl_status_created_idx
    ON public.stripe_webhook_dead_letter (status, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stripe_dl_event_idx
    ON public.stripe_webhook_dead_letter (event_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.stripe_payment_reviews (
      id TEXT PRIMARY KEY,
      dead_letter_id TEXT NOT NULL REFERENCES public.stripe_webhook_dead_letter(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CONSTRAINT stripe_payment_reviews_outcome_check
        CHECK (outcome IN ('needs_follow_up', 'no_action_needed', 'handled_in_stripe')),
      reviewer_id TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note TEXT CONSTRAINT stripe_payment_reviews_note_check CHECK (length(note) <= 500)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stripe_payment_reviews_entry_idx
      ON public.stripe_payment_reviews (dead_letter_id, reviewed_at)
  `);
  // Supports the `status=all` admin view at scale: paging by created_at
  // without a status filter would otherwise force a sort over the whole
  // table once the queue grows past a few thousand rows.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stripe_dl_created_idx
    ON public.stripe_webhook_dead_letter (created_at)
  `);
  logger.info('Stripe webhook dead-letter table ready');
}

async function ensureEmailOutboxTable() {
  // Task #7 — Persistent retry queue for provider notification emails.
  // Defined in lib/db/src/schema/emailOutbox.ts; mirrored as
  // CREATE-IF-NOT-EXISTS since this repo doesn't run drizzle-kit on boot.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.email_outbox (
      id              TEXT PRIMARY KEY,
      to_email        TEXT NOT NULL,
      subject         TEXT NOT NULL,
      html            TEXT NOT NULL,
      text            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','failed','dismissed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ical_content    TEXT,
      ical_method     TEXT
    )
  `);
  // Task #10 — .ics calendar-invite columns; additive for pre-existing tables.
  await db.execute(sql`
    ALTER TABLE public.email_outbox
      ADD COLUMN IF NOT EXISTS ical_content TEXT,
      ADD COLUMN IF NOT EXISTS ical_method  TEXT
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS email_outbox_status_next_idx
    ON public.email_outbox (status, next_attempt_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS email_outbox_created_idx
    ON public.email_outbox (created_at)
  `);
  logger.info('Email outbox table ready');
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for Stripe integration.');
  }

    logger.info('Running Stripe migrations...');
    await runStartupStep({
      name: 'stripe-schema',
      run: () => runMigrations({ databaseUrl }),
    }, logger);
    logger.info('Stripe schema ready');

    const stripeSync = await getStripeSync();

    logger.info('Setting up managed webhook...');
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
    const registration = await runStartupStep({
      name: 'stripe-webhook-registration',
      run: () => configureCurrentStripeWebhook(`${webhookBaseUrl}/api/stripe/webhook`),
    }, logger);
    if (registration.status === 'ready') {
      logger.info({ webhookId: registration.webhookId }, 'Webhook configured');
    } else {
      logger.warn({ reason: registration.reason },
        'Preview started without automatic Stripe callbacks. Payment webhook testing requires an explicitly provisioned endpoint. Existing endpoints were not changed.');
    }

    logger.info('Syncing Stripe data...');
    stripeSync.syncBackfill()
      .then(() => logger.info('Stripe data synced'))
      .catch((err: any) => logger.error({ err }, 'Error syncing Stripe data'));

}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await startOrExit(() => runStartup(process.env.NODE_ENV, [
  { name: "users", run: ensureUsersTable },
  { name: "cancellation-policy", run: ensureCancellationPolicyColumns },
  { name: "messages", run: ensureMessagesTable },
  { name: "soft-delete", run: ensureSoftDeleteColumns },
  { name: "provider-onboarding", run: ensureBizAccountOnboardingColumns },
  { name: "provider-timezones", run: ensureBizAccountTimestamptz },
  { name: "audit-log", run: ensureAuditLogTable },
  { name: "stripe-dead-letter", run: ensureStripeWebhookDeadLetterTable },
  { name: "email-outbox", run: ensureEmailOutboxTable },
  { name: "application-timezones", run: ensureAllTimestamptz },
], { name: "stripe-initialization", run: initStripe }, logger), logger, process.exit);

async function listenWithRetry(attempt = 1): Promise<import("http").Server> {
  const MAX_ATTEMPTS = 20;
  const RETRY_DELAY_MS = 500;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const server = app.listen(port);
    server.once("listening", () => {
      if (settled) return;
      settled = true;
      logger.info({ port, attempt }, "Server listening");
      resolve(server);
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "EADDRINUSE" && attempt < MAX_ATTEMPTS) {
        logger.warn(
          { port, attempt, retryInMs: RETRY_DELAY_MS },
          "Port busy, retrying",
        );
        setTimeout(() => {
          listenWithRetry(attempt + 1).then(resolve, reject);
        }, RETRY_DELAY_MS);
      } else {
        logger.error({ err, attempt }, "Error listening on port");
        reject(err);
      }
    });
  });
}

const httpServer = await listenWithRetry();

// Task #7 — background retry loop for the email outbox. Every minute, pick up
// pending emails whose backoff has elapsed and re-attempt delivery. Ticks are
// serialized via the `running` guard; row claiming is atomic in SQL anyway.
const EMAIL_OUTBOX_TICK_MS = 60_000;
let outboxTickRunning = false;
const outboxTimer = setInterval(() => {
  if (outboxTickRunning) return;
  outboxTickRunning = true;
  processDueOutboxEmails(logger)
    .catch((err) => logger.error({ err }, "emailOutbox.tick_failed"))
    .finally(() => {
      outboxTickRunning = false;
    });
}, EMAIL_OUTBOX_TICK_MS);
outboxTimer.unref();

// Task #14 — retention cleanup for the email outbox. Once a day (plus once
// shortly after boot, so short-lived dev servers still clean up), delete
// sent/dismissed rows older than the retention window. Failed rows are kept
// until dismissed. Serialized via its own `running` guard.
const OUTBOX_CLEANUP_TICK_MS = 24 * 60 * 60_000;
let outboxCleanupRunning = false;
function runOutboxCleanup(): void {
  if (outboxCleanupRunning) return;
  outboxCleanupRunning = true;
  cleanupOldOutboxEmails(logger)
    .catch((err) => logger.error({ err }, "emailOutbox.cleanup_failed"))
    .finally(() => {
      outboxCleanupRunning = false;
    });
}
const outboxCleanupTimer = setInterval(runOutboxCleanup, OUTBOX_CLEANUP_TICK_MS);
outboxCleanupTimer.unref();
setTimeout(runOutboxCleanup, 15_000).unref();

function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal, closing server");
  httpServer.close((err) => {
    if (err) {
      logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
    logger.info("Server closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
