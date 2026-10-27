import { pgTable, text, integer, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { servicesTable } from "./services";
import { businessesTable } from "./businesses";

export const bookingsTable = pgTable("bookings", {
  id: text("id").primaryKey(),
  // customerId references users.id but no FK yet — see businesses.ts note.
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  serviceId: text("service_id").notNull().references(() => servicesTable.id, { onDelete: "restrict" }),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "restrict" }),
  // Denormalised snapshots — preserve booking history even if the underlying
  // service/business is later renamed or deleted.
  businessName: text("business_name").notNull(),
  serviceTitle: text("service_title").notNull(),
  optionName: text("option_name").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  platformFee: numeric("platform_fee", { precision: 10, scale: 2 }).notNull(),
  total: numeric("total", { precision: 10, scale: 2 }).notNull(),
  status: text("status", { enum: ["pending", "confirmed", "completed", "cancelled"] }).notNull().default("pending"),
  scheduledDate: text("scheduled_date").notNull(), // YYYY-MM-DD
  scheduledTime: text("scheduled_time"),           // HH:MM (24h)
  durationMinutes: integer("duration_minutes"),
  // Stripe Connect (Phase 2 #6): the PaymentIntent that funded this booking
  // (destination charge to the SP's Connect account). Set when the booking
  // was created via POST /bookings/payment-intent. Legacy/free bookings have
  // null here. The webhook payment_intent.succeeded/payment_failed/refunded
  // events look up the booking via this id.
  paymentIntentId: text("payment_intent_id"),
  // Refund tracking — set when admin/SP refunds the booking via
  // POST /bookings/:id/refund. Stripe `re_…` id; null if never refunded.
  refundId: text("refund_id"),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  // Phase 3 #2 — Customer-initiated refund REQUEST. Set by
  // POST /bookings/:id/refund-request. Distinct from `refundId`/`refundedAt`,
  // which only get set after an admin actually approves+executes the refund
  // (or an SP/admin proactively refunded without a customer request).
  // A request is "pending" iff `refundRequestedAt` is set AND `refundDecision`
  // is null. Customers can only have one outstanding request per booking.
  refundRequestedAt: timestamp("refund_requested_at", { withTimezone: true }),
  refundReason: text("refund_reason"),
  // Admin's decision on the request. Approval triggers the same refund path
  // as the proactive route; denial just stamps the decision fields and pings
  // the customer with `refundDecisionReason` as the explanation.
  refundDecision: text("refund_decision", { enum: ["approved", "denied"] }),
  refundDecidedAt: timestamp("refund_decided_at", { withTimezone: true }),
  refundDecisionReason: text("refund_decision_reason"),
  // Phase 3 #2 — Stripe dispute tracking. Populated by `charge.dispute.*`
  // webhooks. We don't auto-refund on dispute (Stripe moves the funds itself
  // via the dispute mechanism); we just surface the state to admins/SPs so
  // they can respond before the deadline.
  disputeId: text("dispute_id"),
  // Stripe's dispute.status is a free-form enum that may grow; store as text.
  // Common values: warning_needs_response, warning_under_review, warning_closed,
  // needs_response, under_review, charge_refunded, won, lost.
  disputeStatus: text("dispute_status"),
  disputeCreatedAt: timestamp("dispute_created_at", { withTimezone: true }),
  // Phase 3 #7 — Snapshot of the business's cancellation policy at booking
  // creation time. Customer-cancel refund logic uses these values, NOT the
  // business's current policy, so SP edits don't retroactively change
  // refund amounts on existing bookings. Nullable for legacy rows created
  // before this column existed — fallback in code reads the live policy.
  cancellationFullRefundHours: integer("cancellation_full_refund_hours"),
  cancellationPartialRefundHours: integer("cancellation_partial_refund_hours"),
  cancellationPartialRefundPercent: integer("cancellation_partial_refund_percent"),
  // Stamped when a customer cancellation triggers a partial/full refund.
  // Distinct from refundedAt (set by executeRefund) — this records the
  // amount Stripe actually refunded so the UI can show "$X refunded" pills
  // without a Stripe round-trip. In integer cents.
  cancellationRefundCents: integer("cancellation_refund_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byBusinessDate: index("bookings_business_date_idx").on(t.businessId, t.scheduledDate),
  byCustomer: index("bookings_customer_idx").on(t.customerId),
  byPaymentIntent: index("bookings_payment_intent_idx").on(t.paymentIntentId),
}));

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({ createdAt: true });
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
