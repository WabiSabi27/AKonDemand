import { pgTable, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stripeWebhookDeadLetterTable } from "./stripeWebhookDeadLetter";

// Append-only manual assertions, not proof of a refund or a queue transition.
// Reviewer identity is snapshotted so account renames/deletion don't erase it.
export const stripePaymentReviewsTable = pgTable("stripe_payment_reviews", {
  id: text("id").primaryKey(),
  deadLetterId: text("dead_letter_id").notNull()
    .references(() => stripeWebhookDeadLetterTable.id, { onDelete: "cascade" }),
  outcome: text("outcome", { enum: ["needs_follow_up", "no_action_needed", "handled_in_stripe"] }).notNull(),
  reviewerId: text("reviewer_id").notNull(),
  reviewerName: text("reviewer_name").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
}, (t) => ({
  byEntry: index("stripe_payment_reviews_entry_idx").on(t.deadLetterId, t.reviewedAt),
  validOutcome: check("stripe_payment_reviews_outcome_check",
    sql`${t.outcome} IN ('needs_follow_up', 'no_action_needed', 'handled_in_stripe')`),
  boundedNote: check("stripe_payment_reviews_note_check", sql`length(${t.note}) <= 500`),
}));
