import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";

/**
 * Per-booking chat thread between the customer and the SP. A message is
 * authored by either side (`senderRole`); `readAt` is stamped when the OTHER
 * party opens the thread (so each message is "delivered" until the recipient
 * sees it). We never edit/delete messages — append-only.
 */
export const messagesTable = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    // Cascade: deleting a booking row removes its thread (we never delete
    // bookings in normal operation, this just keeps FK semantics clean).
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    // The user.id of the author. We don't FK-link this — bookings.customerId
    // is also unconstrained (legacy), so keeping it consistent.
    senderUserId: text("sender_user_id").notNull(),
    // Which side of the booking sent this. Used both for authz checks and to
    // render bubbles on the right vs left side.
    senderRole: text("sender_role", { enum: ["customer", "business"] }).notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBookingCreated: index("messages_booking_created_idx").on(t.bookingId, t.createdAt),
  }),
);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
