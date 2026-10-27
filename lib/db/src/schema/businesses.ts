import { pgTable, text, integer, boolean, numeric, jsonb, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { usersTable } from "./users";

export interface BusinessHours {
  workDays: number[];
  startHour: number;
  endHour: number;
}

export const businessesTable = pgTable("businesses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  categoryId: text("category_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
  logoUrl: text("logo_url"),
  coverUrl: text("cover_url"),
  rating: numeric("rating", { precision: 3, scale: 2 }).notNull().default("0"),
  reviewCount: integer("review_count").notNull().default(0),
  subscriptionActive: boolean("subscription_active").notNull().default(true),
  subscriptionPlan: text("subscription_plan", { enum: ["starter_gigger", "pro_business"] }).notNull().default("starter_gigger"),
  phone: text("phone").notNull().default(""),
  location: text("location").notNull().default(""),
  joinedDate: text("joined_date").notNull(),
  serviceCount: integer("service_count").notNull().default(0),
  hours: jsonb("hours").$type<BusinessHours | null>(),
  // Phase 3 #3 — Vacation mode. SP-set OOO window blocks new bookings and
  // collapses availability for any date in [vacationFrom, vacationUntil]
  // (inclusive). All three are nullable; `vacationMessage` is shown to
  // customers verbatim when present, otherwise a default banner is used.
  vacationFrom: text("vacation_from"),       // YYYY-MM-DD
  vacationUntil: text("vacation_until"),     // YYYY-MM-DD
  vacationMessage: text("vacation_message"),
  // Stripe Connect (Phase 2 #6) — populated when SP onboards via Express to
  // receive payouts. `stripeAccountId` is the `acct_…` id; the three booleans
  // mirror Stripe's `account.charges_enabled`, `account.payouts_enabled`, and
  // a derived high-level status used by the SP UI. All start unset/false so
  // legacy rows behave as "not yet onboarded" (booking PaymentIntents will
  // 409 until onboarding completes).
  stripeAccountId: text("stripe_account_id"),
  stripeAccountStatus: text("stripe_account_status", {
    enum: ["none", "pending", "active", "restricted"],
  }).notNull().default("none"),
  stripeChargesEnabled: boolean("stripe_charges_enabled").notNull().default(false),
  stripePayoutsEnabled: boolean("stripe_payouts_enabled").notNull().default(false),
  // Phase 3 #7 — Cancellation policy. Three tiers, computed against
  // hours-until-scheduled at the moment the customer cancels:
  //   hoursUntil >= cancellationFullRefundHours    → 100% refund
  //   hoursUntil >= cancellationPartialRefundHours → cancellationPartialRefundPercent% refund
  //   else                                         → 0% refund
  // Defaults: 24h / 2h / 50%. Snapshotted onto each booking at creation
  // (see bookings.ts) so policy edits don't retroactively change refund
  // math for in-flight bookings.
  cancellationFullRefundHours: integer("cancellation_full_refund_hours").notNull().default(24),
  cancellationPartialRefundHours: integer("cancellation_partial_refund_hours").notNull().default(2),
  cancellationPartialRefundPercent: integer("cancellation_partial_refund_percent").notNull().default(50),
  // Phase 3 #8 — Calendar sync.
  // `icalToken` is minted on demand (POST /me/calendar/regenerate); the public
  // feed URL embeds it as the only credential, so it must be unguessable
  // (32-char base64url = 192 bits). Regenerating invalidates all old links.
  icalToken: text("ical_token"),
  // External iCal feed the SP wants pulled IN as blocked slots — typically
  // their personal Google/Apple Calendar's "secret address in iCal format".
  // Synced on demand via POST /me/calendar/external/sync (no background poll
  // in the first cut). HTTPS only; validated server-side.
  externalCalendarUrl: text("external_calendar_url"),
  externalCalendarLastSyncAt: timestamp("external_calendar_last_sync_at", { withTimezone: true }),
  externalCalendarLastError: text("external_calendar_last_error"),
  // Phase 3 #10 — soft-delete. No DELETE route exists today, but the column
  // is added for parity so future deactivation/closure flows have a target.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  byIcalToken: uniqueIndex("businesses_ical_token_idx").on(t.icalToken),
}));

export const businessEmployeesTable = pgTable("business_employees", {
  id: serial("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  specialty: text("specialty"),
});

export const insertBusinessSchema = createInsertSchema(businessesTable);
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type Business = typeof businessesTable.$inferSelect;

export const insertBusinessEmployeeSchema = createInsertSchema(businessEmployeesTable).omit({ id: true });
export type InsertBusinessEmployee = z.infer<typeof insertBusinessEmployeeSchema>;
export type BusinessEmployee = typeof businessEmployeesTable.$inferSelect;
