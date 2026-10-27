import { pgTable, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { bookingsTable } from "./bookings";
import { servicesTable } from "./services";
import { businessesTable } from "./businesses";

/**
 * Verified-purchase reviews. One row per completed booking, keyed by
 * `bookingId UNIQUE` so a customer can review a given booking at most once
 * (re-submissions will violate the unique constraint and the route maps that
 * to a 409). Distinct from the legacy `service_reviews` table, which holds
 * seeded demo data without a booking link.
 */
export const bookingReviewsTable = pgTable(
  "booking_reviews",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    customerName: text("customer_name").notNull(),
    serviceId: text("service_id")
      .notNull()
      .references(() => servicesTable.id, { onDelete: "cascade" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businessesTable.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBookingUnique: uniqueIndex("booking_reviews_booking_unique").on(t.bookingId),
    byService: index("booking_reviews_service_idx").on(t.serviceId),
    byBusiness: index("booking_reviews_business_idx").on(t.businessId),
  }),
);

export const insertBookingReviewSchema = createInsertSchema(bookingReviewsTable).omit({
  createdAt: true,
});
export type InsertBookingReview = z.infer<typeof insertBookingReviewSchema>;
export type BookingReview = typeof bookingReviewsTable.$inferSelect;
