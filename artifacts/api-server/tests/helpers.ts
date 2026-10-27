/**
 * TD-4 — shared test helpers: supertest agent, JWT minting, data factories,
 * cleanup. Every piece of test data is prefixed with `TEST_PREFIX` so the
 * `afterAll` cleanup can delete by prefix without touching real rows.
 */

import { sql, eq, like } from "drizzle-orm";
import {
  db,
  usersTable,
  businessesTable,
  categoriesTable,
  stripeWebhookDeadLetterTable,
} from "@workspace/db";
import { signToken, type AuthRole } from "../src/lib/auth";
import app from "../src/app";
import supertest from "supertest";

/** Stable per-process prefix. Random bit gives parallel CI runs unique
 * namespaces if we ever lift the singleFork constraint. */
export const TEST_PREFIX = `e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const api = (): supertest.Agent => supertest(app);

export function mintToken(args: {
  userId: string;
  role: AuthRole;
  businessId?: string;
  tv?: number;
}): string {
  // Fail-fast: admin tokens MUST embed `tv` matching `users.tokenVersion`.
  // Without this guard a future test could mint an admin token, get a silent
  // 401 from `requireRole("admin")`, and pass an `expect(403)` assertion for
  // entirely the wrong reason — masking real authz regressions.
  if (args.role === "admin" && typeof args.tv !== "number") {
    throw new Error(
      "mintToken: admin tokens require an explicit `tv` claim matching users.tokenVersion. Use createAdminUser() instead.",
    );
  }
  return signToken(args);
}

export interface TestUser {
  id: string;
  email: string;
  role: AuthRole;
  token: string;
  businessId?: string;
}

export async function createCustomerUser(): Promise<TestUser> {
  const id = `${TEST_PREFIX}_cust_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@test.local`;
  await db.insert(usersTable).values({
    id,
    email,
    name: "Test Customer",
    role: "customer",
  });
  return { id, email, role: "customer", token: mintToken({ userId: id, role: "customer" }) };
}

export async function createAdminUser(): Promise<TestUser> {
  const id = `${TEST_PREFIX}_adm_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@test.local`;
  // tokenVersion: 0 — admin token check (`tv === row.tokenVersion`) requires
  // the embedded claim to match the row, see middlewares/auth.ts.
  await db.insert(usersTable).values({
    id,
    email,
    name: "Test Admin",
    role: "admin",
    tokenVersion: 0,
  });
  // Admin tokens MUST embed `tv` matching `users.tokenVersion` — middleware
  // rejects with 401 otherwise (see `isAdminTokenCurrent`).
  return {
    id,
    email,
    role: "admin",
    token: mintToken({ userId: id, role: "admin", tv: 0 }),
  };
}

/**
 * Lazily fetch any existing category from the live `categories` table. Tests
 * need a valid FK target for `businesses.category_id`; we re-use whatever the
 * workflow already seeded rather than inserting a synthetic test category
 * (categories don't have a created_by field we could prefix-clean).
 */
export async function getAnyCategoryId(): Promise<string> {
  const [row] = await db.select({ id: categoriesTable.id }).from(categoriesTable).limit(1);
  if (!row) {
    throw new Error(
      "No categories present — start the api-server workflow once to seed at least one category, or seed manually.",
    );
  }
  return row.id;
}

export async function createBusinessForOwner(args: {
  ownerId: string;
  subscriptionActive: boolean;
  subscriptionPlan?: "basic" | "pro" | "premium";
}): Promise<{ id: string }> {
  const id = `${TEST_PREFIX}_biz_${Math.random().toString(36).slice(2, 8)}`;
  const categoryId = await getAnyCategoryId();
  await db.insert(businessesTable).values({
    id,
    ownerId: args.ownerId,
    name: `${TEST_PREFIX} Test Business`,
    description: "",
    categoryId,
    subscriptionActive: args.subscriptionActive,
    subscriptionPlan: args.subscriptionPlan ?? "basic",
    joinedDate: new Date().toISOString().slice(0, 10),
  });
  return { id };
}

/**
 * Best-effort cleanup. We delete in FK-respecting order: child rows first,
 * then businesses (FK → users), then users.
 *
 * Cross-run safety: stragglers from aborted runs are cleaned ONLY when older
 * than 1 day. The previous version unconditionally deleted any `e2e_%` row
 * outside the current prefix, which would race a parallel CI worker that
 * happened to be mid-run. Age-gating every table (not just dead-letter)
 * removes that hazard at the cost of a short retention window.
 *
 * Tables touched by tests should either (a) use TEST_PREFIX-style ids and
 * be added to this list, or (b) have an `ON DELETE CASCADE` parent in this
 * list (e.g. messages/booking_reviews → bookings → services → businesses;
 * notifications/audit_log → users). We don't currently insert into those
 * tables from tests; revisit when adding bookings/messaging coverage.
 */
export async function cleanupTestData(): Promise<void> {
  // Current-run cleanup (precise, by full prefix match).
  await db
    .delete(stripeWebhookDeadLetterTable)
    .where(like(stripeWebhookDeadLetterTable.id, `${TEST_PREFIX}%`));
  await db.delete(businessesTable).where(like(businessesTable.id, `${TEST_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${TEST_PREFIX}%`));

  // Stragglers from previously-aborted runs — age-gated on EVERY table to
  // avoid racing a parallel test process that's still mid-suite.
  const STRAGGLER_AGE = sql`NOW() - INTERVAL '1 day'`;
  await db.execute(
    sql`DELETE FROM public.stripe_webhook_dead_letter WHERE id LIKE 'e2e_%' AND created_at < ${STRAGGLER_AGE}`,
  );
  await db.execute(
    sql`DELETE FROM public.businesses WHERE id LIKE 'e2e_%' AND id NOT LIKE ${`${TEST_PREFIX}%`} AND joined_date::date < (CURRENT_DATE - INTERVAL '1 day')`,
  );
  await db.execute(
    sql`DELETE FROM public.users WHERE id LIKE 'e2e_%' AND id NOT LIKE ${`${TEST_PREFIX}%`} AND created_at < ${STRAGGLER_AGE}`,
  );
}

export async function fetchUser(id: string) {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  return row;
}
