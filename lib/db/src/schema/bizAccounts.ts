import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const bizAccountsTable = pgTable("biz_accounts", {
  id: text("id").primaryKey(),
  businessName: text("business_name").notNull(),
  ownerName: text("owner_name").notNull(),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  businessType: text("business_type", { enum: ["brick-and-mortar", "home-based"] }).notNull(),
  yearsInBusiness: text("years_in_business").notNull().default(""),
  alaskaLicenseNumber: text("alaska_license_number").notNull().default(""),
  businessDescription: text("business_description").notNull().default(""),
  // Application lifecycle (two-stage paid funnel):
  //   awaiting_payment → applicant must pay the $19 application fee.
  //   pending          → $19 paid; awaiting interview + admin decision.
  //   accepted         → admin accepted after interview; applicant must now
  //                      pay the $60 onboarding fee to go live.
  //   approved         → $60 onboarding paid; public `businesses` row created.
  //   rejected         → admin declined. Both fees are non-refundable.
  status: text("status", {
    enum: ["awaiting_payment", "pending", "accepted", "approved", "rejected"],
  }).notNull().default("awaiting_payment"),
  // Forgot-password flow: sha256 of the single-use reset token emailed to the
  // SP, plus its expiry. Both cleared once the reset succeeds.
  passwordResetTokenHash: text("password_reset_token_hash"),
  passwordResetExpiresAt: timestamp("password_reset_expires_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Stripe Checkout session for the $19 application fee. `paidAt` is set when
  // the webhook confirms it (status awaiting_payment → pending). Once paid,
  // this ID and receipt identify the FIRST payment and must not be replaced by
  // another successful checkout. Extra charges go to admin recovery for review.
  stripeSessionId: text("stripe_session_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  applicationPaidAmountCents: integer("application_paid_amount_cents"),
  applicationPaidCurrency: text("application_paid_currency"),
  ownerId: text("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  // Interview / acceptance: set by the admin accept endpoint (pending → accepted).
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // Stripe Checkout session for the $60 onboarding fee. `onboardingPaidAt` is
  // set when the webhook confirms it (status accepted → approved + business row).
  onboardingSessionId: text("onboarding_session_id"),
  // As with the application receipt, preserve the first confirmed session even
  // if activation fails. Separate payments must be reviewed, not substituted.
  onboardingPaidAt: timestamp("onboarding_paid_at", { withTimezone: true }),
  onboardingPaidAmountCents: integer("onboarding_paid_amount_cents"),
  onboardingPaidCurrency: text("onboarding_paid_currency"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedReason: text("rejected_reason"),
  // In-person meeting scheduled by the admin after accepting the application
  // (set from the admin calendar screen).
  meetingAt: timestamp("meeting_at", { withTimezone: true }),
  // iCalendar SEQUENCE for the meeting invite (RFC 5545). Bumped every time
  // the meeting is rescheduled or cancelled so calendar clients treat the new
  // .ics as an update to the SAME event (stable UID per biz account) rather
  // than a duplicate.
  meetingIcalSequence: integer("meeting_ical_sequence").notNull().default(0),
  // Where the in-person meeting takes place (address or notes) — goes into the
  // .ics LOCATION and the email body. Empty string when not set.
  meetingLocation: text("meeting_location").notNull().default(""),
  // Meeting length in minutes; drives the .ics DTEND. Default 1 hour.
  meetingDurationMinutes: integer("meeting_duration_minutes").notNull().default(60),
});

export const insertBizAccountSchema = createInsertSchema(bizAccountsTable).omit({ appliedAt: true });
export type InsertBizAccount = z.infer<typeof insertBizAccountSchema>;
export type BizAccount = typeof bizAccountsTable.$inferSelect;
