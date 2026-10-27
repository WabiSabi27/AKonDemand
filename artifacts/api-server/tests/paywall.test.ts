/**
 * TD-4 — guard for the named regression in ROADMAP.md ("the paywall race").
 *
 * Verifies that POST /services blocks SPs whose subscription is not active,
 * and allows SPs whose subscription IS active. The route does the gate twice
 * (outer check + a transactional re-check with `FOR UPDATE`); the outer
 * check is what we exercise here. The inner check is what the regression
 * mitigation is about — covered indirectly: if the outer were the only
 * guard, this test would still pass even after a regression of the inner
 * row-lock. To cover the inner explicitly we'd need two concurrent inserts
 * which vitest's singleFork pool can't realistically arrange against the
 * shared DB; documented in `docs/testing.md`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  api,
  createCustomerUser,
  createBusinessForOwner,
  mintToken,
  getAnyCategoryId,
} from "./helpers";

interface BizCtx {
  ownerId: string;
  businessId: string;
  token: string;
}

async function createBizOwner(subscriptionActive: boolean): Promise<BizCtx> {
  // Re-use createCustomerUser to insert a usersTable row, then flip role to
  // business via direct insert of the business; the JWT carries role+businessId.
  const owner = await createCustomerUser();
  const biz = await createBusinessForOwner({
    ownerId: owner.id,
    subscriptionActive,
    subscriptionPlan: "basic",
  });
  return {
    ownerId: owner.id,
    businessId: biz.id,
    token: mintToken({ userId: owner.id, role: "business", businessId: biz.id }),
  };
}

describe("POST /services — subscription paywall", () => {
  let categoryId: string;

  beforeAll(async () => {
    categoryId = await getAnyCategoryId();
  });

  const validBody = () => ({
    categoryId,
    title: "Paywall test service",
    description: "",
    options: [
      {
        name: "Standard",
        description: "",
        price: "100.00",
        duration: "1h",
      },
    ],
  });

  it("returns 402 with reason=subscription_inactive for an unsubscribed SP", async () => {
    const ctx = await createBizOwner(false);
    const res = await api()
      .post("/api/services")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send(validBody());
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("subscription_inactive");
    expect(res.body.upgradeRequired).toBe(true);
  });

  it("creates the service for a subscribed SP", async () => {
    const ctx = await createBizOwner(true);
    const res = await api()
      .post("/api/services")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^svc_/);
    expect(res.body.businessId).toBe(ctx.businessId);
    // Cleanup: drop the service so afterAll's business cascade succeeds.
    // (services FK businesses ON DELETE NO ACTION/RESTRICT in some envs.)
    // Not strictly required for correctness — the prefix-cleanup at the
    // end of the suite will fail loudly if we leak.
  });

  it("rejects requests from a customer-role token", async () => {
    const customer = await createCustomerUser();
    const res = await api()
      .post("/api/services")
      .set("Authorization", `Bearer ${customer.token}`)
      .send(validBody());
    expect(res.status).toBe(403);
  });

  it("rejects requests with no token at all", async () => {
    const res = await api().post("/api/services").send(validBody());
    expect(res.status).toBe(401);
  });
});
