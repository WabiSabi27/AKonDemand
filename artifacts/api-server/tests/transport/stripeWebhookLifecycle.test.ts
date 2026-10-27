import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { configureStripeWebhook, type WebhookStore } from "../../src/lib/stripeWebhookLifecycle";

const url = "https://current-preview.example/api/stripe/webhook";
const secret = "whsec_synthetic";
const endpoint = (id = "we_current", callback = url, extra = {}) => ({
  id, url: callback, status: "enabled", livemode: false,
  metadata: { managed_by: "akodd-development" }, ...extra,
}) as Stripe.WebhookEndpoint;

function fixture(production = false, allowPreviewCreation = false) {
  const webhookEndpoints = {
    retrieve: vi.fn().mockResolvedValue(endpoint()),
    list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    create: vi.fn().mockResolvedValue(endpoint("we_new", url, { secret })),
    update: vi.fn(() => { throw new Error("Updates forbidden"); }),
    del: vi.fn(() => { throw new Error("Deletes forbidden"); }),
  };
  const store = {
    getAccountId: vi.fn().mockResolvedValue("acct_original"),
    getManagedWebhookByUrl: vi.fn().mockResolvedValue(null),
    getSupportedEventTypes: vi.fn().mockReturnValue(["checkout.session.completed"]),
    upsertManagedWebhooks: vi.fn().mockResolvedValue([]),
    postgresClient: {
      withAdvisoryLock: vi.fn(async <T>(_key: string, run: () => Promise<T>) => run()),
      delete: vi.fn().mockResolvedValue(true),
    },
    findOrCreateManagedWebhook: vi.fn(() => { throw new Error("Unsafe library cleanup forbidden"); }),
  };
  const run = () => configureStripeWebhook({
    stripe: { webhookEndpoints } as unknown as Pick<Stripe, "webhookEndpoints">,
    store: store as WebhookStore, url, production, allowPreviewCreation,
  });
  return { webhookEndpoints, store, run };
}

