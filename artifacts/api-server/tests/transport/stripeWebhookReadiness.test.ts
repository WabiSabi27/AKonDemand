import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("starts unknown rather than inferring webhook availability from API health", async () => {
  const { getWebhookReadiness } = await import("../../src/lib/stripeWebhookReadiness");
  expect(getWebhookReadiness()).toMatchObject({ status: "checking", environment: "preview" });
});

it("reports checking until registration completes, then exposes only safe ready fields", async () => {
  const { getWebhookReadiness, trackWebhookRegistration } = await import("../../src/lib/stripeWebhookReadiness");
  let finish!: (result: { status: "ready"; webhookId: string }) => void;
  const registration = trackWebhookRegistration(() => new Promise(resolve => { finish = resolve; }));
  expect(getWebhookReadiness().status).toBe("checking");
  finish({ status: "ready", webhookId: "we_private_identifier" });
  await registration;
  expect(getWebhookReadiness()).toEqual({
    status: "ready", environment: "preview",
    reason: "This server verified an enabled payment callback at startup.",
  });
});

it("explains reuse-only previews safely without leaking unrecognized reasons", async () => {
  const { getWebhookReadiness, trackWebhookRegistration } = await import("../../src/lib/stripeWebhookReadiness");
  await trackWebhookRegistration(async () => ({
    status: "unavailable",
    reason: "preview registration is reuse-only; automatic payment callbacks are not configured",
  }));
  expect(getWebhookReadiness().reason).toBe(
    "This preview has no verified payment callback. Automatic payment updates are unavailable here.",
  );
  for (const reason of ["whsec_private https://private.example", "constructor", "__proto__"]) {
    await trackWebhookRegistration(async () => ({ status: "unavailable", reason }));
    expect(getWebhookReadiness()).toEqual({
      status: "unavailable", environment: "preview",
      reason: "Automatic payment updates are unavailable on this server.",
    });
  }
});

it("preserves production startup failures without exposing the original diagnostic", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { getWebhookReadiness, trackWebhookRegistration } = await import("../../src/lib/stripeWebhookReadiness");
  const failure = new Error("whsec_private callback configuration failed");
  await expect(trackWebhookRegistration(async () => { throw failure; })).rejects.toBe(failure);
  expect(getWebhookReadiness()).toEqual({
    status: "unavailable", environment: "production",
    reason: "Payment callback startup verification failed. Check the server configuration.",
  });
});

it.each([
  "local callback or signing secret is not usable",
  "existing endpoint does not match this callback or is disabled",
  "endpoint inventory is incomplete; registration was not attempted",
  "callback already exists but its signing secret is not available locally",
  "sandbox webhook capacity is full; no existing endpoints were changed",
])("sanitizes the known unavailable reason: %s", async reason => {
  const { getWebhookReadiness, trackWebhookRegistration } = await import("../../src/lib/stripeWebhookReadiness");
  await trackWebhookRegistration(async () => ({ status: "unavailable", reason }));
  expect(getWebhookReadiness()).toMatchObject({ status: "unavailable", environment: "preview" });
  expect(getWebhookReadiness().reason).not.toBe(reason);
  expect(getWebhookReadiness().reason).not.toMatch(/secret|whsec_|https:|we_/);
});
