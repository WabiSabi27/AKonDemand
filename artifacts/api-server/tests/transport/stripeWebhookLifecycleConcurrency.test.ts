import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gate, registrationFixture, syntheticEndpoint } from "./fixtures/stripeWebhookRegistration";

const callback = "https://synthetic-preview-a.example/api/stripe/webhook";
const otherCallback = "https://synthetic-preview-b.example/api/stripe/webhook";

describe("shared-account webhook registration concurrency", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("serializes the same callback through secret persistence, then reuses one created endpoint", async () => {
    const saving = gate();
    const release = gate();
    const f = registrationFixture({
      beforeSave: async () => { saving.open(); await release.promise; },
    });
    const first = f.starter(callback);
    const second = f.starter(callback);
    expect(first.store).not.toBe(second.store);
    const firstRun = first.run();
    const runs = [firstRun];
    try {
      await saving.promise;
      runs.push(second.run());
      await f.waitForRequests(2);
      const key = `webhook:${f.accountId}:${callback}`;
      expect(f.lockRequests).toEqual([key, key]);
      expect(f.lockEntries).toEqual([key]);
      expect(f.localReads).toEqual([{ url: callback, value: null }]);
      expect(f.saved.size).toBe(0);
      expect(f.remote.size).toBe(1);
      expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(1);
      expect(f.webhookEndpoints.retrieve).not.toHaveBeenCalled();

      release.open();
      expect(await Promise.all(runs)).toEqual([
        { status: "ready", webhookId: "we_synthetic_1" },
        { status: "ready", webhookId: "we_synthetic_1" },
      ]);
      expect(f.lockEntries).toEqual([key, key]);
      expect(f.localReads[1]).toEqual({
        url: callback, value: { id: "we_synthetic_1", url: callback, secret: "whsec_synthetic_1" },
      });
      expect(f.remote.get("we_synthetic_1")).not.toHaveProperty("secret");
      expect(f.saved.size).toBe(1);
      expect(f.webhookEndpoints.retrieve).toHaveBeenCalledExactlyOnceWith("we_synthetic_1");
      expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(1);
      expect(f.persist).toHaveBeenCalledTimes(1);
      expect(f.deleteLocal).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
    } finally {
      release.open();
      await Promise.allSettled(runs);
    }
  });

  it("allows different callbacks to proceed independently and deletes only their own proven-stale cache rows", async () => {
    const saving = gate();
    const release = gate();
    const f = registrationFixture({
      beforeSave: async webhook => {
        if (webhook.url === callback) { saving.open(); await release.promise; }
      },
    });
    const protectedUrl = "https://synthetic-production.example/api/stripe/webhook";
    const protectedEndpoint = syntheticEndpoint("we_synthetic_protected", protectedUrl, {
      livemode: true, metadata: { managed_by: "akodd-production" },
    });
    const protectedLocal = { id: protectedEndpoint.id, url: protectedUrl, secret: "whsec_synthetic_protected" };
    f.remote.set(protectedEndpoint.id, structuredClone(protectedEndpoint));
    f.saved.set(protectedUrl, { ...protectedLocal });
    f.saved.set(callback, { id: "we_stale_a", url: callback, secret: "whsec_synthetic_old_a" });
    f.saved.set(otherCallback, { id: "we_stale_b", url: otherCallback, secret: "whsec_synthetic_old_b" });

    const first = f.starter(callback).run();
    const runs = [first];
    try {
      await saving.promise;
      const second = f.starter(otherCallback).run();
      runs.push(second);
      // Must complete while the first callback's save (and lock) remains held.
      expect(await second).toEqual({ status: "ready", webhookId: "we_synthetic_2" });
      expect(f.lockEntries).toEqual([
        `webhook:${f.accountId}:${callback}`, `webhook:${f.accountId}:${otherCallback}`,
      ]);
      expect(f.saved.has(callback)).toBe(false);
      expect(f.saved.get(otherCallback)).toEqual({
        id: "we_synthetic_2", url: otherCallback, secret: "whsec_synthetic_2",
      });
      expect(f.remote.get("we_synthetic_1")?.url).toBe(callback);
      expect(f.remote.get(protectedEndpoint.id)).toEqual(protectedEndpoint);
      expect(f.saved.get(protectedUrl)).toEqual(protectedLocal);
      expect(f.deleteLocal.mock.calls).toEqual([
        ["_managed_webhooks", "we_stale_a"], ["_managed_webhooks", "we_stale_b"],
      ]);

      release.open();
      expect(await first).toEqual({ status: "ready", webhookId: "we_synthetic_1" });
      expect(f.saved.get(callback)).toEqual({
        id: "we_synthetic_1", url: callback, secret: "whsec_synthetic_1",
      });
      expect(f.remote.size).toBe(3);
      expect(f.saved.size).toBe(3);
      expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(2);
      expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
    } finally {
      release.open();
      await Promise.allSettled(runs);
    }
  });

  it.each([
    { boundary: "before the secret commits", committed: false },
    { boundary: "after commit but before acknowledgement", committed: true },
  ])("releases a failed save $boundary without silently creating another endpoint", async ({ committed }) => {
    const saving = gate();
    const release = gate();
    const failure = new Error("Synthetic persistence acknowledgement failure");
    const failSave = async () => { saving.open(); await release.promise; throw failure; };
    const f = registrationFixture(committed ? { afterSave: failSave } : { beforeSave: failSave });
    const first = f.starter(callback).run();
    // Attach the failure assertion before opening the controlled failure gate.
    const failed = expect(first).rejects.toBe(failure);
    const runs: Promise<unknown>[] = [first];
    try {
      await saving.promise;
      const second = f.starter(callback).run();
      runs.push(second);
      await f.waitForRequests(2);
      expect(f.lockEntries).toHaveLength(1);
      expect(f.localReads).toHaveLength(1);
      expect(f.saved.size).toBe(committed ? 1 : 0);
      release.open();
      await failed;
      const expected = committed
        ? { status: "ready", webhookId: "we_synthetic_1" }
        : {
          status: "unavailable",
          reason: "callback already exists but its signing secret is not available locally",
        };
      expect(await second).toEqual(expected);
      // A subsequent independent startup must also avoid duplicate creation.
      expect(await f.starter(callback).run()).toEqual(expected);
      expect(f.lockEntries).toHaveLength(3);
      expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(1);
      expect(f.persist).toHaveBeenCalledTimes(1);
      expect(f.remote.size).toBe(1);
      expect(f.saved.size).toBe(committed ? 1 : 0);
      expect(f.deleteLocal).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
    } finally {
      release.open();
      await Promise.allSettled([...runs, failed]);
    }
  });
});
