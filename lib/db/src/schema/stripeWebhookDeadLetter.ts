import { pgTable, text, integer, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * TD-3 — Stripe webhook dead-letter queue.
 *
 * When a per-event handler in `webhookHandlers.ts` throws (subscription
 * mirror, Connect account mirror, PI succeeded/failed, dispute, biz-account
 * paid), we used to swallow the error after logging — leaving the operator
 * with no path to retry. Now the failed event is persisted here as a row,
 * surfaced in the admin queue, and replayable via `POST
 * /admin/stripe-webhook-dead-letter/:id/retry`.
 *
 * `payload` stores the entire `Stripe.Event` so retry can re-dispatch
 * without needing Stripe to redeliver.
 */
export const stripeWebhookDeadLetterTable = pgTable(
  "stripe_webhook_dead_letter",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    handlerName: text("handler_name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "resolved", "ignored"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error").notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    validStatus: check("stripe_webhook_dead_letter_status_check", sql`${t.status} IN ('pending', 'resolved', 'ignored')`),
    byStatusCreated: index("stripe_dl_status_created_idx").on(t.status, t.createdAt),
    byEvent: index("stripe_dl_event_idx").on(t.eventId),
    // Supports `status=all` admin paging at scale.
    byCreated: index("stripe_dl_created_idx").on(t.createdAt),
  }),
);

export type StripeWebhookDeadLetterRow = typeof stripeWebhookDeadLetterTable.$inferSelect;
