import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { bookingsTable } from "./bookings";

export const NOTIFICATION_KINDS = [
  "booking_created",
  "booking_confirmed",
  "booking_completed",
  "booking_cancelled",
  "booking_payment_failed",
  "booking_refunded",
  // Phase 3 #2 — refund-request lifecycle + Stripe disputes
  "refund_requested",
  "refund_approved",
  "refund_denied",
  "dispute_opened",
  "dispute_closed",
  // Phase 3 #6 — In-app messaging
  "message_received",
] as const;

export const notificationsTable = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    // userId → users.id, cascade so deleting a user wipes their feed.
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // bookingId → bookings.id with SET NULL so we keep the notification
    // history even if the booking row is later deleted.
    bookingId: text("booking_id").references(() => bookingsTable.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserCreated: index("notifications_user_created_idx").on(t.userId, t.createdAt),
  }),
);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({
  createdAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
