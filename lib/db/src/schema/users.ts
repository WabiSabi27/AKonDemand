import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["customer", "business", "admin"] }).default("customer"),
  businessId: text("business_id"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // Expo push token, e.g. "ExponentPushToken[xxxxxx]". Set by the mobile app
  // after the user grants notification permission. Cleared on logout.
  pushToken: text("push_token"),
  // Admin-only TOTP 2FA. `totpSecret` is the base32 secret stored once at
  // enrollment; `totpEnrolledAt` is set only after the admin proves ownership
  // by entering a valid first code. Login enforces TOTP iff `totpEnrolledAt`
  // is non-null, so a pending (un-confirmed) enrollment never locks the user
  // out of their account.
  totpSecret: text("totp_secret"),
  totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
  // Admin login throttling. Cleared on every successful login. After 5
  // consecutive failures, `lockedUntil` is set to now + 15 min and the
  // counter is reset.
  failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  // Bumped whenever an admin's password changes. Embedded as `tv` in the admin
  // JWT so previously-issued tokens are rejected after a password change. Only
  // enforced for admin tokens — customer/SP tokens ignore it.
  tokenVersion: integer("token_version").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