describe("non-destructive shared-account webhook lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts a new preview without consuming any slot or invoking library cleanup", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: "unavailable", reason: expect.stringContaining("reuse-only") });
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.list).not.toHaveBeenCalled();
    expect(f.store.findOrCreateManagedWebhook).not.toHaveBeenCalled();
    expect(f.store.upsertManagedWebhooks).not.toHaveBeenCalled();
    expect(f.store.postgresClient.delete).not.toHaveBeenCalled();
  });

  it("reuses a current endpoint even with a full account and no creation opt-in", async () => {
    const f = fixture();
    f.store.getManagedWebhookByUrl.mockResolvedValue({ id: "we_current", url, secret });
    expect(await f.run()).toEqual({ status: "ready", webhookId: "we_current" });
    expect(f.webhookEndpoints.retrieve).toHaveBeenCalledWith("we_current");
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.list).not.toHaveBeenCalled();
  });

  it("protects production, legacy-managed, unknown and active preview endpoints at capacity", async () => {
    const f = fixture(false, true);
    const inventory = Array.from({ length: 16 }, (_, i) => endpoint(`we_${i}`,
      `https://preview-${i}.example/api/stripe/webhook`));
    inventory[0] = endpoint("we_prod", "https://production.example/api/stripe/webhook", {
      metadata: { managed_by: "akodd-production" }, description: "stripe-sync",
    });
    inventory[1] = endpoint("we_legacy", "https://legacy.example/api/stripe/webhook", {
      metadata: { managed_by: "stripe-sync" },
    });
    inventory[2] = endpoint("we_unknown", "https://unknown.example/api/stripe/webhook", { metadata: {} });
    const before = structuredClone(inventory);
    f.webhookEndpoints.list.mockResolvedValue({ data: inventory, has_more: false });
    expect(await f.run()).toMatchObject({ status: "unavailable", reason: expect.stringContaining("capacity is full") });
    expect(inventory).toEqual(before);
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
    expect(f.store.findOrCreateManagedWebhook).not.toHaveBeenCalled();
  });

  it("survives a quota race without deleting anything or retrying creation", async () => {
    const f = fixture(false, true);
    f.webhookEndpoints.create.mockRejectedValue({
      type: "StripeInvalidRequestError",
      message: "You have reached the maximum of 16 test mode webhook endpoints.",
    });
    expect(await f.run()).toMatchObject({ status: "unavailable", reason: expect.stringContaining("capacity is full") });
    expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(1);
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.store.upsertManagedWebhooks).not.toHaveBeenCalled();
  });

  it("production fails closed at capacity even with preview creation disabled", async () => {
    const f = fixture(true);
    f.webhookEndpoints.list.mockResolvedValue({
      data: Array.from({ length: 16 }, (_, i) => endpoint(`we_${i}`, `https://other-${i}.example/webhook`)),
      has_more: false,
    });
    await expect(f.run()).rejects.toThrow("Stripe webhook unavailable: sandbox webhook capacity is full");
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("creates with safe ownership metadata from the start (production=%s)", async production => {
    const f = fixture(production, true);
    expect(await f.run()).toEqual({ status: "ready", webhookId: "we_new" });
    expect(f.webhookEndpoints.create).toHaveBeenCalledWith({
      url, enabled_events: ["checkout.session.completed"],
      description: "AK On Demand callback",
      metadata: { managed_by: production ? "akodd-production" : "akodd-development" },
    }, { idempotencyKey: `akodd-webhook:acct_original:${url}` });
    expect(f.store.upsertManagedWebhooks).toHaveBeenCalledWith([
      expect.objectContaining({ id: "we_new", secret }),
    ], "acct_original");
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
    expect(f.store.postgresClient.withAdvisoryLock).toHaveBeenCalledWith(
      `webhook:acct_original:${url}`, expect.any(Function));
  });

  it.each([
    { localUrl: "https://production.example/api/stripe/webhook", remote: endpoint() },
    { localUrl: url, remote: endpoint("we_current", "https://production.example/api/stripe/webhook") },
    { localUrl: url, remote: endpoint("we_current", url, { status: "disabled" }) },
    { localUrl: url, remote: endpoint("we_current", url, { livemode: true }) },
  ])("does not repoint/delete/recreate a mismatched or disabled endpoint %#", async ({ localUrl, remote }) => {
    const f = fixture(false, true);
    f.store.getManagedWebhookByUrl.mockResolvedValue({ id: "we_current", url: localUrl, secret });
    f.webhookEndpoints.retrieve.mockResolvedValue(remote);
    expect(await f.run()).toMatchObject({ status: "unavailable" });
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
  });

  it("does not adopt or duplicate a remote callback whose secret is missing from the fork", async () => {
    const f = fixture(false, true);
    f.webhookEndpoints.list.mockResolvedValue({ data: [endpoint()], has_more: false });
    expect(await f.run()).toMatchObject({ reason: expect.stringContaining("signing secret") });
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
  });

  it("keeps stale local rows intact when their remote endpoint no longer exists", async () => {
    const f = fixture();
    f.store.getManagedWebhookByUrl.mockResolvedValue({ id: "we_old", url, secret });
    f.webhookEndpoints.retrieve.mockRejectedValue({ statusCode: 404, code: "resource_missing" });
    expect(await f.run()).toMatchObject({ status: "unavailable" });
    expect(f.store.upsertManagedWebhooks).not.toHaveBeenCalled();
    expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
    expect(f.store.postgresClient.delete).not.toHaveBeenCalled();
  });

  it("does not create on incomplete endpoint inventory", async () => {
    const f = fixture(false, true);
    f.webhookEndpoints.list.mockResolvedValue({ data: [], has_more: true });
    expect(await f.run()).toMatchObject({ reason: expect.stringContaining("inventory is incomplete") });
    expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
  });

  it("propagates non-quota Stripe and persistence errors rather than hiding them", async () => {
    const f = fixture(false, true);
    f.webhookEndpoints.create.mockRejectedValueOnce(new Error("Stripe unavailable"));
    await expect(f.run()).rejects.toThrow("Stripe unavailable");
    f.store.upsertManagedWebhooks.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(f.run()).rejects.toThrow("Storage unavailable");
  });

  it("requires a locally saved signing secret before considering a callback ready", async () => {
    const f = fixture();
    f.store.getManagedWebhookByUrl.mockResolvedValue({ id: "we_current", url });
    expect(await f.run()).toMatchObject({ reason: expect.stringContaining("signing secret") });
    expect(f.webhookEndpoints.retrieve).not.toHaveBeenCalled();
  });
});
