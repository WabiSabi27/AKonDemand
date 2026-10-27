import { and, eq } from "drizzle-orm";
import { db, bizAccountsTable, businessesTable, categoriesTable } from "@workspace/db";
import { genId } from "./ids";

export type FinalizeResult =
  | {
      ok: true;
      bizAccount: typeof bizAccountsTable.$inferSelect;
      business: typeof businessesTable.$inferSelect;
    }
  | { ok: false; reason: "not_found" | "wrong_status" | "missing_owner" | "race_lost" };

/**
 * Finalize an accepted SP application: flip `accepted` → `approved` and insert
 * the public `businesses` row in a single race-safe transaction. Shared by the
 * onboarding-payment webhook (the normal path) and the admin approve override.
 *
 * Race-safety: the status flip uses a conditional WHERE (`status = 'accepted'`)
 * so two concurrent finalizes can't both insert a business row — the loser sees
 * 0 updated rows and returns `race_lost`.
 */
export async function finalizeBizAccountOnboarding(
  acctId: string,
  opts?: { categoryId?: string },
): Promise<FinalizeResult> {
  const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, acctId));
  if (!acct) return { ok: false, reason: "not_found" };
  if (acct.status !== "accepted") return { ok: false, reason: "wrong_status" };
  if (!acct.ownerId) return { ok: false, reason: "missing_owner" };

  // Resolve category; default to "handyman" if not supplied or invalid.
  const requestedCategoryId = opts?.categoryId ?? "handyman";
  const [categoryRow] = await db
    .select({ id: categoriesTable.id })
    .from(categoriesTable)
    .where(eq(categoriesTable.id, requestedCategoryId));
  const categoryId = categoryRow?.id ?? "handyman";

  const businessId = genId("b");
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD for joinedDate

  const result = await db.transaction(async (tx) => {
    const updates = await tx
      .update(bizAccountsTable)
      .set({ status: "approved", onboardingPaidAt: acct.onboardingPaidAt ?? new Date() })
      .where(and(eq(bizAccountsTable.id, acctId), eq(bizAccountsTable.status, "accepted")))
      .returning();
    if (updates.length === 0) return null;
    const [updated] = updates;

    const [business] = await tx
      .insert(businessesTable)
      .values({
        id: businessId,
        ownerId: acct.ownerId!,
        name: acct.businessName,
        description: acct.businessDescription ?? "",
        categoryId,
        phone: acct.phone ?? "",
        location: "",
        joinedDate: today,
        // subscriptionPlan defaults to 'starter_gigger'; subscriptionActive
        // defaults true so the new SP can immediately list up to the tier cap.
      })
      .returning();

    return { bizAccount: updated, business };
  });

  if (!result) return { ok: false, reason: "race_lost" };
  return { ok: true, bizAccount: result.bizAccount, business: result.business };
}
