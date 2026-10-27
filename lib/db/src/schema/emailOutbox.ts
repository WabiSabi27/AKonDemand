import { pgTable, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Task #7 — Persistent outbox for provider notification emails.
 *
 * Every meeting/interview email is inserted here BEFORE the first send
 * attempt. On success the row flips to `sent`; on failure it stays
 * `pending` with `lastError` recorded and `nextAttemptAt` pushed out with
 * exponential backoff. A background worker (see api-server
 * lib/emailOutboxWorker.ts) retries due rows; after MAX attempts the row
 * moves to `failed` where admins can inspect, retry manually, or dismiss.
 */
export const emailOutboxTable = pgTable(
  "email_outbox",
  {
    id: text("id").primaryKey(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text").notNull(),
    /** e.g. "meeting:scheduled" — for admin display/filtering. */
    kind: text("kind").notNull(),
    /** Optional iCalendar payload attached as a calendar invite (.ics).
     *  Persisted so background retries re-send the exact same invite. */
    icalContent: text("ical_content"),
    /** RFC 5546 iTIP method for the invite: "REQUEST" or "CANCEL". */
    icalMethod: text("ical_method"),
    status: text("status", { enum: ["pending", "sent", "failed", "dismissed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    validStatus: check("email_outbox_status_check", sql`${t.status} IN ('pending', 'sent', 'failed', 'dismissed')`),
    // Worker poll: WHERE status='pending' AND next_attempt_at <= NOW()
    byStatusNext: index("email_outbox_status_next_idx").on(t.status, t.nextAttemptAt),
    byCreated: index("email_outbox_created_idx").on(t.createdAt),
  }),
);

export type EmailOutboxRow = typeof emailOutboxTable.$inferSelect;
