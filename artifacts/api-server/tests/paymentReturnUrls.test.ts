import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, bizAccountsTable } from "@workspace/db";
import { api, TEST_PREFIX } from "./helpers";
import * as stripeClient from "../src/stripeClient";
import * as ids from "../src/lib/ids";
import { APPLICATION_FEE_CENTS } from "../src/lib/plans";

const stripe = {
  prices: { search: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
};

beforeEach(() => {
  // The shared setup imports the app first; replace its loaded Stripe boundary.
  vi.spyOn(stripeClient, "getUncachableStripeClient").mockResolvedValue(
    stripe as unknown as Awaited<ReturnType<typeof stripeClient.getUncachableStripeClient>>,
  );
  vi.spyOn(ids, "genId").mockImplementation(prefix =>
    `${TEST_PREFIX}_${prefix}_${Math.random().toString(36).slice(2)}`,
  );
  stripe.prices.search.mockReset().mockResolvedValue({ data: [] });
  stripe.checkout.sessions.create.mockReset().mockResolvedValue({
    id: "cs_synthetic_return_test", url: "https://checkout.example.test/synthetic",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${TEST_PREFIX}%`));
});

it.each([
  { env: "production", expo: "", domains: "published.example.test", base: "https://published.example.test" },
  { env: "production", expo: "expo.example.test", domains: " published.example.test ,other.example.test", base: "https://published.example.test" },
  { env: "development", expo: " expo.example.test ", domains: "proxy.example.test", base: "https://expo.example.test" },
  { env: "development", expo: "", domains: "proxy.example.test", base: "https://proxy.example.test/mobile" },
  { env: "development", expo: "", domains: "", base: "http://localhost/mobile" },
])("returns both checkout stages to $base ($env, expo=$expo)", async ({ env, expo, domains, base }) => {
  vi.stubEnv("NODE_ENV", env);
  vi.stubEnv("REPLIT_EXPO_DEV_DOMAIN", expo);
  vi.stubEnv("REPLIT_DOMAINS", domains);

  const application = await api().post("/api/biz-accounts").send({
    businessName: "Return Route Test", ownerName: "Test Applicant",
    email: `${TEST_PREFIX}_${Math.random().toString(36).slice(2)}@test.local`,
    password: "synthetic-password", businessType: "home-based",
    expectedApplicationFeeCents: APPLICATION_FEE_CENTS,
  });
  expect(application.status).toBe(201);
  const id = application.body.bizAccount.id;
  expect(id).toBeTruthy();

  const expected = {
    success_url: `${base}/payment-return?success=true&id=${id}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/payment-return?cancelled=true&id=${id}`,
  };
  expect(stripe.checkout.sessions.create).toHaveBeenNthCalledWith(1, expect.objectContaining(expected));

  // Move only this synthetic dev/CI application to the onboarding stage.
  await db.update(bizAccountsTable).set({ status: "accepted" }).where(eq(bizAccountsTable.id, id));
  const onboarding = await api().post(`/api/biz-accounts/${id}/onboarding-checkout`);
  expect(onboarding.status).toBe(200);
  expect(stripe.checkout.sessions.create).toHaveBeenNthCalledWith(
    2, expect.objectContaining({
      ...expected,
      success_url: `${expected.success_url}&phase=onboarding`,
    }),
    expect.objectContaining({
      idempotencyKey: `onboarding:${id}:initial:200`,
      maxNetworkRetries: 0,
      timeout: expect.any(Number),
    }),
  );
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
});
