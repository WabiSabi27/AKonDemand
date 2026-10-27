import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { api, TEST_PREFIX } from "./helpers";
import { APPLICATION_FEE_CENTS, ONBOARDING_FEE_CENTS } from "../src/lib/plans";
import * as stripeClient from "../src/stripeClient";
import * as ids from "../src/lib/ids";
import { db, bizAccountsTable } from "@workspace/db";
import { like } from "drizzle-orm";

const stripe = vi.hoisted(() => ({
  prices: { search: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
}));
beforeEach(() => {
  // setup.ts has already imported app.ts; spy on those loaded boundaries.
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue(
    stripe as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>,
  );
  vi.spyOn(ids, "genId").mockImplementation(prefix =>
    `${TEST_PREFIX}_${prefix}_${Math.random().toString(36).slice(2)}`,
  );
  stripe.prices.search.mockReset().mockResolvedValue({ data: [] });
  stripe.checkout.sessions.create.mockReset().mockResolvedValue({
    id: "cs_synthetic_fee_test", url: "https://checkout.example.test/application",
  });
});

afterAll(async () => {
  await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${TEST_PREFIX}%`));
  vi.restoreAllMocks();
});

function application(expectedApplicationFeeCents: number) {
  return {
    businessName: "Test Fee Business", ownerName: "Test Applicant",
    email: `${TEST_PREFIX}_${Math.random().toString(36).slice(2)}@test.local`,
    password: "synthetic-password", businessType: "home-based",
    expectedApplicationFeeCents,
  };
}

it("exposes the unchanged beta fees publicly as integer USD cents", async () => {
  const res = await api().get("/api/application-fees");
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).toEqual({
    applicationFeeCents: APPLICATION_FEE_CENTS,
    onboardingFeeCents: ONBOARDING_FEE_CENTS, currency: "usd",
  });
  expect(res.body.applicationFeeCents).toBe(100);
  expect(res.body.onboardingFeeCents).toBe(200);
});

it.each(["matching", "missing", "wrong amount", "wrong currency", "recurring", "search failed"])(
  "charges the public configured fee with a %s catalog price",
  async scenario => {
    const { body: fees } = await api().get("/api/application-fees");
    const price = {
      id: "price_synthetic_test", unit_amount: fees.applicationFeeCents,
      currency: "usd", type: "one_time",
    };
    if (scenario === "wrong amount") price.unit_amount = 7900;
    if (scenario === "wrong currency") price.currency = "cad";
    if (scenario === "recurring") price.type = "recurring";
    stripe.prices.search.mockResolvedValue({ data: scenario === "missing" ? [] : [price] });
    if (scenario === "search failed") stripe.prices.search.mockRejectedValue(new Error("Synthetic lookup failure"));
    const res = await api().post("/api/biz-accounts").send(application(fees.applicationFeeCents));
    expect(res.status).toBe(201);
    const checkout = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(checkout.mode).toBe("payment");
    const item = checkout.line_items[0];
    expect(item.quantity).toBe(1);
    if (scenario === "matching") {
      expect(item.price).toBe(price.id);
      expect(price.unit_amount).toBe(fees.applicationFeeCents);
    } else {
      expect(item.price_data.unit_amount).toBe(fees.applicationFeeCents);
      expect(item.price_data.currency).toBe(fees.currency);
    }
  },
);

it("rejects stale display prices before creating an application or checkout", async () => {
  const body = application(7900);
  const rejected = await api().post("/api/biz-accounts").send(body);
  expect(rejected.status).toBe(409);
  expect(rejected.body.error).toContain("fee has changed");
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  // Same email can retry: no stranded account was inserted.
  const retry = await api().post("/api/biz-accounts").send({
    ...body, expectedApplicationFeeCents: APPLICATION_FEE_CENTS,
  });
  expect(retry.status).toBe(201);
});
