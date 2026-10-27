import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProductionTestCredentials } from "../src/lib/stripeTestCredentials";

describe("Published Stripe sandbox credentials", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "sk_test_synthetic");
    vi.stubEnv("STRIPE_TEST_PUBLISHABLE_KEY", "pk_test_synthetic");
    vi.stubEnv("STRIPE_TEST_ACCOUNT_ID", "acct_original");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("verifies the original account and reads keys afresh", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ id: "acct_original" }), { status: 200 }));
    expect(await getProductionTestCredentials()).toEqual({
      secretKey: "sk_test_synthetic", publishableKey: "pk_test_synthetic",
    });
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "sk_test_rotated");
    expect((await getProductionTestCredentials()).secretKey).toBe("sk_test_rotated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["STRIPE_TEST_SECRET_KEY", "STRIPE_TEST_PUBLISHABLE_KEY"])(
    "fails without %s rather than falling back to the live connector", async (key) => {
      vi.stubEnv(key, "");
      await expect(getProductionTestCredentials()).rejects.toThrow("missing from production secrets");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sk_live_synthetic", "pk_test_synthetic"],
    ["sk_test_synthetic", "pk_live_synthetic"],
    ["invalid", "pk_test_synthetic"],
  ])("rejects live or malformed key pairs", async (secret, publishable) => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", secret);
    vi.stubEnv("STRIPE_TEST_PUBLISHABLE_KEY", publishable);
    await expect(getProductionTestCredentials()).rejects.toThrow("live keys are forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a pinned original account identity", async () => {
    vi.stubEnv("STRIPE_TEST_ACCOUNT_ID", "");
    await expect(getProductionTestCredentials()).rejects.toThrow("identity is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects valid test keys belonging to another account", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "acct_other" }), { status: 200 }));
    await expect(getProductionTestCredentials()).rejects.toThrow("do not match the original sandbox");
  });

  it("does not expose error bodies, credentials, or network exceptions", async () => {
    fetchMock.mockResolvedValueOnce(new Response("private-placeholder", { status: 401 }));
    await expect(getProductionTestCredentials()).rejects.toThrow(
      "Stripe test account verification failed: HTTP 401");
    fetchMock.mockRejectedValueOnce(new Error("private-placeholder"));
    await expect(getProductionTestCredentials()).rejects.toThrow(
      "Stripe test account verification is unavailable");
  });

  it.each(["not-json", "null", "{}"])("rejects invalid account responses", async (body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    await expect(getProductionTestCredentials()).rejects.toThrow(/invalid response|do not match/);
  });
});
